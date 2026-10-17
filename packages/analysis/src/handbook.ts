import type { ActionCategory, SourceId, WorkflowTrace } from "@reflex/core";
import { shortHash } from "@reflex/core";
import { recurringCorrectionsBySession } from "./corrections";
import { type WorkflowInstance, deduplicate } from "./dedup";
import { stem } from "./intents";
import { isSafeConstraint, isSafeExample } from "./suggest";

/**
 * The handbook: how work is done in each repository, learned from past agent sessions. Every
 * practice keeps the sessions behind it, so a person or an agent can see where it came from.
 * Built on demand from stored traces; nothing here is written anywhere.
 */

export type PracticeKind = "rule" | "command";

/** A session behind a practice. `request` is the redacted, truncated first request. */
export type PracticeSource = { date?: string; tool: SourceId; request: string };

export type Practice = {
  /** Stable across scans while the practice holds: kind, scope and wording. */
  id: string;
  kind: PracticeKind;
  /** Repository the practice belongs to; absent for practices seen across repositories. */
  project?: { name?: string; hash: string };
  text: string;
  /** The situation it applies to, "when changing dependencies". */
  when?: string;
  /** Independent sessions behind it. */
  sessions: number;
  /** Start of the most recent of those sessions. */
  last?: string;
  /** Up to `MAX_SOURCES` of those sessions, newest first. */
  sources: PracticeSource[];
};

export const MAX_SOURCES = 5;
/** A command becomes a practice once it worked in this many sessions of a repository. */
const MIN_COMMAND_SESSIONS = 2;
/** A situation qualifies a rule when it is in this share of the rule's sessions... */
const WHEN_SHARE = 2 / 3;
/** ...and at least this many times as common there as in the scope's other sessions. */
const WHEN_LIFT = 2;

const SITUATIONS: Array<{ category: string; when: string; words: string[] }> = [
  { category: "dependency-manifest", when: "when changing dependencies", words: ["dependency", "package", "install", "lockfile", "upgrade"] },
  { category: "migration", when: "when changing the database schema", words: ["migration", "schema", "database", "db", "sql"] },
  { category: "ci-config", when: "when working on CI", words: ["ci", "pipeline", "workflow", "github", "action"] },
  { category: "test", when: "when writing or changing tests", words: ["test", "spec"] },
  { category: "config", when: "when changing configuration", words: ["config", "configuration", "setting"] },
  { category: "docs", when: "when editing docs", words: ["doc", "readme", "documentation"] },
];

const VERIFY: Array<{ action: ActionCategory; label: string; words: string[] }> = [
  { action: "run-tests", label: "Run tests with", words: ["test", "spec", "unit", "e2e"] },
  { action: "run-build", label: "Build or typecheck with", words: ["build", "compile", "typecheck", "type", "tsc"] },
  { action: "run-lint", label: "Lint with", words: ["lint", "format", "style", "prettier", "eslint"] },
];

const projectOf = (i: WorkflowInstance) => i.primary.projectHash;
const time = (t: WorkflowTrace) => (t.startedAt ? Date.parse(t.startedAt) || 0 : 0);

function sourcesOf(group: WorkflowInstance[]): Pick<Practice, "last" | "sources"> {
  const newest = [...group].sort((a, b) => time(b.primary) - time(a.primary));
  return {
    last: newest[0]?.primary.startedAt,
    sources: newest.slice(0, MAX_SOURCES).map((i) => ({ date: i.primary.startedAt, tool: i.primary.source, request: i.primary.excerpt })),
  };
}

function scopeOf(group: WorkflowInstance[]): Practice["project"] {
  const hashes = new Set(group.map(projectOf));
  if (hashes.size !== 1) return undefined;
  const hash = [...hashes][0];
  return hash ? { name: group[0]!.primary.projectName, hash } : undefined;
}

/** The situation a rule's sessions share and the scope's other sessions mostly don't. */
function situation(group: WorkflowInstance[], others: WorkflowInstance[]): string | undefined {
  const count = (xs: WorkflowInstance[], cat: string) => xs.filter((i) => i.primary.fileCategories.includes(cat)).length;
  let best: { when: string; lift: number } | undefined;
  for (const s of SITUATIONS) {
    const inside = count(group, s.category) / group.length;
    if (inside < WHEN_SHARE) continue;
    // Smoothed, so a scope with few (or no) other sessions neither blocks nor inflates the comparison.
    const lift = inside / ((count(others, s.category) + 0.5) / (others.length + 1));
    if (lift >= WHEN_LIFT && (!best || lift > best.lift)) best = { when: s.when, lift };
  }
  return best?.when;
}

