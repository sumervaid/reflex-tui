import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@reflex/core";
import type { WorkflowTrace } from "@reflex/core";
import { type SessionVectors, contextDocument, contextHash } from "@reflex/analysis";
import { MODEL, WASM_FILES, centerOnReference, loadEmbedder, modelReads, modelStatus } from "@reflex/embeddings";
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

/** Cache key of a session's vector: model plus context document hash. */
export function embeddingKey(contextHashValue: string): string {
  return sha256(`${MODEL.id}\n${contextHashValue}`);
}

const keyOf = (t: WorkflowTrace) => embeddingKey(t.contextHash ?? contextHash(contextDocument(t)));

/** The request part of a context document (after its "Files:" line), which decides whether the model can read it. */
const readable = (doc: string) => modelReads(doc.replace(/^Files: [^\n]*\n/, ""));

/** Stored for a document the model cannot read: known, so never re-read for it, but compared by words only. */
const UNREADABLE = new Float32Array(0);

/**
 * A new request's vector plus the stored session vectors, when the model is installed, so a request
 * can be matched to past sessions by meaning. Undefined (match by words) otherwise or on failure.
 */
export async function requestVectors(
  document: string,
  traces: WorkflowTrace[],
  store: Store,
): Promise<{ vectors: SessionVectors; requestVector: Float32Array } | undefined> {
  const status = await modelStatus(paths.models());
  if (!status.installed || !readable(document)) return undefined;
  try {
    const cached = await sessionVectors(traces, store, { cacheOnly: true });
    if (cached.status !== "ok" || !cached.vectors.size) return undefined;
    const embedder = await loadEmbedder(status.dir, { wasmDir: bundledWasmDir() });
    const [requestVector] = await embedder.embed([document]);
    return requestVector ? { vectors: cached.vectors, requestVector: centerOnReference(requestVector) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When the model is installed: which sessions have no vector yet. `scan` re-reads the files of
 * those sessions (and only those) to get their text, since the text itself is never stored.
 */
export async function vectorNeeds(store: Store): Promise<((t: WorkflowTrace) => boolean) | undefined> {
  if (!(await modelStatus(paths.models())).installed) return undefined;
  const have = store.embeddingKeys();
  return (t) => !have.has(keyOf(t));
}

/**
 * Sentence vectors for each session's context document, when the optional model is installed,
 * centered on the model's reference mean. Vectors are cached (uncentered) by model and document
 * hash, so only new or changed sessions are embedded.
 * `documents` (by session id) holds the text to embed; only `scan` has it, for the files it read,
 * because the full request is never stored. With `cacheOnly`, returns only vectors already stored.
 * Vectors are kept for every cached trace, so changing --days never re-embeds anything.
 * Any failure falls back to lexical matching rather than failing the scan.
 */
export async function sessionVectors(
  traces: WorkflowTrace[],
  store: Store,
  opts: { documents?: ReadonlyMap<string, string>; cacheOnly?: boolean; onProgress?: (n: number) => void } = {},
): Promise<VectorResult> {
  const status = await modelStatus(paths.models());
  if (!status.installed) return { status: "no-model" };
  try {
    const keys = traces.map(keyOf);
    const cached = store.embeddings(keys);
    // Stored raw, so the cache survives a change of reference; centered for comparison (see EMBEDDING_FLOOR).
    const pick = () =>
      new Map(traces.flatMap((t, i) => (cached.get(keys[i]!)?.length ? [[t.sessionId, centerOnReference(cached.get(keys[i]!)!)] as const] : [])));
    // Commands that re-analyze stored sessions use what the scan embedded and never load the model.
    if (opts.cacheOnly) {
      const vectors = pick();
      return { status: "ok", vectors, embedded: 0, cached: vectors.size };
    }
    const docOf = new Map<string, string>();
    traces.forEach((t, i) => {
      const doc = opts.documents?.get(t.sessionId);
      if (doc !== undefined && !cached.has(keys[i]!)) docOf.set(keys[i]!, doc);
    });
    const missing = [...docOf.keys()].filter((k) => readable(docOf.get(k)!));
    const unreadable = [...docOf.keys()].filter((k) => !readable(docOf.get(k)!)).map((k) => [k, UNREADABLE] as [string, Float32Array]);
    if (unreadable.length) {
      store.saveEmbeddings(MODEL.id, unreadable);
      for (const [k, v] of unreadable) cached.set(k, v);
    }
    if (missing.length) {
      opts.onProgress?.(missing.length);
      const embedder = await loadEmbedder(status.dir, { wasmDir: bundledWasmDir() });
      const vectors = await embedder.embed(missing.map((k) => docOf.get(k)!));
      const fresh = missing.map((k, i) => [k, vectors[i]!] as [string, Float32Array]);
      store.saveEmbeddings(MODEL.id, fresh);
      for (const [k, v] of fresh) cached.set(k, v);
    }
    store.pruneEmbeddings(store.contextHashes().map(embeddingKey));
    const vectors = pick();
    return { status: "ok", vectors, embedded: missing.length, cached: vectors.size - missing.length };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
