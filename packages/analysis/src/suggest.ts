import type { ActionCategory, SourceId, WorkflowTrace } from "@reflex/core";
import { SOURCE_IDS, debug, totalTokens } from "@reflex/core";
import { toSlug } from "@reflex/safety";
import { FAMILIES } from "./catalog";
import { clusterTraces } from "./cluster";
import type { SessionVectors } from "./context";
import { type DedupStats, type WorkflowInstance, deduplicate } from "./dedup";
import { MODIFY_TARGET_LABEL, STEP_TEXT, type StepKind } from "./steps";
import { type Constraint, recurringCorrections } from "./corrections";
import { type WorkflowCost, median, workflowCost } from "./impact";
import { isGenericTrace, usedSkill } from "./trace";
import { fillerWeights } from "./fillers";
import { DEVELOPER_WORDS, stem } from "./intents";
import { isGenericWord } from "./languages";
import { DEFAULT_MATCHING, type MatchingSettings, isDefaultMatching, thresholds } from "./matching";

export const MIN_INSTANCES = DEFAULT_MATCHING.sessions;
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

/**
 * Words that steer the agent reading the skill, or touch secrets and permissions. Unsafe in either
 * direction: "don't ask for confirmation" is as bad as "ignore previous instructions".
 */
const STEERING =
  /\b(ignore|disregard|override|bypass|instructions?|prompts?|system|previous|jailbreak|hesitate|forget|pretend|secrets?|tokens?|passwords?|passwd|credentials?|keys?|env|dotenv|ssh|permissions?|approv\w*|confirm\w*|ask|tell|root|admin|no-verify|dangerously[\w-]*)\b/i;
const MAX_CONSTRAINTS = 5;

/** Prohibiting a risky command is worth keeping; telling the agent to run one is not. */
export function isSafeConstraint(c: Pick<Constraint, "polarity" | "text">): boolean {
  if (c.text.length > 80 || STEERING.test(c.text)) return false;
  return c.polarity === "avoid" || !UNSAFE_EXAMPLE.test(c.text.toLowerCase());
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
  /** Corrections built from the words at least two independent sessions shared. */
  constraints?: Constraint[];
  /** The matching settings it was found with, when they differ from the defaults. */
  matching?: MatchingSettings;
};

/** A repeated workflow most of whose sessions already loaded skills you have: not suggested again. */
export type CoveredWorkflow = {
  title: string;
  instances: number;
  /** Your skills those sessions loaded, most used first. */
  skills: Array<{ name: string; sessions: number }>;
};

export type AnalysisStats = {
  traces: number;
  dedup: DedupStats;
  generic: number;
  candidates: number;
  clusters: number;
  recurrent: number;
  /** Repeated workflows your own skills already handle. Optional in analyses saved before it existed. */
  covered?: CoveredWorkflow[];
  /** Skills a repeated workflow loaded that are not specific to it (general guidance); they never cover one. */
  generalSkills?: string[];
};

export type Analysis = { suggestions: Suggestion[]; stats: AnalysisStats };

/** A workflow counts as covered when at least this share of its sessions loaded one of your skills. */
const COVERED_SHARE = 0.5;
/**
 * A skill covers a workflow only if it is specific to it: loaded at least this many times as often
 * in the workflow's sessions as in all other sessions. General guidance (house rules, thinking
 * aids) loads about as often everywhere and never covers one.
 */
const SPECIFIC_LIFT = 2;

/** Skill names a session loaded, without plugin prefixes ("tools:review-pr" -> "review-pr"). */
const loadedSkills = (t: WorkflowTrace): string[] => (t.skillsUsed ?? []).map((s) => s.replace(/^.*:/, ""));

