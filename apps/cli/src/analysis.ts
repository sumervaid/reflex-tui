import { type WorkflowTrace, sha256 } from "@reflex/core";
import { type Analysis, type MatchingSettings, analyze } from "@reflex/analysis";
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
 * compared requests by meaning, which skills you have and Reflex generated (a workflow run with
 * your own skills is not suggested again), and your matching settings. Rejecting suggestions
 * changes none of these.
 */
export function analysisKey(modelId: string | undefined, skills: SkillSets, matching: MatchingSettings, installed?: ReadonlyMap<string, string>): string {
  // A new install changes which sessions count as use rather than evidence, so it invalidates the
  // saved analysis like any other input.
  const installs = installed ? sha256([...installed].map(([n, t]) => `${n}@${t}`).sort().join("\n")).slice(0, 12) : "none";
  return `${currentKeys().codeKey}|${modelId ?? "words"}|${setKey(skills.ownSkills)}|${setKey(skills.userSkills)}|${matching.sessions}-${matching.strictness}|${installs}`;
}

/** When each installed skill went in, earliest install across targets, by name. */
export function installedSkills(store: Store): Map<string, string> {
  const at = new Map<string, string>();
  for (const i of store.installations()) {
    const prev = at.get(i.skill);
    if (!prev || i.installedAt < prev) at.set(i.skill, i.installedAt);
  }
  return at;
}

export function summarize(a: Analysis, traces: WorkflowTrace[]): SavedAnalysis {
  return { stats: a.stats, repositories: new Set(traces.map((t) => t.projectHash).filter(Boolean)).size };
}

/**
 * The latest scan's analysis. Analysis is deterministic, so the one `scan` saved is reused as long
 * as nothing it depends on changed; otherwise (Reflex upgraded, model installed or removed, matching
 * settings changed) it is recomputed from the stored traces once and saved again, suggestions included.
 */
export async function latestAnalysis(store: Store): Promise<SavedAnalysis & { reused: boolean }> {
  const scan = store.latestScan();
  if (!scan) throw new Error("No scan yet. Run `reflex scan --days 7` first.");
  const active = await activeModel(paths.models());
  const skills = await skillSets(store);
  const stored = store.matchingSettings();
  // The analysis only knows the bar itself; who set it and whether it may move stays in the database.
  const matching: MatchingSettings = { sessions: stored.sessions, strictness: stored.strictness };
  const installed = installedSkills(store);
  if (scan.analysis && scan.analysisKey === analysisKey(active?.id, skills, matching, installed)) return { ...scan.analysis, reused: true };
  const traces = store.traces();
  const meaning = await sessionVectors(traces, store, { cacheOnly: true });
  const a = analyze(traces, { ...(meaning.status === "ok" ? { vectors: meaning.vectors } : {}), ...skills, matching, installed: installedSkills(store) });
  store.saveSuggestions(scan.id, a.suggestions);
  const saved = summarize(a, traces);
  store.saveAnalysis(scan.id, analysisKey(meaning.status === "ok" ? meaning.model.id : undefined, skills, matching, installed), saved);
  return { ...saved, reused: false };
}
