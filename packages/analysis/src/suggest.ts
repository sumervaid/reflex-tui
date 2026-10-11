import type { ActionCategory, SourceId, WorkflowTrace } from "@reflex/core";
import { SOURCE_IDS, debug, totalTokens } from "@reflex/core";
import { toSlug } from "@reflex/safety";
import { FAMILIES } from "./catalog";
import { CLUSTER_THRESHOLD, clusterTraces } from "./cluster";
import { type DedupStats, type WorkflowInstance, deduplicate } from "./dedup";
import { MODIFY_TARGET_LABEL, STEP_TEXT, type StepKind } from "./steps";
import { type WorkflowCost, median, workflowCost } from "./impact";
import { isGenericTrace, usedSkill } from "./trace";

export const MIN_INSTANCES = 3;
const MIN_INTENT_COHESION = 0.2;
const MIN_ACTION_COHESION = 0.5;
const MIN_STEP_SUPPORT = 0.5;
const MAX_EXAMPLES_PER_STEP = 3;
/** Generic file viewers say nothing reusable as a command example. */
const FILE_VIEWER = /^(cat|sed|head|tail|less|more|bat|nl|ls|tree)\b/;
/**
 * Commands come from untrusted transcripts and end up in a file an agent will read. Never
 * recommend anything destructive, privileged, remote-executing or able to smuggle a subshell,
 * however often it recurred.
 */
