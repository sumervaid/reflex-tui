import { type SourceId, type WorkflowTrace, costOf } from "@reflex/core";
import { EMBEDDING_FLOOR, intentSimilarities } from "./cluster";
import { type SessionVectors, contextDocument, withFloor } from "./context";
import { concepts, intentTerms } from "./intents";

/** A model needs this many sessions of a kind of task before it can be picked. */
export const ROUTE_MIN_SUPPORT = 3;
/** A pick may need fixing this much more often (per request) than the most reliable model. */
export const ROUTE_MARGIN = 0.05;
/** Sources whose sessions carry priced tokens and whose CLI takes a model: the ones Reflex can route. */
export const ROUTABLE_SOURCES: readonly SourceId[] = ["claude-code", "codex"];
/** The most exploration a user can turn on: half of eligible runs. */
export const MAX_EXPLORE = 0.5;

export type TaskKind = { key: string; name: string };

export const TASK_KINDS: readonly TaskKind[] = [
  { key: "review", name: "Code review" },
  { key: "ci", name: "CI and builds" },
  { key: "debug", name: "Debugging" },
  { key: "feature", name: "Features and tests" },
  { key: "edit", name: "Edits" },
  { key: "research", name: "Research" },
  { key: "explore", name: "Questions and exploration" },
];
const KIND = Object.fromEntries(TASK_KINDS.map((k) => [k.key, k])) as Record<string, TaskKind>;

/** What kind of task a session was, from what the agent did. */
export function taskKind(t: Pick<WorkflowTrace, "actionSequence" | "outcome">): TaskKind {
  const a = new Set(t.actionSequence);
  const modified = [...a].some((x) => x.startsWith("modify-"));
  if (a.has("inspect-pr") || a.has("submit-review")) return KIND.review!;
  if (a.has("inspect-ci") || a.has("modify-ci")) return KIND.ci!;
  if (modified && t.outcome.recoveredFromFailure) return KIND.debug!;
  if (modified && (a.has("modify-tests") || a.has("run-tests"))) return KIND.feature!;
  if (modified) return KIND.edit!;
  if (a.has("research")) return KIND.research!;
  return KIND.explore!;
}

/** How often a session needed fixing: your corrections, failed tool calls and immediately repeated commands, per request you typed. */
export function friction(t: Pick<WorkflowTrace, "commands" | "corrections" | "toolErrors" | "requests">): number {
  const cmds = t.commands.map((c) => c.normalized);
  const repeats = cmds.filter((c, i) => i > 0 && c === cmds[i - 1]).length;
  return ((t.corrections?.length ?? 0) + (t.toolErrors ?? 0) + repeats) / Math.max(1, t.requests ?? 1);
}

/** The model a session mostly ran on (the one that cost the most) and the session's cost at list prices. */
export function sessionModel(t: Pick<WorkflowTrace, "usageByModel">): { model: string; usd: number } | undefined {
  const { cost, byModel } = costOf(t.usageByModel);
  const model = Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]?.[0];
  return model && cost ? { model, usd: cost.usd } : undefined;
}

/** One tool and model, and how its sessions of one kind of task went. */
export type ArmStats = { source: SourceId; model: string; sessions: number; usd: number; friction: number };
export type KindStats = { kind: TaskKind; sessions: number; arms: ArmStats[] };

const armKey = (source: string, model: string): string => `${source}\n${model}`;

function stats(rows: Array<{ source: SourceId; model: string; usd: number; friction: number }>): ArmStats[] {
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(armKey(r.source, r.model), [...(by.get(armKey(r.source, r.model)) ?? []), r]);
  return [...by.values()]
    .map((rs) => ({
      source: rs[0]!.source,
      model: rs[0]!.model,
      sessions: rs.length,
      usd: rs.reduce((a, r) => a + r.usd, 0) / rs.length,
      friction: rs.reduce((a, r) => a + r.friction, 0) / rs.length,
    }))
    .sort((a, b) => b.sessions - a.sessions || a.usd - b.usd);
}

/** Priced sessions of routable sources grouped by kind of task, then by tool and model. Most sessions first. */
export function routingTable(traces: WorkflowTrace[]): KindStats[] {
  const rows = new Map<string, Array<{ source: SourceId; model: string; usd: number; friction: number }>>();
  const seen = new Set<string>();
  for (const t of traces) {
    if (!ROUTABLE_SOURCES.includes(t.source) || seen.has(t.sessionId)) continue;
    seen.add(t.sessionId);
    const m = sessionModel(t);
    if (!m) continue;
    const k = taskKind(t).key;
    rows.set(k, [...(rows.get(k) ?? []), { source: t.source, model: m.model, usd: m.usd, friction: friction(t) }]);
  }
  return [...rows]
    .map(([key, rs]) => ({ kind: KIND[key]!, sessions: rs.length, arms: stats(rs) }))
    .sort((a, b) => b.sessions - a.sessions);
}

