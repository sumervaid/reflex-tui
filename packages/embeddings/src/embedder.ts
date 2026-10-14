import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { embeddingThreads } from "./machine";
import { type ModelSpec, readVerified } from "./model";
import { WordPieceTokenizer } from "./tokenizer";

export type Embedder = {
  model: string;
  /** Unit-length sentence vectors, one per text, in input order. */
  embed(texts: string[]): Promise<Float32Array[]>;
};

/** onnxruntime-web runtime files; the CLI build copies them next to the bundle. */
export const WASM_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"] as const;

/**
 * One text per run. The int8 model quantizes activations per batch, so batching would make a
 * session's vector depend on which other sessions shared its batch, and cached vectors must not.
 */
const BATCH = 1;

function defaultWasmDir(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve("onnxruntime-web"));
  } catch {
    throw new Error("onnxruntime-web is not installed; pass wasmDir.");
  }
}

/** Token ids for one text, cut to the model's input limit with its closing special token kept. */
type Encode = (text: string) => number[];

async function tokenizerFor(dir: string, model: ModelSpec): Promise<Encode> {
  if (model.tokenizer === "wordpiece") {
    const tokenizer = new WordPieceTokenizer((await readVerified(dir, "vocab.txt", model)).toString("utf8"));
    return (text) => tokenizer.encode(text, model.maxTokens);
  }
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const [json, config] = await Promise.all([readVerified(dir, "tokenizer.json", model), readVerified(dir, "tokenizer_config.json", model)]);
  const tokenizer = new Tokenizer(JSON.parse(json.toString("utf8")), JSON.parse(config.toString("utf8")));
  return (text) => {
    const ids: number[] = tokenizer.encode(text).ids;
    return ids.length > model.maxTokens ? [...ids.slice(0, model.maxTokens - 1), ids[ids.length - 1]!] : ids;
  };
}

/**
 * Load a verified model and run it with the WebAssembly backend: no native modules, up to four
 * threads (see embeddingThreads), and no network (the model and runtime are read from local files only).
 */
export async function loadEmbedder(modelDir: string, model: ModelSpec, opts: { wasmDir?: string; threads?: number } = {}): Promise<Embedder> {
  const wasmDir = opts.wasmDir ?? defaultWasmDir();
  for (const f of WASM_FILES) if (!existsSync(join(wasmDir, f))) throw new Error(`Embedding runtime file ${f} is missing from ${wasmDir}.`);
  const [modelBytes, encode] = await Promise.all([readVerified(modelDir, "model_quantized.onnx", model), tokenizerFor(modelDir, model)]);

  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = opts.threads ?? embeddingThreads();
  ort.env.wasm.wasmPaths = pathToFileURL(join(wasmDir, "/")).href;
  ort.env.logLevel = "error";
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
  const needsTypes = session.inputNames.includes("token_type_ids");
  const output = session.outputNames.includes("last_hidden_state") ? "last_hidden_state" : session.outputNames[0]!;

  async function batch(ids: number[][]): Promise<Float32Array[]> {
    const width = Math.max(...ids.map((x) => x.length));
    const n = ids.length * width;
    const input = new BigInt64Array(n);
    const mask = new BigInt64Array(n);
    ids.forEach((row, b) =>
      row.forEach((id, t) => {
        input[b * width + t] = BigInt(id);
        mask[b * width + t] = 1n;
      }),
    );
    const shape = [ids.length, width];
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
      input_ids: new ort.Tensor("int64", input, shape),
      attention_mask: new ort.Tensor("int64", mask, shape),
    };
    if (needsTypes) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(n), shape);
    const out = (await session.run(feeds))[output]!;
    const hidden = out.data as Float32Array;
    const dim = out.dims[2]!;
    // Pool token states into one vector (mean over real tokens, or the first token), then L2-normalize.
    return ids.map((row, b) => {
      const v = new Float32Array(dim);
      const tokens = model.pooling === "cls" ? 1 : row.length;
      for (let t = 0; t < tokens; t++) {
        const off = (b * width + t) * dim;
        for (let k = 0; k < dim; k++) v[k]! += hidden[off + k]!;
      }
      let norm = 0;
      for (let k = 0; k < dim; k++) norm += v[k]! * v[k]!;
      norm = Math.sqrt(norm) || 1;
      for (let k = 0; k < dim; k++) v[k]! /= norm;
      return v;
    });
  }

  return {
    model: model.id,
    async embed(texts) {
      const encoded = texts.map(encode);
      const result = new Array<Float32Array>(texts.length);
      for (let i = 0; i < encoded.length; i += BATCH) {
        const vectors = await batch(encoded.slice(i, i + BATCH));
        vectors.forEach((v, k) => (result[i + k] = v));
      }
      return result;
    },
  };
}