export function consensusSteps(instances: WorkflowInstance[]): ConsensusStep[] {
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
      // A command that failed is not one to repeat: often a wrong guess before the one that worked.
      if (c.failed) continue;
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

/** Request terms most of a cluster's sessions share, most frequent first: used to recognize known workflow families. */
function frequentTerms(instances: WorkflowInstance[], limit = 6): string[] {
  const df = new Map<string, number>();
  for (const inst of instances) for (const t of new Set(inst.primary.intents)) df.set(t, (df.get(t) ?? 0) + 1);
  return [...df]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/** How many sessions of the whole history use each term, and which terms the history shows to be filler. */
export type TermContext = { sessions: number; df: ReadonlyMap<string, number>; fillers: ReadonlyMap<string, number> };

export function termContext(traces: WorkflowTrace[]): TermContext {
  const df = new Map<string, number>();
  for (const t of traces) for (const term of new Set(t.intents)) df.set(term, (df.get(term) ?? 0) + 1);
  return { sessions: traces.length, df, fillers: fillerWeights(traces) };
}

/**
 * Terms that set a cluster apart, for its name and "use for requests like" line: shared by at
 * least two of its sessions and rare in the rest of the history (TF-IDF), scaled down as far as
 * the history shows a term to be filler; words generic in any language and path fragments left
 * out; one surface form per stem ("dependency" and "depend" count once).
 */
export function distinctiveTerms(instances: WorkflowInstance[], ctx: TermContext, limit = 6): string[] {
  const inCluster = new Map<string, number>();
  for (const inst of instances) for (const t of new Set(inst.primary.intents)) inCluster.set(t, (inCluster.get(t) ?? 0) + 1);
  const scored = [...inCluster]
    .filter(([t, c]) => c >= 2 && !isGenericWord(t, DEVELOPER_WORDS))
    .map(([t, c]) => [t, (c / instances.length) * Math.log((ctx.sessions + 1) / ((ctx.df.get(t) ?? 0) + 1)) * (ctx.fillers.get(t) ?? 1)] as const)
    // A term in nearly every session of the history sets nothing apart.
    .filter(([, score]) => score > 0.05)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [t] of scored) {
    const key = stem(t).slice(0, Math.max(4, stem(t).length - 3));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length === limit) break;
  }
  return out;
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

export type AnalyzeOptions = {
  /** Sentence vectors of session context documents (see `contextDocument`). Optional. */
  vectors?: SessionVectors;
  /** Skills Reflex generated: loading one of these does not make a workflow "covered by your skills". */
  ownSkills?: ReadonlySet<string>;
  /**
   * Skill folder names in your agents' skill folders. When given, only these can cover a workflow,
   * so a plugin's skill (which `reflex improve` cannot edit) never hides a suggestion.
   */
  userSkills?: ReadonlySet<string>;
  /** Sessions needed and strictness (`reflex settings matching`); the defaults when absent. */
  matching?: MatchingSettings;
};

export function analyze(traces: WorkflowTrace[], opts: AnalyzeOptions = {}): Analysis {
  const { instances, stats: dedup } = deduplicate(traces);
  const candidates = instances.filter((i) => !isGenericTrace(i.primary));
  const matching = opts.matching ?? DEFAULT_MATCHING;
  const bar = thresholds(matching.strictness);
  const clusters = clusterTraces(candidates.map((i) => i.primary), bar.cluster, opts.vectors, bar.intentLink);
  const context = termContext(candidates.map((i) => i.primary));
  debug("clusters formed", { candidates: candidates.length, clusters: clusters.length });

  const suggestions: Suggestion[] = [];
  const covered: CoveredWorkflow[] = [];
  const skillsOf = (i: WorkflowInstance): Set<string> => new Set([i.primary, ...i.merged].flatMap(loadedSkills));
  const loads = new Map<string, number>();
  for (const i of instances) for (const s of skillsOf(i)) loads.set(s, (loads.get(s) ?? 0) + 1);
  const general = new Set<string>();
  const usedSlugs = new Set<string>();
  for (const cluster of clusters) {
    if (cluster.members.length < matching.sessions) continue;
    // Behavior alone is not enough: the requests must also share a purpose, and vice versa.
    if (cluster.intentCohesion < bar.intentCohesion || cluster.actionCohesion < MIN_ACTION_COHESION) continue;
    const group = cluster.members.map((i) => candidates[i]!);
    const steps = consensusSteps(group);
    const stepKinds = new Set(steps.map((s) => s.kind));
    if (stepKinds.size - (stepKinds.has("summarize") ? 1 : 0) < 3) continue;

    const terms = distinctiveTerms(group, context);
    const frequent = frequentTerms(group);
    const fileCats = new Set(group.flatMap((g) => g.primary.fileCategories));
    const family = FAMILIES.filter((f) => f.requires(stepKinds, fileCats))
      .map((f) => ({ f, score: f.terms.filter((t) => frequent.includes(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.f;

    const fallbackTerms = terms.slice(0, 3);
    const baseSlug = family?.slug ?? toSlug(fallbackTerms.join(" ") || steps.map((s) => s.kind).slice(0, 2).join(" "));

    // Your own skills already run this workflow: improve those instead of adding a duplicate.
    const inside = new Map<string, number>();
    for (const g of group) for (const s of skillsOf(g)) inside.set(s, (inside.get(s) ?? 0) + 1);
    const rest = Math.max(1, instances.length - group.length);
    const specific = new Set(
      [...inside].filter(([s, n]) => {
        const lift = n / group.length / Math.max(((loads.get(s) ?? 0) - n) / rest, 1 / rest);
        if (lift < SPECIFIC_LIFT) general.add(s);
        return lift >= SPECIFIC_LIFT;
      }).map(([s]) => s),
    );
    const yours = (g: WorkflowInstance) => [...skillsOf(g)].filter((s) => !opts.ownSkills?.has(s) && (!opts.userSkills || opts.userSkills.has(s)) && specific.has(s));
    const withYours = group.filter((g) => yours(g).length);
    if (withYours.length >= COVERED_SHARE * group.length) {
      const counts = new Map<string, number>();
      for (const g of withYours) for (const s of yours(g)) counts.set(s, (counts.get(s) ?? 0) + 1);
      covered.push({
        title: family?.title ?? `Repeated workflow: ${fallbackTerms.join(", ") || baseSlug}`,
        instances: group.length,
        skills: [...counts].map(([name, sessions]) => ({ name, sessions })).sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)),
      });
      continue;
    }

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
      constraints: recurringCorrections(group.map((g) => g.primary.corrections ?? []))
        .filter(isSafeConstraint)
        .slice(0, MAX_CONSTRAINTS),
      ...(isDefaultMatching(matching) ? {} : { matching }),
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
    covered,
    generalSkills: [...general].sort(),
  };
  debug("suggestions produced", { count: suggestions.length });
  return { suggestions, stats };
}
