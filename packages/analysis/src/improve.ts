import type { WorkflowTrace } from "@reflex/core";
import { type Constraint, recurringCorrections } from "./corrections";
import { deduplicate } from "./dedup";
import { type WorkflowCost, workflowCost } from "./impact";
import { type ArmStats, type ArmPick, friction, pickArm, sessionModel } from "./routing";
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

/** Headings that define what the skill produces. */
const OUTPUT_HEADING = /\b(output|format|response|reply|template|report|result|deliverable)s?\b/i;
export const FIXED_START = "<!-- reflex:fixed:start -->";
export const FIXED_END = "<!-- reflex:fixed:end -->";
/** Words of a correction that would change what the skill produces rather than how it gets there. */
const OUTPUT_WORDS = /\b(format|output|response|reply|summary|summaries|table|tables|heading|headings|markdown|json|bullet|bullets|section|sections|layout|template|style|tone|length)\b/i;

/** The parts of a skill that define its output: headings like "Output format", and anything between fixed markers. */
export function protectedSections(content: string): string[] {
  const out = content
    .split("\n")
    .map((l) => /^#{1,6}\s+(.+?)\s*$/.exec(l)?.[1])
    .filter((h): h is string => !!h && OUTPUT_HEADING.test(h));
  if (content.includes(FIXED_START)) out.push("sections marked fixed");
  return out;
}

export type ModelAdvice = {
  /** The model these sessions mostly ran on, and the router's pick for them. */
  most: ArmStats;
  pick: ArmStats;
  /** Saving per session at list prices when the pick replaces the most used model. */
  save: number;
};

export type SkillReview = {
  skill: string;
  /** Independent sessions that loaded the skill. */
  sessions: number;
  verifiedRate: number;
  /** Sessions with at least one follow-up correction from you. */
  corrected: number;
  toolErrorsPerSession: number;
  cost: WorkflowCost;
  /** Sections that define the output; nothing proposed may change them. */
  protected: string[];
  /** Faster: commands that worked for steps the skill already names, so the agent doesn't rediscover them. */
  commands: ConsensusStep[];
  /** Cheaper: the router's pick for these sessions, when it differs from the model they mostly used. */
  model?: ModelAdvice;
  /** Behavior: steps most of those sessions took that the skill does not mention. Opt-in. */
  missing: ConsensusStep[];
  /** Steps the skill names that fewer than a quarter of those sessions took. Reported, never removed. */
  rarelyTaken: Array<{ kind: StepKind; label: string; share: number }>;
  /** Behavior: corrections you repeated in at least two of those sessions that the skill doesn't say. Opt-in. */
  constraints: Constraint[];
};

/** The router's pick across every session that loaded the skill (they share one purpose). */
function modelAdvice(runs: WorkflowTrace[]): ModelAdvice | undefined {
  const by = new Map<string, ArmStats & { total: number; fixes: number }>();
  for (const t of runs) {
    const m = sessionModel(t);
    if (!m) continue;
    const key = `${t.source}\n${m.model}`;
    const a = by.get(key) ?? { source: t.source, model: m.model, sessions: 0, usd: 0, friction: 0, total: 0, fixes: 0 };
    a.sessions++;
    a.total += m.usd;
    a.fixes += friction(t);
    by.set(key, a);
  }
  const arms: ArmStats[] = [...by.values()]
    .map((a) => ({ source: a.source, model: a.model, sessions: a.sessions, usd: a.total / a.sessions, friction: a.fixes / a.sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.usd - b.usd);
  const p: ArmPick = pickArm(arms);
  const most = arms[0];
  if (!most || !p.arm || p.learning || p.arm === most) return undefined;
  return { most, pick: p.arm, save: Math.max(0, most.usd - p.arm.usd) };
}

/**
 * Compare a skill's text with what happened in the sessions that loaded it. Only counts and
 * Reflex's own step wording come out of this: no transcript text, and nothing from the skill file
 * except whether it names a step and which headings define its output.
 */
export function reviewSkill(skill: string, content: string, traces: WorkflowTrace[]): SkillReview {
  const instances = deduplicate(traces).instances.filter((i) => [i.primary, ...i.merged].some((t) => usedSkill(t, skill)));
  const runs = instances.map((i) => i.primary);
  const n = runs.length;
  const text = content.toLowerCase();
  const fixed = protectedSections(content);
  const base = {
    skill,
    sessions: n,
    verifiedRate: n ? runs.filter((t) => t.outcome.verified).length / n : 0,
    corrected: runs.filter((t) => (t.corrections?.length ?? 0) > 0).length,
    toolErrorsPerSession: n ? runs.reduce((a, t) => a + (t.toolErrors ?? 0), 0) / n : 0,
    cost: workflowCost(runs),
    protected: fixed,
  };
  if (n < MIN_REVIEW_SESSIONS) return { ...base, commands: [], missing: [], rarelyTaken: [], constraints: [] };

  const steps = consensusSteps(instances).filter((s) => !GENERIC.has(s.kind) && MENTIONS[s.kind]);
  const commands = steps
    .filter((s) => mentions(text, s.kind))
    .map((s) => ({ ...s, examples: s.examples.filter((e) => !text.includes(e.toLowerCase())) }))
    .filter((s) => s.examples.length);
  // A skill that fixes its output must not gain a step that writes one.
  const missing = steps.filter((s) => !mentions(text, s.kind) && !(fixed.length && s.kind === "summarize"));

  const share = (kind: StepKind) =>
    runs.filter((t) => (kind === "apply-fix" ? t.actionSequence.some((a) => a.startsWith("modify-")) : t.actionSequence.includes(kind as never))).length / n;
  const rarelyTaken = (Object.keys(MENTIONS) as StepKind[])
    .filter((k) => !GENERIC.has(k) && !k.startsWith("modify-") && k !== "summarize" && mentions(text, k) && share(k) < STALE_BELOW)
    .map((k) => ({ kind: k, label: STEP_TEXT[k].label, share: share(k) }));

  const constraints = recurringCorrections(runs.map((t) => t.corrections ?? []))
    .filter(isSafeConstraint)
    .filter((c) => !(fixed.length && OUTPUT_WORDS.test(c.text)))
    .filter((c) => !c.text.toLowerCase().split(/\s+/).every((w) => w.length < 3 || text.includes(w)))
    .slice(0, MAX_CONSTRAINTS);

  return { ...base, commands, model: modelAdvice(runs), missing, rarelyTaken, constraints };
}

/**
 * The structure of an answer, without its content: headings, table headers, list and code-block
 * layout, and top-level JSON keys. Two answers with the same shape follow the same format even when
 * the values (times, names, numbers) differ.
 */
export function outputShape(text: string): string[] {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      const v = JSON.parse(trimmed) as unknown;
      if (Array.isArray(v)) return ["json:array", ...(v[0] && typeof v[0] === "object" ? Object.keys(v[0] as object).sort().map((k) => `key:${k}`) : [])];
      if (v && typeof v === "object") return ["json:object", ...Object.keys(v).sort().map((k) => `key:${k}`)];
    } catch {
      /* not JSON: read it as markdown */
    }
  }
  const shape: string[] = [];
  let fence = false;
  let prev = "";
  for (const raw of trimmed.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*```/.test(line)) {
      shape.push(fence ? "code:end" : `code:${line.trim().slice(3).trim() || "text"}`);
      fence = !fence;
      prev = "";
      continue;
    }
    if (fence) continue;
    let kind = "";
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    // A heading's fixed part is before any colon ("Root cause: <varies>"); digits are values.
    if (h) kind = `h${h[1]!.length}:${h[2]!.split(":")[0]!.replace(/[\d.,/-]+/g, "#").trim().toLowerCase()}`;
    else if (/^\s*\|.*\|\s*$/.test(line)) kind = /^\s*\|[\s:|-]+\|\s*$/.test(line) ? "" : prev.startsWith("table") ? "table:row" : `table:${line.split("|").filter((c) => c.trim()).length}`;
    else if (/^\s*[-*+]\s+/.test(line)) kind = "list";
    else if (/^\s*\d+[.)]\s+/.test(line)) kind = "numbered";
    else if (/^\s*\*\*[^*]+\*\*:?/.test(line)) kind = `label:${/\*\*([^*]+)\*\*/.exec(line)![1]!.toLowerCase()}`;
    if (!kind || (kind === prev && (kind === "list" || kind === "numbered" || kind === "table:row"))) {
      if (kind) prev = kind;
      continue;
    }
    shape.push(kind);
    prev = kind;
  }
  return shape;
}