export type ArmPick = {
  /** The pick; when `learning`, the most used arm (nothing is known to beat it yet). */
  arm?: ArmStats;
  /** Fewer than two arms have enough sessions to compare. */
  learning: boolean;
  /** Lowest friction among arms with enough sessions. */
  best?: number;
};

/** The cheapest arm with enough sessions that needed fixing about as rarely as the most reliable one. */
export function pickArm(arms: ArmStats[]): ArmPick {
  const eligible = arms.filter((a) => a.sessions >= ROUTE_MIN_SUPPORT);
  if (!eligible.length) return { arm: arms[0], learning: true };
  const best = Math.min(...eligible.map((a) => a.friction));
  const arm = eligible.filter((a) => a.friction <= best + ROUTE_MARGIN + 1e-9).sort((a, b) => a.usd - b.usd)[0]!;
  return { arm, learning: eligible.length < 2, best };
}

/** How many past sessions vote on a new request's kind of task. */
const NEIGHBORS = 7;
/** Intent similarity a past session needs to vote. */
const MIN_MATCH = 0.2;

export type KindGuess = {
  kind?: TaskKind;
  /** Share of the vote the winning kind got (0..1). */
  confidence: number;
  /** Past sessions that voted. */
  neighbors: number;
  /** `history`: your similar past sessions voted; `words`: no similar session, guessed from the request's words. */
  via: "history" | "words" | "none";
};

const CONCEPT_KIND: Record<string, string> = {
  review: "review",
  ci: "ci",
  build: "ci",
  lint: "ci",
  failure: "debug",
  logs: "debug",
  test: "feature",
  feature: "feature",
  refactor: "edit",
  docs: "edit",
  migration: "edit",
  explain: "explore",
};

/**
 * The kind of task a new request is, before any work happens: the kinds of your most similar past
 * sessions (same intent similarity as clustering, by meaning too when vectors are given), weighted
 * by similarity. Without a similar session, a guess from the request's words.
 */
export function classifyRequest(request: string, traces: WorkflowTrace[], opts: { vectors?: SessionVectors; requestVector?: ArrayLike<number> } = {}): KindGuess {
  const probe = { sessionId: "\0request", intents: intentTerms(request) } as WorkflowTrace;
  const all = [probe, ...traces];
  const vectors =
    opts.requestVector && opts.vectors ? withFloor(new Map([...opts.vectors, [probe.sessionId, opts.requestVector]]), opts.vectors.floor ?? EMBEDDING_FLOOR) : opts.vectors;
  const sim = intentSimilarities(all, vectors);
  const near = traces
    .map((t, i) => ({ t, s: sim(0, i + 1) }))
    .filter((x) => x.s >= MIN_MATCH)
    .sort((a, b) => b.s - a.s)
    .slice(0, NEIGHBORS);
  if (near.length) {
    const votes = new Map<string, number>();
    for (const { t, s } of near) votes.set(taskKind(t).key, (votes.get(taskKind(t).key) ?? 0) + s);
    const [key, w] = [...votes].sort((a, b) => b[1] - a[1])[0]!;
    const total = [...votes.values()].reduce((a, b) => a + b, 0);
    return { kind: KIND[key], confidence: w / total, neighbors: near.length, via: "history" };
  }
  const c = [...concepts(probe.intents)].filter(([k]) => CONCEPT_KIND[k]).sort((a, b) => b[1] - a[1])[0];
  return c ? { kind: KIND[CONCEPT_KIND[c[0]]!], confidence: 0, neighbors: 0, via: "words" } : { confidence: 0, neighbors: 0, via: "none" };
}

/** The text a request is embedded as, matching how sessions are embedded (see `contextDocument`). */
export const requestDocument = (request: string): string => contextDocument({ excerpt: "", fileCategories: [] }, request);

export type RouterSettings = {
  /** `reflex run` starts on the pick without asking. */
  autopilot: boolean;
  /** Share of eligible runs that try another model you have used (0 = off). */
  explore: number;
  /** Kinds of task that are never explored. */
  protect: string[];
};

export const DEFAULT_ROUTER_SETTINGS: RouterSettings = { autopilot: false, explore: 0, protect: [] };

