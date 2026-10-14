import type { WorkflowTrace } from "@reflex/core";
import { type Analysis, analyze } from "@reflex/analysis";
import { activeModel } from "@reflex/embeddings";
import { type SavedAnalysis, type Store, paths } from "@reflex/storage";
import { currentKeys } from "./collect";
import { sessionVectors } from "./embeddings";

/**
 * What an analysis depends on beyond the stored traces: Reflex's own build, and which model (if
 * any) compared requests by meaning. Approving or rejecting suggestions changes neither.
 */
export function analysisKey(modelId: string | undefined): string {
  return `${currentKeys().codeKey}|${modelId ?? "words"}`;
}

export function summarize(a: Analysis, traces: WorkflowTrace[]): SavedAnalysis {
  return { stats: a.stats, repositories: new Set(traces.map((t) => t.projectHash).filter(Boolean)).size };
}

/**
 * The latest scan's analysis. Analysis is deterministic, so the one `scan` saved is reused as long
 * as nothing it depends on changed; otherwise (Reflex upgraded, model installed or removed) it is
 * recomputed from the stored traces once and saved again, suggestions included.
 */
export async function latestAnalysis(store: Store): Promise<SavedAnalysis & { reused: boolean }> {
  const scan = store.latestScan();
  if (!scan) throw new Error("No scan yet. Run `reflex scan --days 7` first.");
  const active = await activeModel(paths.models());
  if (scan.analysis && scan.analysisKey === analysisKey(active?.id)) return { ...scan.analysis, reused: true };
  const traces = store.traces();
  const meaning = await sessionVectors(traces, store, { cacheOnly: true });
  const a = analyze(traces, meaning.status === "ok" ? { vectors: meaning.vectors } : {});
  store.saveSuggestions(scan.id, a.suggestions);
  const saved = summarize(a, traces);
  store.saveAnalysis(scan.id, analysisKey(meaning.status === "ok" ? meaning.model.id : undefined), saved);
  return { ...saved, reused: false };
}
