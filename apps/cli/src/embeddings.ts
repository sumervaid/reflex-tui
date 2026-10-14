import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "@reflex/core";
import type { WorkflowTrace } from "@reflex/core";
import { type SessionVectors, contextDocument, contextHash, withFloor } from "@reflex/analysis";
import { MODELS, type ModelSpec, WASM_FILES, activeModel, centerOnReference, loadEmbedder, memoryFits, modelDir, modelReads } from "@reflex/embeddings";
import { type Store, paths } from "@reflex/storage";

export type VectorResult =
  | {
      status: "ok";
      model: ModelSpec;
      vectors: SessionVectors;
      embedded: number;
      cached: number;
      /** Sessions left for a later scan: the time limit was reached, or the machine has too little memory for the model. */
      remaining: number;
      stoppedBy?: "time" | "memory";
    }
  | { status: "no-model" }
  | { status: "failed"; error: string };

/** The build copies the WebAssembly runtime next to the bundle; from source, use node_modules. */
function bundledWasmDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  return WASM_FILES.every((f) => existsSync(join(here, f))) ? here : undefined;
}

/** Cache key of a session's vector: model plus context document hash. */
export function embeddingKey(contextHashValue: string, model: ModelSpec): string {
  return sha256(`${model.id}\n${contextHashValue}`);
}

const keyOf = (t: WorkflowTrace, model: ModelSpec) => embeddingKey(t.contextHash ?? contextHash(contextDocument(t)), model);

/** The request part of a context document (after its "Files:" line), which decides whether the model can read it. */
const readable = (doc: string, model: ModelSpec) => modelReads(doc.replace(/^Files: [^\n]*\n/, ""), model);

/** Stored for a document the model cannot read: known, so never re-read for it, but compared by words only. */
const UNREADABLE = new Float32Array(0);

/** Default time a scan spends embedding before it leaves the rest for the next scan. */
export const EMBED_BUDGET_MS = 5 * 60_000;

/** Texts embedded between saves and time checks: progress survives an interrupted scan. */
const CHUNK = 4;

/**
 * Embed documents in order until the time budget runs out, saving each chunk as soon as it is done.
 * Returns how many were embedded; the rest are left for a later call.
 */
export async function embedWithinBudget(
  items: Array<[key: string, doc: string]>,
  embed: (docs: string[]) => Promise<Float32Array[]>,
  save: (entries: Array<[string, Float32Array]>) => void,
  budgetMs: number,
  onProgress?: (done: number, total: number, etaSeconds: number | undefined) => void,
  now: () => number = () => performance.now(),
): Promise<number> {
  const start = now();
  let done = 0;
  onProgress?.(0, items.length, undefined);
  while (done < items.length) {
    if (done > 0 && now() - start >= budgetMs) break;
    const chunk = items.slice(done, done + CHUNK);
    const vectors = await embed(chunk.map(([, doc]) => doc));
    save(chunk.map(([key], i) => [key, vectors[i]!]));
    done += chunk.length;
    const perItem = (now() - start) / done;
    onProgress?.(done, items.length, ((items.length - done) * perItem) / 1000);
  }
  return done;
}

/**
 * A new request's vector plus the stored session vectors, when a model is installed, so a request
 * can be matched to past sessions by meaning. Undefined (match by words) otherwise or on failure.
 */
