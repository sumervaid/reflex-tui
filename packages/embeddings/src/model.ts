import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, replaceOwnedFile } from "@reflex/safety";

export type ModelFile = { name: string; url: string; bytes: number; sha256: string };

/** A pinned embedding model: where its files come from and how to run and compare its vectors. */
export type ModelSpec = {
  /** Directory name under the models folder, and part of every cached vector's key. */
  id: string;
  /** What users type: `reflex model fetch --model <name>`. */
  name: string;
  label: string;
  dimensions: number;
  /** Input limit used for each text, in tokens. */
  maxTokens: number;
  /** How token states become one sentence vector. */
  pooling: "mean" | "cls";
  /** `wordpiece`: our own tokenizer over vocab.txt. `huggingface`: tokenizer.json via @huggingface/tokenizers. */
  tokenizer: "wordpiece" | "huggingface";
  /** Scripts the vocabulary covers. Text mostly in other scripts is compared by words only. */
  reads: "latin" | "all";
  /**
   * Cosine (of vectors centered on the model's reference mean) at or below which two sessions
   * count as unrelated in meaning; see rescaleEmbedding in @reflex/analysis.
   */
  floor: number;
  /** Peak memory of the process while embedding (measured; same for any input length or thread count). */
  peakMemoryMB: number;
  /** Seconds to embed one session on one thread (measured on real-length sessions), for time estimates. */
  secondsPerSession: number;
  files: ModelFile[];
};

const hf = (repo: string, revision: string) => (path: string) => `https://huggingface.co/${repo}/resolve/${revision}/${path}`;

const minilmUrl = hf("Xenova/all-MiniLM-L6-v2", "751bff37182d3f1213fa05d7196b954e230abad9");
const bgeUrl = hf("Xenova/bge-m3", "4de13258303883538bd53b696b452bf8099f0858");

/**
 * all-MiniLM-L6-v2, int8: small and fast, and the best of the models compared at matching English
 * requests, but it cannot read non-Latin scripts. The light option.
 */
