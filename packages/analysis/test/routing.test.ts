import { describe, expect, it } from "vitest";
import type { ActionCategory, SourceId, WorkflowTrace } from "@reflex/core";
import {
  DEFAULT_ROUTER_SETTINGS,
  type RouteRun,
  benchSummary,
  chooseRoute,
  classifyRequest,
  linkRuns,
  pickArm,
  routingTable,
  trials,
  typicalCost,
} from "../src/routing";
import { intentTerms } from "../src/intents";

type T = { id: string; source?: SourceId; model?: string; usd?: number; actions?: ActionCategory[]; text?: string; fixes?: number; at?: string; project?: string };

/** A priced trace: `usd` is paid as input tokens at the model's list price. */
function trace(o: T): WorkflowTrace {
  const perM = o.model?.includes("opus") ? 4 : o.model?.includes("sonnet") ? 2 : 5;
  const source = o.source ?? "claude-code";
  return {
    sessionId: `${source}:${o.id}`,
    source,
    startedAt: o.at,
    projectName: o.project,
    intents: intentTerms(o.text ?? "fix the failing ci job"),
    tools: [],
    commands: [],
    fileCategories: [],
    actionSequence: o.actions ?? ["inspect-ci", "modify-ci"],
    displaySteps: [],
    outcome: { verified: true, recoveredFromFailure: false, modified: true, summarized: false },
    excerpt: o.text ?? "fix the failing ci job",
    fingerprint: o.id,
    eventHashes: [],
    sourceFile: `${o.id}.jsonl`,
    usageByModel: o.model ? { [o.model]: { input: ((o.usd ?? 1) * 1e6) / perM, output: 0, cacheRead: 0, cacheWrite: 0 } } : undefined,
    requests: 1,
    toolErrors: o.fixes ?? 0,
  };
}

const ci = (n: number, model: string, usd: number, fixes = 0, source: SourceId = "claude-code") =>
  Array.from({ length: n }, (_, i) => trace({ id: `${model}-${i}`, model, usd, fixes, source }));

describe("routingTable and pickArm", () => {
  it("groups priced Claude Code and Codex sessions by kind and model, once per session", () => {
    const ts = [...ci(3, "claude-opus-5-5", 2), ...ci(1, "gpt-5.5", 1, 0, "codex"), trace({ id: "cur", source: "cursor" }), trace({ id: "unpriced" })];
    const table = routingTable([...ts, ts[0]!]);
    expect(table).toHaveLength(1);
    expect(table[0]!.kind.key).toBe("ci");
    expect(table[0]!.arms.map((a) => [a.source, a.model, a.sessions])).toEqual([
      ["claude-code", "claude-opus-5-5", 3],
      ["codex", "gpt-5.5", 1],
    ]);
    expect(table[0]!.arms[0]!.usd).toBeCloseTo(2);
  });

  it("picks the cheapest model about as reliable as the best, and learns until two can be compared", () => {
    const table = routingTable([...ci(3, "claude-opus-5-5", 2), ...ci(3, "claude-sonnet-5-5", 0.5, 0)]);
    expect(pickArm(table[0]!.arms)).toMatchObject({ arm: { model: "claude-sonnet-5-5" }, learning: false });
    const worse = routingTable([...ci(3, "claude-opus-5-5", 2), ...ci(3, "claude-sonnet-5-5", 0.5, 1)]);
    expect(pickArm(worse[0]!.arms).arm!.model).toBe("claude-opus-5-5");
    const thin = routingTable([...ci(3, "claude-opus-5-5", 2), ...ci(2, "claude-sonnet-5-5", 0.5)]);
    expect(pickArm(thin[0]!.arms)).toMatchObject({ arm: { model: "claude-opus-5-5" }, learning: true });
  });
});

