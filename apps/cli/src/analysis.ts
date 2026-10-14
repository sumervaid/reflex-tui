import { type WorkflowTrace, sha256 } from "@reflex/core";
import { type Analysis, analyze } from "@reflex/analysis";
import { activeModel } from "@reflex/embeddings";
import { type SavedAnalysis, type Store, paths } from "@reflex/storage";
import { currentKeys } from "./collect";
import { sessionVectors } from "./embeddings";
import { userSkills } from "./skills";

/**
 * Which skills can cover a workflow: those in your skill folders, minus the ones Reflex generated
 * (so an approved workflow never vanishes from its own suggestion).
 */
export type SkillSets = { ownSkills: Set<string>; userSkills: Set<string> };

export const skillSets = async (store: Store): Promise<SkillSets> => ({ ownSkills: new Set(store.skills().map((s) => s.name)), userSkills: await userSkills() });

const setKey = (s: ReadonlySet<string>) => sha256([...s].sort().join("\n")).slice(0, 12);

/**
 * What an analysis depends on beyond the stored traces: Reflex's own build, which model (if any)
 * compared requests by meaning, and which skills you have and Reflex generated (a workflow run
 * with your own skills is not suggested again). Rejecting suggestions changes none of these.
 */
export function analysisKey(modelId: string | undefined, skills: SkillSets): string {
  return `${currentKeys().codeKey}|${modelId ?? "words"}|${setKey(skills.ownSkills)}|${setKey(skills.userSkills)}`;
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
  const skills = await skillSets(store);
  if (scan.analysis && scan.analysisKey === analysisKey(active?.id, skills)) return { ...scan.analysis, reused: true };
  const traces = store.traces();
  const meaning = await sessionVectors(traces, store, { cacheOnly: true });
  const a = analyze(traces, { ...(meaning.status === "ok" ? { vectors: meaning.vectors } : {}), ...skills });
  store.saveSuggestions(scan.id, a.suggestions);
  const saved = summarize(a, traces);
  store.saveAnalysis(scan.id, analysisKey(meaning.status === "ok" ? meaning.model.id : undefined, skills), saved);
  return { ...saved, reused: false };
}