function rules(instances: WorkflowInstance[], forgotten: ReadonlySet<string>): Practice[] {
  const out: Practice[] = [];
  for (const r of recurringCorrectionsBySession(instances.map((i) => i.primary.corrections ?? []))) {
    // Agents read these: the same filter as a skill's constraints keeps steering text out.
    if (forgotten.has(r.text) || !isSafeConstraint(r)) continue;
    const group = r.instances.map((k) => instances[k]!);
    const project = scopeOf(group);
    const members = new Set(group);
    const others = instances.filter((i) => !members.has(i) && (!project || projectOf(i) === project.hash));
    const when = situation(group, others);
    out.push({ id: practiceId("rule", project?.hash, r.text), kind: "rule", project, text: r.text, when, sessions: r.sessions, ...sourcesOf(group) });
  }
  return out;
}

function commands(instances: WorkflowInstance[]): Practice[] {
  const byProject = new Map<string, WorkflowInstance[]>();
  for (const i of instances) {
    const h = projectOf(i);
    if (h) byProject.set(h, [...(byProject.get(h) ?? []), i]);
  }
  const out: Practice[] = [];
  for (const [hash, group] of byProject) {
    for (const v of VERIFY) {
      // Per command: sessions where it ran without failing, and sessions where it only failed.
      const worked = new Map<string, WorkflowInstance[]>();
      const failed = new Map<string, number>();
      for (const i of group) {
        const runs = i.primary.commands.filter((c) => c.action === v.action);
        // Agents may run what this recommends, so only commands a skill could show as an example.
        for (const cmd of new Set(runs.map((c) => c.normalized).filter(isSafeExample))) {
          const same = runs.filter((c) => c.normalized === cmd);
          if (same.some((c) => !c.failed)) worked.set(cmd, [...(worked.get(cmd) ?? []), i]);
          else failed.set(cmd, (failed.get(cmd) ?? 0) + 1);
        }
      }
      const top = [...worked].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
      if (!top || top[1].length < MIN_COMMAND_SESSIONS) continue;
      const [cmd, sessions] = top;
      const notThis = [...failed]
        .filter(([other, n]) => other !== cmd && n >= MIN_COMMAND_SESSIONS && !worked.has(other))
        .sort((a, b) => b[1] - a[1])[0];
      const text = `${v.label} \`${cmd}\`.${notThis ? ` Not \`${notThis[0]}\`: it failed in ${notThis[1]} sessions.` : ""}`;
      out.push({
        id: practiceId("command", hash, `${v.action}:${cmd}`),
        kind: "command",
        project: { name: sessions[0]!.primary.projectName, hash },
        text,
        sessions: sessions.length,
        ...sourcesOf(sessions),
      });
    }
  }
  return out;
}

function practiceId(kind: PracticeKind, project: string | undefined, key: string): string {
  return shortHash(`${kind}|${project ?? "*"}|${key}`, 8);
}

export type HandbookOptions = {
  /** Rule texts the developer told Reflex to forget (`reflex memory forget`). */
  forgotten?: ReadonlySet<string>;
};

/** Every practice in the stored sessions, most-supported first. Copies, resumes and retries count once. */
export function buildHandbook(traces: WorkflowTrace[], opts: HandbookOptions = {}): Practice[] {
  const { instances } = deduplicate(traces);
  return [...commands(instances), ...rules(instances, opts.forgotten ?? new Set())].sort(
    (a, b) => b.sessions - a.sessions || a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text),
  );
}

/** Practices that apply in a repository: its own, then those seen across repositories. */
export function practicesFor(practices: Practice[], projectHash: string | undefined): Practice[] {
  return practices.filter((p) => !p.project || p.project.hash === projectHash).sort((a, b) => Number(!a.project) - Number(!b.project));
}

const QUESTION_FILLER = new Set(
  "a an the to it is are be do does did how what when where which who why we i you our my your here there this that in on of for with and or should can could would will".split(" "),
);

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9.-]+/)
      .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
      .filter((w) => w.length > 1 && !QUESTION_FILLER.has(w))
      .map(stem),
  );
}

function practiceTerms(p: Practice): Set<string> {
  const extra: string[] = [];
  for (const s of SITUATIONS) if (p.when === s.when) extra.push(...s.words);
  for (const v of VERIFY) if (p.text.startsWith(v.label)) extra.push(...v.words, "command", "run");
  // Command words split on spaces and punctuation: `pnpm test` matches "pnpm" and "test".
  return terms(`${p.text} ${p.when ?? ""} ${extra.join(" ")}`);
}

export type Answer = { practice: Practice; score: number };

/**
 * Practices that answer a question, best first. Word overlap with the practice and the situation it
 * applies to; the current repository's practices rank above ones from elsewhere. No model, no network.
 */
export function askHandbook(practices: Practice[], question: string, projectHash?: string, limit = 3): Answer[] {
  const q = terms(question);
  if (!q.size) return [];
  return practices
    .map((p) => {
      const t = practiceTerms(p);
      const hits = [...q].filter((w) => t.has(w)).length;
      const local = p.project ? (p.project.hash === projectHash ? 1.5 : 0.5) : 1;
      return { practice: p, score: (hits / q.size) * local };
    })
    .filter((a) => a.score > 0)
    .sort((a, b) => b.score - a.score || b.practice.sessions - a.practice.sessions)
    .slice(0, limit);
}
