import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, replaceOwnedFile } from "@reflex/safety";

export type ModelFile = { name: string; url: string; bytes: number; sha256: string };

const REPO = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve";
const REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";

/**
 * The one embedding model Reflex uses: all-MiniLM-L6-v2, int8-quantized ONNX export. Files are
 * pinned to a repository revision and verified by size and SHA-256 before they are kept.
 */
export const MODEL = {
  id: "all-minilm-l6-v2-q8",
  label: "all-MiniLM-L6-v2 (int8)",
  dimensions: 384,
  maxTokens: 256,
  files: [
    {
      name: "model_quantized.onnx",
      url: `${REPO}/${REVISION}/onnx/model_quantized.onnx`,
      bytes: 22_972_370,
      sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    },
    {
      name: "vocab.txt",
      url: `${REPO}/${REVISION}/vocab.txt`,
      bytes: 231_508,
      sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
    },
  ] satisfies ModelFile[],
} as const;

export const modelBytes = (): number => MODEL.files.reduce((n, f) => n + f.bytes, 0);

/**
 * Whether the model can read a text. Its vocabulary covers Latin script only: other scripts come
 * apart into single letters (Korean into jamo), and any two such texts then look alike whatever
 * they say (two unrelated Korean requests average a cosine of 0.40, two English ones 0.13). Such
 * text is compared by words only. Mostly-Latin text with a few other letters is still read.
 */
export function modelReads(text: string): boolean {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return true;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return latin / letters >= 0.7;
}

export function modelDir(modelsRoot: string): string {
  return join(modelsRoot, MODEL.id);
}

export type ModelStatus = { installed: true; dir: string } | { installed: false; dir: string; missing: string[] };

/** Cheap presence check (sizes only). Hashes are verified on download and again on load. */
export async function modelStatus(modelsRoot: string): Promise<ModelStatus> {
  const dir = modelDir(modelsRoot);
  const missing: string[] = [];
  for (const f of MODEL.files) {
    const size = await stat(join(dir, f.name)).then((s) => s.size, () => -1);
    if (size !== f.bytes) missing.push(f.name);
  }
  return missing.length ? { installed: false, dir, missing } : { installed: true, dir };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Read a model file and refuse it unless it is byte-for-byte the pinned file. */
export async function readVerified(dir: string, name: string): Promise<Buffer> {
  const spec = MODEL.files.find((f) => f.name === name);
  if (!spec) throw new Error(`Unknown model file ${name}`);
  const data = await readFile(join(dir, name));
  if (data.length !== spec.bytes || sha256Hex(data) !== spec.sha256) {
    throw new Error(`Model file ${name} does not match the pinned version. Run \`reflex model fetch\` again.`);
  }
  return data;
}

/** Full check: every file present and byte-for-byte the pinned version. */
export async function modelVerified(modelsRoot: string): Promise<boolean> {
  const dir = modelDir(modelsRoot);
  for (const f of MODEL.files) {
    try {
      await readVerified(dir, f.name);
    } catch {
      return false;
    }
  }
  return true;
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Download the pinned model files into `modelsRoot`. Each file is verified before it is written,
 * and written atomically, so a failed or tampered download never leaves a usable-looking model.
 */
export async function fetchModel(modelsRoot: string, fetcher: Fetcher, onFile?: (f: ModelFile) => void): Promise<string> {
  await ensureDir(modelsRoot);
  const dir = modelDir(modelsRoot);
  await ensureDir(dir);
  for (const f of MODEL.files) {
    onFile?.(f);
    const res = await fetcher(f.url);
    if (!res.ok) throw new Error(`Download of ${f.name} failed (HTTP ${res.status}).`);
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length !== f.bytes || sha256Hex(data) !== f.sha256) {
      throw new Error(`Downloaded ${f.name} does not match the pinned checksum; nothing was kept.`);
    }
    await replaceOwnedFile(join(dir, f.name), data, 0o600);
  }
  return dir;
}

export async function removeModel(modelsRoot: string): Promise<boolean> {
  const dir = modelDir(modelsRoot);
  const existed = await stat(dir).then(() => true, () => false);
  await rm(dir, { recursive: true, force: true });
  return existed;
}
