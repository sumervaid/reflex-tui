import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@reflex/core";
import type { WorkflowTrace } from "@reflex/core";
import { type SessionVectors, contextDocument, contextHash } from "@reflex/analysis";
import { MODEL, WASM_FILES, loadEmbedder, modelStatus } from "@reflex/embeddings";
import { type Store, paths } from "@reflex/storage";

export type VectorResult =
  | { status: "ok"; vectors: SessionVectors; embedded: number; cached: number }
  | { status: "no-model" }
  | { status: "failed"; error: string };

/** The build copies the WebAssembly runtime next to the bundle; from source, use node_modules. */
function bundledWasmDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return WASM_FILES.every((f) => existsSync(join(here, f))) ? here : undefined;
}

/**
 * Sentence vectors for each session's context document, when the optional model is installed.
 * Vectors are cached by model and document hash, so only new or changed sessions are embedded.
 * `documents` (aligned with `traces`) holds the text to embed; only `scan` has it, because the
 * full request is never stored. With `cacheOnly`, returns only vectors a scan already stored.
 * Any failure falls back to lexical matching rather than failing the scan.
 */
export async function sessionVectors(
  traces: WorkflowTrace[],
  store: Store,
  opts: { documents?: string[]; cacheOnly?: boolean; onProgress?: (n: number) => void } = {},
): Promise<VectorResult> {
  const status = await modelStatus(paths.models());
  if (!status.installed) return { status: "no-model" };
  try {
    const docs = traces.map((t, i) => opts.documents?.[i] ?? contextDocument(t));
    const keys = traces.map((t, i) => sha256(`${MODEL.id}\n${opts.documents ? contextHash(docs[i]!) : (t.contextHash ?? contextHash(docs[i]!))}`));
    const cached = store.embeddings(keys);
    const missing = [...new Set(keys.filter((k) => !cached.has(k)))];
    // Commands that re-analyze stored sessions use what the scan embedded and never load the model.
    if (opts.cacheOnly) {
      const vectors = new Map(traces.flatMap((t, i) => (cached.has(keys[i]!) ? [[t.sessionId, cached.get(keys[i]!)!] as const] : [])));
      return { status: "ok", vectors, embedded: 0, cached: vectors.size };
    }
    if (missing.length) {
      opts.onProgress?.(missing.length);
      const embedder = await loadEmbedder(status.dir, { wasmDir: bundledWasmDir() });
      const docOf = new Map(keys.map((k, i) => [k, docs[i]!]));
      const vectors = await embedder.embed(missing.map((k) => docOf.get(k)!));
      const fresh = missing.map((k, i) => [k, vectors[i]!] as [string, Float32Array]);
      store.saveEmbeddings(MODEL.id, fresh);
      for (const [k, v] of fresh) cached.set(k, v);
    }
    store.pruneEmbeddings(keys);
    const vectors = new Map(traces.map((t, i) => [t.sessionId, cached.get(keys[i]!)!]));
    return { status: "ok", vectors, embedded: missing.length, cached: keys.length - missing.length };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
