import type { WorkflowTrace } from "@reflex/core";
import { type Constraint, recurringCorrections } from "./corrections";
import { deduplicate } from "./dedup";
import { type WorkflowCost, workflowCost } from "./impact";
import { STEP_TEXT, type StepKind } from "./steps";
import { type ConsensusStep, consensusSteps, isSafeConstraint } from "./suggest";
import { usedSkill } from "./trace";

/** A step the skill names counts as rarely taken when fewer than this share of its sessions took it. */
const STALE_BELOW = 0.25;
const MAX_CONSTRAINTS = 5;
/** Sessions that loaded a skill before Reflex has anything to say about it. */
export const MIN_REVIEW_SESSIONS = 2;

/**
 * How a skill's own text names each kind of step. Matching is deliberately loose: a skill that
 * mentions tests at all is taken to cover running them.
 */
const MENTIONS: Partial<Record<StepKind, RegExp>> = {
  "inspect-git": /\bgit (status|log|branch)\b|\brepository state\b|\bcurrent branch\b/,
  "inspect-diff": /\bdiff\b/,
  "inspect-ci": /\bci\b|\bworkflow run\b|\bgithub actions\b|\bpipeline\b|\bgh run\b|\bfailing (job|check)s?\b/,
  "inspect-pr": /\bpull request\b|\bpr\b|\bgh pr\b/,
  "inspect-logs": /\blogs?\b|\bstack ?traces?\b/,
  "inspect-dependencies": /\bdependenc(y|ies)\b|\bpackage\.json\b|\block ?file\b|\bmanifest\b/,
  "install-dependencies": /\binstall\b/,
  "run-tests": /\btests?\b|\bspecs?\b/,
  "run-build": /\bbuild\b|\btypecheck\b|\bcompile\b|\btsc\b/,
  "run-lint": /\blint(er|ing)?\b|\beslint\b|\bprettier\b|\bformat(ter)?\b/,
  "modify-code": /\b(fix|patch|edit|change|update|modify|implement)\b/,
  "modify-tests": /\btests?\b/,
  "modify-config": /\bconfig(uration)?\b/,
  "modify-ci": /\bci\b|\bworkflow\b/,
  "modify-dependencies": /\bdependenc(y|ies)\b|\bversion\b|\bpin\b/,
  "apply-fix": /\b(fix|patch|edit|change|update|modify)\b/,
  "reproduce-failure": /\breproduc/,
  "submit-review": /\breview\b|\bcomments?\b/,
  commit: /\bcommit/,
  push: /\bpush/,
  research: /\bdocs?\b|\bdocumentation\b|\blook up\b/,
  summarize: /\bsummar|\breport\b|\bexplain\b/,
};

/** Steps every session does, which say nothing about a particular skill. */
const GENERIC: ReadonlySet<StepKind> = new Set(["inspect-code", "search-code", "run-command", "inspect-repository"]);

const mentions = (text: string, kind: StepKind): boolean => MENTIONS[kind]?.test(text) ?? false;

export type SkillReview = {
  skill: string;
  /** Independent sessions that loaded the skill. */
  sessions: number;
  verifiedRate: number;
  /** Sessions with at least one follow-up correction from you. */
  corrected: number;
  toolErrorsPerSession: number;
  cost: WorkflowCost;
  /** Steps most of those sessions took that the skill does not mention. */
  missing: ConsensusStep[];
  /** Steps the skill mentions that fewer than a quarter of those sessions took. */
  rarelyTaken: Array<{ kind: StepKind; label: string; share: number }>;
  /** Corrections you repeated in at least two of those sessions that the skill does not already say. */
  constraints: Constraint[];
};

/**
 * Compare a skill's text with what happened in the sessions that loaded it. Only counts and
 * Reflex's own step wording come out of this: no transcript text, and nothing from the skill file
 * except whether it names a step.
 */
export function reviewSkill(skill: string, content: string, traces: WorkflowTrace[]): SkillReview {
  const instances = deduplicate(traces).instances.filter((i) => [i.primary, ...i.merged].some((t) => usedSkill(t, skill)));
  const runs = instances.map((i) => i.primary);
  const n = runs.length;
  const text = content.toLowerCase();
  const base = {
    skill,
    sessions: n,
    verifiedRate: n ? runs.filter((t) => t.outcome.verified).length / n : 0,
    corrected: runs.filter((t) => (t.corrections?.length ?? 0) > 0).length,
    toolErrorsPerSession: n ? runs.reduce((a, t) => a + (t.toolErrors ?? 0), 0) / n : 0,
    cost: workflowCost(runs),
  };
  if (n < MIN_REVIEW_SESSIONS) return { ...base, missing: [], rarelyTaken: [], constraints: [] };

  const missing = consensusSteps(instances).filter((s) => !GENERIC.has(s.kind) && MENTIONS[s.kind] && !mentions(text, s.kind));

  const share = (kind: StepKind) =>
    runs.filter((t) => (kind === "apply-fix" ? t.actionSequence.some((a) => a.startsWith("modify-")) : t.actionSequence.includes(kind as never))).length / n;
  const rarelyTaken = (Object.keys(MENTIONS) as StepKind[])
    .filter((k) => !GENERIC.has(k) && !k.startsWith("modify-") && k !== "summarize" && mentions(text, k) && share(k) < STALE_BELOW)
    .map((k) => ({ kind: k, label: STEP_TEXT[k].label, share: share(k) }));

  const constraints = recurringCorrections(runs.map((t) => t.corrections ?? []))
    .filter(isSafeConstraint)
    .filter((c) => !c.text.toLowerCase().split(/\s+/).every((w) => w.length < 3 || text.includes(w)))
    .slice(0, MAX_CONSTRAINTS);

  return { ...base, missing, rarelyTaken, constraints };
}