export const MINILM: ModelSpec = {
  id: "all-minilm-l6-v2-q8",
  name: "minilm",
  label: "all-MiniLM-L6-v2 (int8, English)",
  dimensions: 384,
  maxTokens: 256,
  pooling: "mean",
  tokenizer: "wordpiece",
  reads: "latin",
  floor: 0.05,
  peakMemoryMB: 650,
  secondsPerSession: 0.085,
  files: [
    {
      name: "model_quantized.onnx",
      url: minilmUrl("onnx/model_quantized.onnx"),
      bytes: 22_972_370,
      sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    },
    { name: "vocab.txt", url: minilmUrl("vocab.txt"), bytes: 231_508, sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3" },
  ],
};

/**
 * BAAI bge-m3, int8: reads 100+ languages and requests that mix them, and matches a request to the
 * same task asked in another language. Larger and slower than MiniLM. The default.
 */
export const BGE_M3: ModelSpec = {
  id: "bge-m3-q8",
  name: "bge-m3",
  label: "bge-m3 (int8, multilingual)",
  dimensions: 1024,
  // Covers everything the adapters keep of a request (2,000 characters) in any language.
  maxTokens: 1024,
  pooling: "cls",
  tokenizer: "huggingface",
  reads: "all",
  // Swept 0-0.25 with merge limits 0.30-0.45 on the English and English+Korean sets: 0.05 with the
  // default merge limit (0.35) was best on both (cluster F1 0.707 / 0.747); 0.10 close; 0.20 fell to 0.51.
  floor: 0.05,
  peakMemoryMB: 2800,
  secondsPerSession: 2.85,
  files: [
    {
      name: "model_quantized.onnx",
      url: bgeUrl("onnx/model_quantized.onnx"),
      bytes: 569_694_530,
      sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d",
    },
    {
      name: "tokenizer.json",
      url: bgeUrl("tokenizer.json"),
      bytes: 17_082_821,
      sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790",
    },
    {
      name: "tokenizer_config.json",
      url: bgeUrl("tokenizer_config.json"),
      bytes: 1_173,
      sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4",
    },
  ],
};

export const MODELS: readonly ModelSpec[] = [BGE_M3, MINILM];
export const DEFAULT_MODEL = BGE_M3;

export function modelByName(name: string): ModelSpec {
  const m = MODELS.find((x) => x.name === name || x.id === name);
  if (!m) throw new Error(`Unknown model "${name}". Choose one of: ${MODELS.map((x) => x.name).join(", ")}.`);
  return m;
}

export const modelBytes = (model: ModelSpec): number => model.files.reduce((n, f) => n + f.bytes, 0);

/**
 * Whether a model can read a text. A Latin-only vocabulary takes other scripts apart into single
 * letters (Korean into jamo), and any two such texts then look alike whatever they say (two
 * unrelated Korean requests average a cosine of 0.40 with MiniLM, two English ones 0.13). Such text
 * is compared by words only. Mostly-Latin text with a few other letters is still read.
 */
export function modelReads(text: string, model: ModelSpec): boolean {
  if (model.reads === "all") return true;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return true;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin / letters >= 0.7;
}

export function modelDir(modelsRoot: string, model: ModelSpec): string {
  return join(modelsRoot, model.id);
}

const ACTIVE_FILE = "active";

/**
 * The model scans use: the one last fetched or chosen (recorded in the models folder), else
 * whichever is installed, the default first. Undefined when none is installed.
 */
export async function activeModel(modelsRoot: string): Promise<ModelSpec | undefined> {
  const chosen = await readFile(join(modelsRoot, ACTIVE_FILE), "utf8").then(
    (s) => MODELS.find((m) => m.id === s.trim()),
    () => undefined,
  );
  if (chosen && (await modelStatus(modelsRoot, chosen)).installed) return chosen;
  for (const m of MODELS) if ((await modelStatus(modelsRoot, m)).installed) return m;
  return undefined;
}

export async function setActiveModel(modelsRoot: string, model: ModelSpec): Promise<void> {
  await ensureDir(modelsRoot);
  await replaceOwnedFile(join(modelsRoot, ACTIVE_FILE), `${model.id}\n`, 0o600);
}

export type ModelStatus = { model: ModelSpec; installed: true; dir: string } | { model: ModelSpec; installed: false; dir: string; missing: string[] };

/** Cheap presence check (sizes only). Hashes are verified on download and again on load. */
export async function modelStatus(modelsRoot: string, model: ModelSpec): Promise<ModelStatus> {
  const dir = modelDir(modelsRoot, model);
  const missing: string[] = [];
  for (const f of model.files) {
    const size = await stat(join(dir, f.name)).then(
      (s) => s.size,
      () => -1,
    );
    if (size !== f.bytes) missing.push(f.name);
  }
  return missing.length ? { model, installed: false, dir, missing } : { model, installed: true, dir };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Read a model file and refuse it unless it is byte-for-byte the pinned file. */
export async function readVerified(dir: string, name: string, model: ModelSpec): Promise<Buffer> {
  const spec = model.files.find((f) => f.name === name);
  if (!spec) throw new Error(`Unknown model file ${name}`);
  const data = await readFile(join(dir, name));
  if (data.length !== spec.bytes || sha256Hex(data) !== spec.sha256) {
    throw new Error(`Model file ${name} does not match the pinned version. Run \`reflex model fetch\` again.`);
  }
  return data;
}

/** Full check: every file present and byte-for-byte the pinned version. */
export async function modelVerified(modelsRoot: string, model: ModelSpec): Promise<boolean> {
  const dir = modelDir(modelsRoot, model);
  for (const f of model.files) {
    try {
      await readVerified(dir, f.name, model);
    } catch {
      return false;
    }
  }
  return true;
}

export type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  /** Streamed when present, so a large file never has to fit in memory. */
  body?: AsyncIterable<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Write one download to a temporary file while hashing it; keep it only if size and hash match. */
async function download(fetcher: Fetcher, f: ModelFile, path: string, onBytes?: (bytes: number) => void): Promise<void> {
  const res = await fetcher(f.url);
  if (!res.ok) throw new Error(`Download of ${f.name} failed (HTTP ${res.status}).`);
  const tmp = `${path}.${randomBytes(6).toString("hex")}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  const handle = await open(tmp, "wx", 0o600);
  try {
    const chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array> = res.body ?? [new Uint8Array(await res.arrayBuffer())];
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > f.bytes) throw new Error(`Downloaded ${f.name} is larger than the pinned file; nothing was kept.`);
      hash.update(chunk);
      await handle.write(chunk);
      onBytes?.(bytes);
    }
    await handle.close();
    if (bytes !== f.bytes || hash.digest("hex") !== f.sha256) throw new Error(`Downloaded ${f.name} does not match the pinned checksum; nothing was kept.`);
    await rename(tmp, path);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Download a model's pinned files into `modelsRoot`. Each file is streamed to a temporary file,
 * verified, then moved into place, so a failed or tampered download never leaves a usable-looking
 * model and a large file never has to fit in memory.
 */
export async function fetchModel(
  modelsRoot: string,
  model: ModelSpec,
  fetcher: Fetcher,
  onFile?: (f: ModelFile) => void,
  onBytes?: (f: ModelFile, bytes: number) => void,
): Promise<string> {
  await ensureDir(modelsRoot);
  const dir = modelDir(modelsRoot, model);
  await ensureDir(dir);
  for (const f of model.files) {
    onFile?.(f);
    await download(fetcher, f, join(dir, f.name), (n) => onBytes?.(f, n));
  }
  return dir;
}

export async function removeModel(modelsRoot: string, model: ModelSpec): Promise<boolean> {
  const dir = modelDir(modelsRoot, model);
  const existed = await stat(dir).then(
    () => true,
    () => false,
  );
  await rm(dir, { recursive: true, force: true });
  return existed;
}