const UNSAFE_EXAMPLE =
  /[`$<>;&|\\]|\b(curl|wget|sudo|su|eval|exec|ssh|scp|nc|chmod|chown|dd|mkfs|rm|mv|kill|pkill|npx|bunx|dlx|publish|deploy)\b|--force\b|\s-f\b|--hard\b|--no-verify\b|\bpush\b|\breset\b|\bclean\b/;

export function isSafeExample(cmd: string): boolean {
  const withoutPlaceholders = cmd.replace(/<(n|file|ref|sha|arg|str|url)>/g, "x");
  return cmd.length <= 80 && !UNSAFE_EXAMPLE.test(withoutPlaceholders) && !/\[REDACTED/.test(cmd);
}

export type ConsensusStep = {
  kind: StepKind;
  label: string;
  instruction: string;
  /** Fraction of independent instances that contain this step. */
  support: number;
  /** Normalized commands seen for this step in at least two instances. */
  examples: string[];
  /** For a combined patch step: what was changed, with instance counts. */
  variants?: string[];
};

export type Evidence = {
  sessionId: string;
  source: SourceId;
  date?: string;
  project?: string;
  excerpt: string;
  actions: string[];
  verified: boolean;
  /** Duplicate records (copies, resumes, retries) folded into this instance. */
  duplicates: number;
  sourceFile: string;
  /** Whole-session tokens, when the source records them. */
  tokens?: number;
  toolCalls?: number;
  usedSkill?: boolean;
};

export type Suggestion = {
  slug: string;
  title: string;
  description: string;
  whenToUse: string;
  /** Heuristic 0..1 ranking score. Not a probability. */
  confidence: number;
  cohesion: number;
  instances: number;
  records: number;
  repositories: string[];
  sources: Partial<Record<SourceId, number>>;
  firstSeen?: string;
  lastSeen?: string;
  steps: ConsensusStep[];
  completion: string[];
  topTerms: string[];
  evidence: Evidence[];
  notes: string[];
  verifiedRate: number;
  medianMinutes?: number;
  /** Source session ids of every instance, for provenance. */
  sourceSessions: string[];
  /** Cost of the runs that did not load a skill with this name: the baseline for `reflex impact`. */
  cost?: WorkflowCost;
};

export type AnalysisStats = {
  traces: number;
  dedup: DedupStats;
  generic: number;
  candidates: number;
  clusters: number;
  recurrent: number;
};

export type Analysis = { suggestions: Suggestion[]; stats: AnalysisStats };

function consensusSteps(instances: WorkflowInstance[]): ConsensusStep[] {
  const n = instances.length;
  const positions = new Map<StepKind, number[]>();
  const commandHits = new Map<StepKind, Map<string, Set<string>>>();

  for (const inst of instances) {
    const t = inst.primary;
    const seq = t.actionSequence;
    const seen = new Set<StepKind>();
    seq.forEach((action, i) => {
      if (seen.has(action)) return;
      seen.add(action);
      const list = positions.get(action) ?? [];
      list.push(seq.length > 1 ? i / (seq.length - 1) : 0);
      positions.set(action, list);
    });
    if (t.outcome.recoveredFromFailure) {
      const firstModify = seq.findIndex((a) => a.startsWith("modify-"));
      const pos = firstModify > 0 ? (firstModify - 0.5) / Math.max(1, seq.length - 1) : 0.4;
      positions.set("reproduce-failure", [...(positions.get("reproduce-failure") ?? []), pos]);
    }
    for (const c of t.commands) {
      const byCmd = commandHits.get(c.action) ?? new Map<string, Set<string>>();
      const sessions = byCmd.get(c.normalized) ?? new Set<string>();
      sessions.add(inst.id);
      byCmd.set(c.normalized, sessions);
      commandHits.set(c.action, byCmd);
    }
  }

  const ranked: Array<{ step: ConsensusStep; pos: number }> = [];

  // Sessions patch different things (code, config, CI, manifest) for the same workflow. Judge the
  // "patch" step as a whole; keep it specific only when one kind clearly dominates.
  const modifyKinds = [...positions.keys()].filter((k): k is ActionCategory => k.startsWith("modify-"));
  const modifyInstances = instances.filter((i) => i.primary.actionSequence.some((a) => a.startsWith("modify-")));
  if (modifyInstances.length / n >= MIN_STEP_SUPPORT) {
    const counts = modifyKinds.map((k) => ({ k, count: positions.get(k)!.length })).sort((a, b) => b.count - a.count);
    const top = counts[0]!;
    const firstModify = modifyInstances.map((i) => {
      const seq = i.primary.actionSequence;
      return seq.findIndex((a) => a.startsWith("modify-")) / Math.max(1, seq.length - 1);
    });
    const support = modifyInstances.length / n;
    if (top.count >= 0.8 * modifyInstances.length) {
      ranked.push({ step: { kind: top.k, ...STEP_TEXT[top.k], support, examples: [] }, pos: median(firstModify) ?? 0.5 });
    } else {
      const variants = counts.map((c) => `${MODIFY_TARGET_LABEL[c.k] ?? c.k} (${c.count})`);
      ranked.push({ step: { kind: "apply-fix", ...STEP_TEXT["apply-fix"], support, examples: [], variants }, pos: median(firstModify) ?? 0.5 });
    }
  }

  for (const [kind, pos] of positions) {
    if (kind.startsWith("modify-")) continue;
    const support = pos.length / n;
    if (support < MIN_STEP_SUPPORT) continue;
    const hits: Map<string, Set<string>> = kind === "reproduce-failure" ? new Map() : (commandHits.get(kind) ?? new Map());
    const examples = [...hits]
      .filter(([cmd, s]) => s.size >= 2 && !FILE_VIEWER.test(cmd) && isSafeExample(cmd))
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
      .slice(0, MAX_EXAMPLES_PER_STEP)
      .map(([cmd]) => cmd);
    ranked.push({ step: { kind, ...STEP_TEXT[kind], support, examples }, pos: kind === "summarize" ? 2 : (median(pos) ?? 0) });
  }

  // Order by pairwise precedence: A goes before B if most sessions that contain both did A first.
  // Medians alone mislead when steps appear in different subsets of sessions.
  const orders = instances.map(stepOrder);
  const before = (a: StepKind, b: StepKind) => {
    let ab = 0;
    let ba = 0;
    for (const o of orders) {
      const x = o.get(a);
      const y = o.get(b);
      if (x === undefined || y === undefined) continue;
      if (x < y) ab++;
      else if (y < x) ba++;
    }
    return ab - ba;
  };
  return ranked
    .sort((a, b) => {
      if (a.step.kind === "summarize") return 1;
      if (b.step.kind === "summarize") return -1;
      const votes = before(b.step.kind, a.step.kind);
      return votes !== 0 ? votes : a.pos - b.pos;
    })
    .map((r) => r.step);
}

/** Where each step happens in one session: first occurrence, or last for verification-type steps. */
function stepOrder(inst: WorkflowInstance): Map<StepKind, number> {
  const seq = inst.primary.actionSequence;
  const at = new Map<StepKind, number>();
  seq.forEach((a, i) => {
    if (LAST_OCCURRENCE.has(a) || !at.has(a)) at.set(a, i);
  });
  const firstModify = seq.findIndex((a) => a.startsWith("modify-"));
  if (firstModify >= 0) {
    at.set("apply-fix", firstModify);
    for (const a of seq) if (a.startsWith("modify-")) at.set(a, firstModify);
    if (inst.primary.outcome.recoveredFromFailure) at.set("reproduce-failure", firstModify - 0.5);
  }
  return at;
}

const LAST_OCCURRENCE: ReadonlySet<StepKind> = new Set(["run-tests", "run-build", "run-lint", "inspect-diff"]);

function completionCriteria(steps: Set<StepKind>): string[] {
  const out: string[] = [];
  if (steps.has("inspect-ci")) out.push("The CI-equivalent command succeeds locally where it can be reproduced.");
  if (steps.has("run-tests")) out.push("Relevant tests pass.");
  if (steps.has("run-build")) out.push("Build or typecheck succeeds.");
  if (steps.has("run-lint")) out.push("Linter passes.");
  if (steps.has("inspect-diff") || steps.has("inspect-git")) out.push("Repository state and the final diff have been reviewed; the diff contains only intended changes.");
  if (steps.has("submit-review")) out.push("The review is posted with concrete findings, or explicitly states that none were found.");
  if (steps.has("summarize")) out.push("A summary states the root cause (or findings), what changed, and how it was verified.");
  return out;
}

function topTerms(instances: WorkflowInstance[], limit = 6): string[] {
  const df = new Map<string, number>();
  for (const inst of instances) for (const t of new Set(inst.primary.intents)) df.set(t, (df.get(t) ?? 0) + 1);
  return [...df]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

function evidenceFor(inst: WorkflowInstance, slug: string): Evidence {
  const t = inst.primary;
  const actions = t.displaySteps.slice(0, 12);
  if (t.outcome.summarized) actions.push("summarize");
  return {
    sessionId: t.sessionId,
    source: t.source,
    date: t.startedAt,
    project: t.projectName,
    excerpt: t.excerpt,
    actions,
    verified: t.outcome.verified,
    duplicates: inst.merged.length,
    sourceFile: t.sourceFile,
    tokens: t.usage ? totalTokens(t.usage) : undefined,
    toolCalls: t.toolCalls,
    usedSkill: usedSkill(t, slug) || undefined,
  };
}

export function analyze(traces: WorkflowTrace[]): Analysis {
  const { instances, stats: dedup } = deduplicate(traces);
  const candidates = instances.filter((i) => !isGenericTrace(i.primary));
  const clusters = clusterTraces(candidates.map((i) => i.primary), CLUSTER_THRESHOLD);
  debug("clusters formed", { candidates: candidates.length, clusters: clusters.length });

  const suggestions: Suggestion[] = [];
  const usedSlugs = new Set<string>();
  for (const cluster of clusters) {
    if (cluster.members.length < MIN_INSTANCES) continue;
    // Behavior alone is not enough: the requests must also share a purpose, and vice versa.
    if (cluster.intentCohesion < MIN_INTENT_COHESION || cluster.actionCohesion < MIN_ACTION_COHESION) continue;
    const group = cluster.members.map((i) => candidates[i]!);
    const steps = consensusSteps(group);
    const stepKinds = new Set(steps.map((s) => s.kind));
    if (stepKinds.size - (stepKinds.has("summarize") ? 1 : 0) < 3) continue;

    const terms = topTerms(group);
    const fileCats = new Set(group.flatMap((g) => g.primary.fileCategories));
    const family = FAMILIES.filter((f) => f.requires(stepKinds, fileCats))
      .map((f) => ({ f, score: f.terms.filter((t) => terms.includes(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.f;

    const fallbackTerms = terms.slice(0, 3);
    const baseSlug = family?.slug ?? toSlug(fallbackTerms.join(" ") || steps.map((s) => s.kind).slice(0, 2).join(" "));
    let slug = baseSlug;
    for (let k = 2; usedSlugs.has(slug); k++) slug = `${baseSlug}-${k}`;
    usedSlugs.add(slug);

    const repos = [...new Set(group.map((g) => g.primary.projectHash ?? g.id))];
    const repoNames = [...new Set(group.map((g) => g.primary.projectName).filter((x): x is string => !!x))].sort();
    const sources: Partial<Record<SourceId, number>> = {};
    for (const id of SOURCE_IDS) {
      const count = group.filter((g) => g.primary.source === id).length;
      if (count) sources[id] = count;
    }
    const dates = group.map((g) => g.primary.startedAt).filter((d): d is string => !!d).sort();
    const verifiedRate = group.filter((g) => g.primary.outcome.verified).length / group.length;
    const durations = group
      .map((g) => (g.primary.startedAt && g.primary.endedAt ? (Date.parse(g.primary.endedAt) - Date.parse(g.primary.startedAt)) / 60000 : NaN))
      .filter((m) => Number.isFinite(m) && m > 0);
    const consensus = steps.reduce((acc, s) => acc + s.support, 0) / steps.length;
    const confidence =
      0.3 * Math.min(1, cluster.cohesion / 0.75) +
      0.2 * Math.min(1, group.length / 6) +
      0.15 * Math.min(1, repos.length / 3) +
      0.2 * consensus +
      0.15 * verifiedRate;

    const notes: string[] = [];
    if (repos.length === 1) notes.push("All evidence comes from a single repository; the skill may be repository-specific.");
    if (group.length < 5) notes.push(`Only ${group.length} independent instances; treat as an early signal.`);
    if (Object.keys(sources).length === 1) notes.push("Observed with one coding agent only.");
    if (verifiedRate < 1) notes.push(`${group.length - group.filter((g) => g.primary.outcome.verified).length} of ${group.length} instances did not end with a passing check.`);
    if (!family) notes.push("No known workflow family matched; the name is derived from common request terms.");

    suggestions.push({
      slug,
      title: family?.title ?? `Repeated workflow: ${fallbackTerms.join(", ") || slug}`,
      description: family?.description ?? `Repeated workflow involving ${steps.map((s) => s.label).slice(0, 3).join(", ")}.`,
      whenToUse: family?.whenToUse ?? `Use for requests similar to: ${terms.slice(0, 5).join(", ")}.`,
      confidence: Math.round(confidence * 100) / 100,
      cohesion: Math.round(cluster.cohesion * 100) / 100,
      instances: group.length,
      records: group.reduce((acc, g) => acc + 1 + g.merged.length, 0),
      repositories: repoNames,
      sources,
      firstSeen: dates[0],
      lastSeen: dates[dates.length - 1],
      steps,
      completion: completionCriteria(stepKinds),
      topTerms: terms,
      evidence: group.map((g) => evidenceFor(g, slug)).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
      notes,
      verifiedRate: Math.round(verifiedRate * 100) / 100,
      medianMinutes: median(durations),
      sourceSessions: group.flatMap((g) => [g.primary.sessionId, ...g.merged.map((m) => m.sessionId)]),
      cost: workflowCost(group.map((g) => g.primary).filter((t) => !usedSkill(t, slug))),
    });
  }

  suggestions.sort((a, b) => b.confidence - a.confidence || b.instances - a.instances);
  const stats: AnalysisStats = {
    traces: traces.length,
    dedup,
    generic: instances.length - candidates.length,
    candidates: candidates.length,
    clusters: clusters.length,
    recurrent: suggestions.length,
  };
  debug("suggestions produced", { count: suggestions.length });
  return { suggestions, stats };
}
