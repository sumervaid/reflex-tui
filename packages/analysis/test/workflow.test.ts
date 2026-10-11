import { describe, expect, it } from "vitest";
import type { NormalizedSession, WorkflowTrace } from "@reflix/core";
import { DEBUG_DEPENDENCY, EXPLAIN_CI, FIX_CI, ONE_OFFS, REVIEW_PR, type FixtureSession } from "@reflix/test-fixtures";
import { analyze } from "../src/suggest";
import { deduplicate } from "../src/dedup";
import { buildTrace } from "../src/trace";
import { demoTraces } from "./helpers";

const keyOf = (t: { excerpt: string }) => t.excerpt;

describe("workflow detection on demo history", () => {
  it("groups differently-worded CI requests with the same behavior into one workflow", async () => {
    const { suggestions } = analyze(await demoTraces());
    const ci = suggestions.find((s) => s.slug === "fix-ci");
    expect(ci).toBeDefined();
    expect(ci!.instances).toBe(6);
    expect(ci!.repositories).toEqual(["acme-web", "billing-api", "mobile-app"]);
    expect(ci!.sources).toEqual({ "claude-code": 4, codex: 2 });
    const excerpts = ci!.evidence.map(keyOf).join("\n");
    for (const s of FIX_CI.filter((f) => f.key !== "ci-1-retry")) expect(excerpts).toContain(s.prompt.slice(0, 20));
  });

  it("keeps similar wording with different behavior out of the CI workflow", async () => {
    const { suggestions } = analyze(await demoTraces());
    const ci = suggestions.find((s) => s.slug === "fix-ci")!;
    const excerpts = ci.evidence.map(keyOf).join("\n");
    for (const s of [...EXPLAIN_CI, ...DEBUG_DEPENDENCY]) expect(excerpts).not.toContain(s.prompt.slice(0, 24));
    const dep = suggestions.find((s) => s.slug === "debug-dependency")!;
    expect(dep.instances).toBe(4);
    expect(suggestions.find((s) => s.slug === "review-pr")!.instances).toBe(4);
  });

  it("never suggests one-off tasks or read-and-answer sessions", async () => {
    const { suggestions } = analyze(await demoTraces());
    expect(suggestions.map((s) => s.slug).sort()).toEqual(["debug-dependency", "fix-ci", "review-pr"]);
    const all = suggestions.flatMap((s) => s.evidence.map(keyOf)).join("\n");
    for (const s of [...ONE_OFFS, ...EXPLAIN_CI]) expect(all).not.toContain(s.prompt.slice(0, 24));
  });

  it("requires three independent sessions", async () => {
    const three = await demoTraces(REVIEW_PR.slice(0, 3));
    expect(analyze(three).suggestions).toHaveLength(1);
    const one = await demoTraces(REVIEW_PR.slice(0, 1));
    expect(analyze(one).suggestions).toHaveLength(0);
  });

  it("returns nothing when there is no recurrence", async () => {
    expect(analyze(await demoTraces(ONE_OFFS)).suggestions).toEqual([]);
    expect(analyze([]).suggestions).toEqual([]);
  });

  it("does not suggest generic behavior shared by unrelated requests", async () => {
    const generic: FixtureSession[] = ["add a dark mode toggle", "convert fetchOrders to async", "write a date formatter"].map((prompt, i) => ({
      key: `g${i}`,
      source: "claude-code",
      project: `p${i}`,
      daysAgo: i,
      prompt,
      steps: [{ read: "src/a.ts" }, { edit: "src/a.ts" }, { bash: "pnpm test" }],
      summary: "done",
    }));
    expect(analyze(await demoTraces(generic)).suggestions).toEqual([]);
  });

  it("does not copy secrets into evidence", async () => {
    const { suggestions } = analyze(await demoTraces());
    const text = JSON.stringify(suggestions);
    expect(text).not.toContain("npm_a1B2");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/Users/jordan");
  });
});

describe("deduplication", () => {
  const session = (id: string, at: string, project = "p1", text = "CI is failing on main, fix it"): NormalizedSession => ({
    id: `claude-code:${id}`,
    source: "claude-code",
    startedAt: at,
    endedAt: at,
    project: { name: project, pathHash: project },
    requests: [{ at, text }],
    events: [
      { kind: "user", at, text },
      { kind: "shell", at, command: "gh run view 1 --log-failed" },
      { kind: "shell", at, command: "pnpm install" },
      { kind: "file", at, op: "edit", path: "package.json" },
      { kind: "shell", at, command: "pnpm test" },
      { kind: "assistant", at, text: "fixed" },
    ],
    sourceRef: { file: `~/x/${id}.jsonl`, nativeId: id },
    skippedRecords: 0,
  });
  const traces = (...s: NormalizedSession[]): WorkflowTrace[] => s.map(buildTrace);

  it("same file read twice counts once", () => {
    const a = session("a", "2026-10-01T10:00:00.000Z");
    const { stats, instances } = deduplicate(traces(a, a));
    expect(stats.copies).toBe(1);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.merged).toHaveLength(1);
  });

  it("copied session with a new id counts once", () => {
    const a = session("a", "2026-10-01T10:00:00.000Z");
    const b = { ...session("b", "2026-10-01T10:00:00.000Z") };
    expect(deduplicate(traces(a, b)).instances).toHaveLength(1);
  });

  it("resumed session folds into the longer one", () => {
    const a = session("a", "2026-10-01T10:00:00.000Z");
    const resumed = session("r", "2026-10-01T10:00:00.000Z");
    resumed.events.push({ kind: "user", at: "2026-10-01T12:00:00.000Z", text: "also run e2e" }, { kind: "shell", at: "2026-10-01T12:00:00.000Z", command: "pnpm test:e2e" });
    resumed.requests.push({ at: "2026-10-01T12:00:00.000Z", text: "also run e2e" });
    const { stats, instances } = deduplicate(traces(a, resumed));
    expect(stats.resumed).toBe(1);
    expect(instances).toHaveLength(1);
    expect(instances[0]!.primary.sessionId).toBe("claude-code:r");
  });

  it("duplicated events inside a session do not change its identity", () => {
    const a = session("a", "2026-10-01T10:00:00.000Z");
    const b = session("a", "2026-10-01T10:00:00.000Z");
    b.events.splice(2, 0, b.events[1]!);
    expect(deduplicate(traces(a, b)).instances).toHaveLength(1);
  });

  it("a quick retry in the same repo is not independent evidence", () => {
    const a = session("a", "2026-10-01T10:00:00.000Z");
    const retry = session("b", "2026-10-01T10:40:00.000Z", "p1", "CI is still failing on main, fix it");
    expect(deduplicate(traces(a, retry)).stats.retries).toBe(1);
  });

  it("independent similar sessions stay separate", () => {
    const a = session("a", "2026-10-01T10:00:00.000Z");
    const b = session("b", "2026-10-03T09:00:00.000Z");
    const c = session("c", "2026-10-01T10:30:00.000Z", "p2");
    expect(deduplicate(traces(a, b, c)).instances).toHaveLength(3);
  });
});