export type RouteDecision = {
  guess: KindGuess;
  source: SourceId;
  /** Undefined: start the tool on its own default model. */
  model?: string;
  /** `pick`: the router's pick. `learning`: too few sessions to compare, so the model you use most. `explore`: a randomized try of another model. `default`: no evidence. */
  mode: "pick" | "learning" | "explore" | "default";
  /** The exploration coin was flipped for this run, so it belongs to the randomized comparison. */
  randomized: boolean;
  /** The arm the router would pick without exploration. */
  pick?: ArmStats;
  /** Every arm for this kind on the allowed sources. */
  arms: ArmStats[];
};

/**
 * Where a new request should run. `sources` are the tools allowed for this run (installed, or the
 * one asked for), in order of preference. With exploration on and the kind not protected, a share
 * of runs (chosen at random, so the comparison stays fair) tries the model you have used least on
 * this kind of task among the models you already use with that tool.
 */
export function chooseRoute(
  guess: KindGuess,
  table: KindStats[],
  opts: { sources: readonly SourceId[]; settings: RouterSettings; random: () => number },
): RouteDecision {
  const fallback = opts.sources[0] ?? "claude-code";
  const allowed = (a: ArmStats) => opts.sources.includes(a.source);
  const arms = (guess.kind ? table.find((k) => k.kind.key === guess.kind!.key)?.arms ?? [] : []).filter(allowed);
  const p = pickArm(arms);
  const base: Omit<RouteDecision, "source" | "mode"> = { guess, randomized: false, pick: p.arm, arms };

  const explore = Math.min(MAX_EXPLORE, Math.max(0, opts.settings.explore));
  if (guess.kind && p.arm && explore > 0 && !opts.settings.protect.includes(guess.kind.key)) {
    const source = p.arm.source;
    const known = new Set(table.flatMap((k) => k.arms).filter((a) => a.source === source).map((a) => a.model));
    const here = (m: string) => arms.find((a) => a.source === source && a.model === m)?.sessions ?? 0;
    const candidates = [...known].filter((m) => m !== p.arm!.model);
    if (candidates.length) {
      const flip = opts.random() < explore;
      if (flip) {
        const model = candidates.sort((a, b) => here(a) - here(b) || a.localeCompare(b))[0]!;
        return { ...base, randomized: true, source: p.arm.source, model, mode: "explore" };
      }
      return { ...base, randomized: true, source: p.arm.source, model: p.arm.model, mode: p.learning ? "learning" : "pick" };
    }
  }
  if (p.arm) return { ...base, source: p.arm.source, model: p.arm.model, mode: p.learning ? "learning" : "pick" };
  return { ...base, source: fallback, mode: "default" };
}

/** A `reflex run`, as stored: never the request text. */
export type RouteRun = {
  at: string;
  source: SourceId;
  model?: string;
  kind?: string;
  /** `manual`: the user named the model. */
  mode: RouteDecision["mode"] | "manual";
  randomized: boolean;
  /** Native session id when Reflex chose it (Claude Code `--session-id`). */
  nativeId?: string;
  project?: string;
  /** Your answer when the agent exited: did it get the job done? Absent when skipped. */
  outcome?: "done" | "not-done";
};

/**
 * What a session on `model` with `source` usually costs, from your sessions of every kind: an exact
 * model id first, else the most used model whose id contains it (so `sonnet` matches
 * `claude-sonnet-5-5`). Undefined without history.
 */
export function typicalCost(table: KindStats[], source: SourceId, model: string): { model: string; usd: number; sessions: number } | undefined {
  const by = new Map<string, { usd: number; sessions: number }>();
  for (const k of table)
    for (const a of k.arms) {
      if (a.source !== source) continue;
      const m = by.get(a.model) ?? { usd: 0, sessions: 0 };
      by.set(a.model, { usd: m.usd + a.usd * a.sessions, sessions: m.sessions + a.sessions });
    }
  const lower = model.toLowerCase();
  const hit = by.has(model) ? model : [...by].filter(([m]) => m.toLowerCase().includes(lower)).sort((a, b) => b[1].sessions - a[1].sessions)[0]?.[0];
  const s = hit ? by.get(hit) : undefined;
  return hit && s ? { model: hit, usd: s.usd / s.sessions, sessions: s.sessions } : undefined;
}

/** How long after a run its session may start (Codex sessions are matched by time and folder). */
const LINK_WINDOW_MS = 10 * 60 * 1000;