export async function requestVectors(
  document: string,
  traces: WorkflowTrace[],
  store: Store,
): Promise<{ vectors: SessionVectors; requestVector: Float32Array } | undefined> {
  const model = await activeModel(paths.models());
  if (!model || !readable(document, model) || !memoryFits(model)) return undefined;
  try {
    const cached = await sessionVectors(traces, store, { cacheOnly: true });
    if (cached.status !== "ok" || !cached.vectors.size) return undefined;
    const embedder = await loadEmbedder(modelDir(paths.models(), model), model, { wasmDir: bundledWasmDir() });
    const [requestVector] = await embedder.embed([document]);
    return requestVector ? { vectors: cached.vectors, requestVector: centerOnReference(requestVector, model) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * When a model is installed: which sessions have no vector from it yet. `scan` re-reads the files
 * of those sessions (and only those) to get their text, since the text itself is never stored.
 */
export async function vectorNeeds(store: Store): Promise<((t: WorkflowTrace) => boolean) | undefined> {
  const model = await activeModel(paths.models());
  if (!model) return undefined;
  const have = store.embeddingKeys();
  return (t) => !have.has(keyOf(t, model));
}

/**
 * Sentence vectors for each session's context document from the active model, centered on its
 * reference mean and carrying its floor. Vectors are cached (uncentered) by model and document
 * hash, so only new or changed sessions are embedded, and switching models back and forth never
 * re-embeds what either already did.
 * `documents` (by session id) holds the text to embed; only `scan` has it, for the files it read,
 * because the full request is never stored. With `cacheOnly`, returns only vectors already stored.
 * Vectors are kept for every cached trace, so changing --days never re-embeds anything.
 * Newest sessions are embedded first, for at most `budgetMs`; the rest are compared by words until
 * a later scan embeds them. A machine with too little memory for the model embeds nothing new.
 * Any failure falls back to lexical matching rather than failing the scan.
 */
export async function sessionVectors(
  traces: WorkflowTrace[],
  store: Store,
  opts: {
    documents?: ReadonlyMap<string, string>;
    cacheOnly?: boolean;
    budgetMs?: number;
    onProgress?: (done: number, total: number, model: ModelSpec, etaSeconds: number | undefined) => void;
  } = {},
): Promise<VectorResult> {
  const model = await activeModel(paths.models());
  if (!model) return { status: "no-model" };
  try {
    const keys = traces.map((t) => keyOf(t, model));
    const cached = store.embeddings(keys);
    // Stored raw, so the cache survives a change of reference; centered for comparison (see EMBEDDING_FLOOR).
    const pick = () =>
      withFloor(
        new Map(traces.flatMap((t, i) => (cached.get(keys[i]!)?.length ? [[t.sessionId, centerOnReference(cached.get(keys[i]!)!, model)] as const] : []))),
        model.floor,
      );
    // Commands that re-analyze stored sessions use what the scan embedded and never load the model.
    if (opts.cacheOnly) {
      const vectors = pick();
      return { status: "ok", model, vectors, embedded: 0, cached: vectors.size, remaining: 0 };
    }
    const docOf = new Map<string, string>();
    const startedOf = new Map<string, string>();
    traces.forEach((t, i) => {
      const doc = opts.documents?.get(t.sessionId);
      if (doc !== undefined && !cached.has(keys[i]!)) {
        docOf.set(keys[i]!, doc);
        startedOf.set(keys[i]!, t.startedAt ?? "");
      }
    });
    const unreadable = [...docOf.keys()].filter((k) => !readable(docOf.get(k)!, model)).map((k) => [k, UNREADABLE] as [string, Float32Array]);
    if (unreadable.length) {
      store.saveEmbeddings(model.id, unreadable);
      for (const [k, v] of unreadable) cached.set(k, v);
    }
    // Newest first: if the time limit stops the scan, the sessions people care about most are done.
    const missing = [...docOf.keys()]
      .filter((k) => readable(docOf.get(k)!, model))
      .sort((a, b) => startedOf.get(b)!.localeCompare(startedOf.get(a)!))
      .map((k) => [k, docOf.get(k)!] as [string, string]);
    let embedded = 0;
    let stoppedBy: "time" | "memory" | undefined;
    if (missing.length && !memoryFits(model)) stoppedBy = "memory";
    else if (missing.length) {
      const embedder = await loadEmbedder(modelDir(paths.models(), model), model, { wasmDir: bundledWasmDir() });
      embedded = await embedWithinBudget(
        missing,
        (docs) => embedder.embed(docs),
        (fresh) => {
          store.saveEmbeddings(model.id, fresh);
          for (const [k, v] of fresh) cached.set(k, v);
        },
        opts.budgetMs ?? EMBED_BUDGET_MS,
        (done, total, eta) => opts.onProgress?.(done, total, model, eta),
      );
      if (embedded < missing.length) stoppedBy = "time";
    }
    // Keep every model's vectors for the cached traces, so switching models never loses any.
    const hashes = store.contextHashes();
    store.pruneEmbeddings(MODELS.flatMap((m) => hashes.map((h) => embeddingKey(h, m))));
    const vectors = pick();
    return { status: "ok", model, vectors, embedded, cached: vectors.size - embedded, remaining: missing.length - embedded, stoppedBy };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
