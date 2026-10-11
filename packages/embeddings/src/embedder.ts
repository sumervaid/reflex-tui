import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL, readVerified } from "./model";
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

/**
 * Load the verified model and run it with the WebAssembly backend: no native modules, a single
 * thread, and no network (the model and runtime are read from local files only).
 */
export async function loadEmbedder(modelDir: string, opts: { wasmDir?: string } = {}): Promise<Embedder> {
  const wasmDir = opts.wasmDir ?? defaultWasmDir();
  for (const f of WASM_FILES) if (!existsSync(join(wasmDir, f))) throw new Error(`Embedding runtime file ${f} is missing from ${wasmDir}.`);
  const [modelBytes, vocab] = await Promise.all([readVerified(modelDir, "model_quantized.onnx"), readVerified(modelDir, "vocab.txt")]);

  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(join(wasmDir, "/")).href;
  ort.env.logLevel = "error";
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
  const tokenizer = new WordPieceTokenizer(vocab.toString("utf8"));
  const needsTypes = session.inputNames.includes("token_type_ids");

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
    const out = (await session.run(feeds))[session.outputNames[0]!]!;
    const hidden = out.data as Float32Array;
    const dim = out.dims[2]!;
    // Mean-pool over real tokens, then L2-normalize (sentence-transformers pooling for this model).
    return ids.map((row, b) => {
      const v = new Float32Array(dim);
      for (let t = 0; t < row.length; t++) {
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
    model: MODEL.id,
    async embed(texts) {
      const encoded = texts.map((t) => tokenizer.encode(t, MODEL.maxTokens));
      const order = encoded.map((_, i) => i);
      const result = new Array<Float32Array>(texts.length);
      for (let i = 0; i < order.length; i += BATCH) {
        const idx = order.slice(i, i + BATCH);
        const vectors = await batch(idx.map((j) => encoded[j]!));
        idx.forEach((j, k) => (result[j] = vectors[k]!));
      }
      return result;
    },
  };
}