/** Each run with the session it started, when a scan has read it. */
export function linkRuns(runs: RouteRun[], traces: WorkflowTrace[]): Array<{ run: RouteRun; trace?: WorkflowTrace }> {
  const byId = new Map(traces.map((t) => [t.sessionId, t]));
  const used = new Set<string>();
  return runs.map((run) => {
    if (run.nativeId) {
      const t = byId.get(`${run.source}:${run.nativeId}`);
      if (t) used.add(t.sessionId);
      return { run, trace: t };
    }
    const at = Date.parse(run.at);
    const t = traces
      .filter((x) => x.source === run.source && !used.has(x.sessionId) && x.startedAt && (!run.project || x.projectName === run.project))
      .map((x) => ({ x, d: Date.parse(x.startedAt!) - at }))
      .filter(({ d }) => d >= -5_000 && d <= LINK_WINDOW_MS)
      .sort((a, b) => a.d - b.d)[0]?.x;
    if (t) used.add(t.sessionId);
    return { run, trace: t };
  });
}

/** One `reflex bench` run: one model on one task in a fresh copy of the repository, scored by the user's check. */
export type BenchResult = {
  at: string;
  /** Runs of the same task share a batch, so models are compared on identical work. */
  batch: string;
  source: SourceId;
  model: string;
  kind?: string;
  project?: string;
  pass: boolean;
  usd?: number;
  turns?: number;
  durationMs: number;
  timedOut: boolean;
};

export type BenchArm = { model: string; runs: number; passed: number; usd?: number; durationMs: number };
export type BenchKind = { kind?: TaskKind; batches: number; arms: BenchArm[] };

/** Bench results per kind of task and model: pass rate, average cost and time. Best pass rate first, then cheapest. */
export function benchSummary(results: BenchResult[]): BenchKind[] {
  const kinds = new Map<string, BenchResult[]>();
  for (const r of results) kinds.set(r.kind ?? "", [...(kinds.get(r.kind ?? "") ?? []), r]);
  return [...kinds].map(([key, rs]) => {
    const by = new Map<string, BenchResult[]>();
    for (const r of rs) by.set(r.model, [...(by.get(r.model) ?? []), r]);
    const arms = [...by].map(([model, xs]) => {
      const priced = xs.filter((x) => x.usd !== undefined);
      return {
        model,
        runs: xs.length,
        passed: xs.filter((x) => x.pass).length,
        usd: priced.length ? priced.reduce((a, x) => a + x.usd!, 0) / priced.length : undefined,
        durationMs: xs.reduce((a, x) => a + x.durationMs, 0) / xs.length,
      };
    });
    arms.sort((a, b) => b.passed / b.runs - a.passed / a.runs || (a.usd ?? Infinity) - (b.usd ?? Infinity));
    return { kind: KIND[key], batches: new Set(rs.map((r) => r.batch)).size, arms };
  });
}

export type TrialArm = {
  model: string;
  explored: boolean;
  runs: number;
  /** Runs whose session a scan has read. */
  measured: number;
  usd?: number;
  friction?: number;
  /** Runs you answered after the agent exited, and how many of those got the job done. */
  rated: number;
  done: number;
};
export type Trial = { kind: TaskKind; runs: number; arms: TrialArm[] };

/**
 * The randomized comparison: only runs where the exploration coin was flipped, so the explored and
 * picked runs come from the same mix of tasks. Per kind of task and model: runs, how many have a
 * scanned session, and their average cost and friction.
 */
export function trials(linked: Array<{ run: RouteRun; trace?: WorkflowTrace }>): Trial[] {
  const out = new Map<string, Map<string, { model: string; explored: boolean; runs: number; usd: number[]; friction: number[]; rated: number; done: number }>>();
  for (const { run, trace } of linked) {
    if (!run.randomized || !run.kind || !run.model || !KIND[run.kind]) continue;
    const arms = out.get(run.kind) ?? new Map();
    out.set(run.kind, arms);
    const key = `${run.mode === "explore"}\n${run.model}`;
    const a = arms.get(key) ?? { model: run.model, explored: run.mode === "explore", runs: 0, usd: [], friction: [], rated: 0, done: 0 };
    arms.set(key, a);
    a.runs++;
    if (run.outcome) a.rated++;
    if (run.outcome === "done") a.done++;
    const m = trace && sessionModel(trace);
    if (trace && m) {
      a.usd.push(m.usd);
      a.friction.push(friction(trace));
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  return [...out].map(([key, arms]) => {
    const list = [...arms.values()].map((a) => ({
      model: a.model,
      explored: a.explored,
      runs: a.runs,
      measured: a.usd.length,
      usd: mean(a.usd),
      friction: mean(a.friction),
      rated: a.rated,
      done: a.done,
    }));
    return { kind: KIND[key]!, runs: list.reduce((s, a) => s + a.runs, 0), arms: list.sort((a, b) => Number(a.explored) - Number(b.explored) || b.runs - a.runs) };
  });
}
