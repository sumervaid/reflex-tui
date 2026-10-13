import { type WorkflowTrace, sha256 } from "@reflex/core";
import { type Analysis, analyze } from "@reflex/analysis";
import { MODEL, modelStatus } from "@reflex/embeddings";
import { type SavedAnalysis, type Store, paths } from "@reflex/storage";
import { currentKeys } from "./collect";
import { sessionVectors } from "./embeddings";

/** Skills Reflex generated, so their use is not mistaken for skills you wrote. */
export const ownSkills = (store: Store): Set<string> => new Set(store.skills().map((s) => s.name));

/**
 * What an analysis depends on beyond the stored traces: Reflex's own build, whether requests were
 * compared by meaning, and which skills Reflex generated (a workflow run with your own skills is
 * not suggested again). Rejecting suggestions changes none of these.
 */
export function analysisKey(byMeaning: boolean, own: ReadonlySet<string>): string {
  return `${currentKeys().codeKey}|${byMeaning ? MODEL.id : "words"}|${sha256([...own].sort().join("\n")).slice(0, 12)}`;
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
  const installed = (await modelStatus(paths.models())).installed;
  const own = ownSkills(store);
  if (scan.analysis && scan.analysisKey === analysisKey(installed, own)) return { ...scan.analysis, reused: true };
  const traces = store.traces();
  const meaning = await sessionVectors(traces, store, { cacheOnly: true });
  const byMeaning = meaning.status === "ok";
  const a = analyze(traces, { ...(byMeaning ? { vectors: meaning.vectors } : {}), ownSkills: own });
  store.saveSuggestions(scan.id, a.suggestions);
  const saved = summarize(a, traces);
  store.saveAnalysis(scan.id, analysisKey(byMeaning, own), saved);
  return { ...saved, reused: false };
}