describe("classifyRequest", () => {
  const history = [
    ...ci(3, "claude-opus-5-5", 2),
    ...Array.from({ length: 3 }, (_, i) =>
      trace({ id: `rev-${i}`, model: "claude-opus-5-5", text: "review the pull request comments", actions: ["inspect-pr", "submit-review"] }),
    ),
  ];

  it("votes with the most similar past sessions", () => {
    expect(classifyRequest("the ci job is failing again, fix it", history)).toMatchObject({ kind: { key: "ci" }, via: "history" });
    const r = classifyRequest("please review this pull request", history);
    expect(r).toMatchObject({ kind: { key: "review" }, via: "history" });
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it("falls back to the request's words, then to unknown", () => {
    expect(classifyRequest("explain how the scheduler works", [])).toMatchObject({ kind: { key: "explore" }, via: "words" });
    expect(classifyRequest("zzz qqq", [])).toEqual({ confidence: 0, neighbors: 0, via: "none" });
  });
});

describe("chooseRoute", () => {
  const table = routingTable([...ci(3, "claude-opus-5-5", 2), ...ci(3, "claude-sonnet-5-5", 0.5), ...ci(1, "claude-haiku-5-5", 0.1), ...ci(3, "gpt-5.5", 0.2, 0, "codex")]);
  const guess = { kind: { key: "ci", name: "CI and builds" }, confidence: 1, neighbors: 7, via: "history" as const };
  const sources = ["claude-code", "codex"] as const;
  const never = () => 0.99;
  const always = () => 0;

  it("takes the pick across allowed tools, or the tool's default without evidence", () => {
    expect(chooseRoute(guess, table, { sources, settings: DEFAULT_ROUTER_SETTINGS, random: always })).toMatchObject({ source: "codex", model: "gpt-5.5", mode: "pick", randomized: false });
    expect(chooseRoute(guess, table, { sources: ["claude-code"], settings: DEFAULT_ROUTER_SETTINGS, random: always })).toMatchObject({ model: "claude-sonnet-5-5", mode: "pick" });
    const unknown = { confidence: 0, neighbors: 0, via: "none" as const };
    expect(chooseRoute(unknown, table, { sources: ["claude-code"], settings: DEFAULT_ROUTER_SETTINGS, random: always })).toMatchObject({ source: "claude-code", mode: "default" });
    expect(chooseRoute(unknown, table, { sources: ["claude-code"], settings: DEFAULT_ROUTER_SETTINGS, random: always }).model).toBeUndefined();
  });

  it("explores at random within the pick's tool, least-tried model first, never on protected kinds", () => {
    const settings = { ...DEFAULT_ROUTER_SETTINGS, explore: 0.1 };
    const opts = { sources: ["claude-code"] as const, settings };
    expect(chooseRoute(guess, table, { ...opts, random: always })).toMatchObject({ model: "claude-haiku-5-5", mode: "explore", randomized: true });
    expect(chooseRoute(guess, table, { ...opts, random: never })).toMatchObject({ model: "claude-sonnet-5-5", mode: "pick", randomized: true });
    const guarded = { ...settings, protect: ["ci"] };
    expect(chooseRoute(guess, table, { sources: ["claude-code"], settings: guarded, random: always })).toMatchObject({ mode: "pick", randomized: false });
    // Exploration never leaves the tool and never picks a model you have not used with it.
    const codexOnly = chooseRoute(guess, table, { sources: ["codex"], settings, random: always });
    expect(codexOnly).toMatchObject({ source: "codex", model: "gpt-5.5", randomized: false });
  });
});

describe("linkRuns and trials", () => {
  const at = "2026-10-13T10:00:00.000Z";
  const later = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString();

  it("links Claude Code runs by session id and Codex runs by time and folder", () => {
    const traces = [
      trace({ id: "u1", model: "claude-opus-5-5" }),
      trace({ id: "c1", source: "codex", model: "gpt-5.5", at: later(20), project: "app" }),
      trace({ id: "c2", source: "codex", model: "gpt-5.5", at: later(5 * 3600), project: "app" }),
    ];
    const runs: RouteRun[] = [
      { at, source: "claude-code", model: "claude-opus-5-5", mode: "pick", randomized: true, nativeId: "u1", kind: "ci" },
      { at, source: "codex", model: "gpt-5.5", mode: "pick", randomized: false, project: "app", kind: "ci" },
      { at, source: "codex", model: "gpt-5.5", mode: "pick", randomized: false, project: "other" },
    ];
    expect(linkRuns(runs, traces).map((l) => l.trace?.sessionId)).toEqual(["claude-code:u1", "codex:c1", undefined]);
  });

  it("compares only randomized runs, explored and picked side by side", () => {
    const traces = [trace({ id: "a", model: "claude-opus-5-5", usd: 2 }), trace({ id: "b", model: "claude-sonnet-5-5", usd: 0.5, fixes: 1 })];
    const runs: RouteRun[] = [
      { at, source: "claude-code", model: "claude-opus-5-5", mode: "pick", randomized: true, nativeId: "a", kind: "ci" },
      { at, source: "claude-code", model: "claude-sonnet-5-5", mode: "explore", randomized: true, nativeId: "b", kind: "ci" },
      { at, source: "claude-code", model: "claude-opus-5-5", mode: "pick", randomized: false, nativeId: "x", kind: "ci" },
      { at, source: "claude-code", model: "claude-opus-5-5", mode: "pick", randomized: true, nativeId: "unscanned", kind: "ci" },
    ];
    runs[0]!.outcome = "done";
    runs[3]!.outcome = "not-done";
    const [t] = trials(linkRuns(runs, traces));
    expect(t!.runs).toBe(3);
    expect(t!.arms).toEqual([
      { model: "claude-opus-5-5", explored: false, runs: 2, measured: 1, usd: expect.closeTo(2), friction: 0, rated: 2, done: 1 },
      { model: "claude-sonnet-5-5", explored: true, runs: 1, measured: 1, usd: expect.closeTo(0.5), friction: 1, rated: 0, done: 0 },
    ]);
  });
});

describe("typicalCost", () => {
  it("averages a model's sessions across kinds, matching an alias to the most used full id", () => {
    const table = routingTable([
      ...ci(2, "claude-sonnet-5-5", 1),
      trace({ id: "edit", model: "claude-sonnet-5-5", usd: 4, actions: ["modify-code"] }),
      ...ci(1, "claude-sonnet-5", 9),
      ...ci(1, "gpt-5.5", 3, 0, "codex"),
    ]);
    expect(typicalCost(table, "claude-code", "claude-sonnet-5-5")).toEqual({ model: "claude-sonnet-5-5", usd: expect.closeTo(2), sessions: 3 });
    expect(typicalCost(table, "claude-code", "sonnet")!.model).toBe("claude-sonnet-5-5");
    expect(typicalCost(table, "claude-code", "gpt-5.5")).toBeUndefined();
    expect(typicalCost(table, "claude-code", "haiku")).toBeUndefined();
  });
});

describe("benchSummary", () => {
  it("ranks models by pass rate, then cost, per kind of task", () => {
    const r = (model: string, pass: boolean, usd?: number, batch = "b1") => ({ at: "", batch, source: "claude-code" as const, model, kind: "ci", pass, usd, durationMs: 1000, timedOut: false });
    const [k] = benchSummary([r("opus", true, 2), r("sonnet", true, 0.5), r("haiku", false, 0.1), r("opus", true, 2, "b2"), r("sonnet", false, 0.5, "b2")]);
    expect(k!.kind?.key).toBe("ci");
    expect(k!.batches).toBe(2);
    expect(k!.arms.map((a) => [a.model, a.passed, a.runs])).toEqual([
      ["opus", 2, 2],
      ["sonnet", 1, 2],
      ["haiku", 0, 1],
    ]);
  });
});
