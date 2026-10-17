import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { EVAL_SESSIONS } from "@reflex/test-fixtures";
import { MIN_INTENT_LINK, clusterTraces, similarityMatrices } from "../src/cluster";
import { fixtureTraces } from "./helpers";

const WORDS = "login page slow cache build deploy lint test flaky api schema migration docs readme auth token release bump version refactor parser render table chart query index timeout retry upload image theme".split(" ");

/** `n` sessions drawn from `base`, each with a few extra request words: deterministic for a seed. */
function synthetic(base: WorkflowTrace[], n: number, seed: number, extraWords = 3): WorkflowTrace[] {
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, (_, i) => {
    const t = base[Math.floor(rand() * base.length)]!;
    const extra = Array.from({ length: extraWords }, () => WORDS[Math.floor(rand() * WORDS.length)]!);
    return { ...t, sessionId: `s${i}`, intents: [...t.intents, ...extra] };
  });
}

/** The straightforward merge loop: scan every pair for the best one, every merge. */
function referenceMembers(traces: WorkflowTrace[], threshold: number, minIntent: number): number[][] {
  const sim = similarityMatrices(traces);
  const n = traces.length;
  const link = sim.total.copy();
  const intentLink = sim.intent.copy();
  const members: (number[] | null)[] = traces.map((_, i) => [i]);
  for (;;) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        if (!members[i] || !members[j] || intentLink.get(i, j) < minIntent) continue;
        if (link.get(i, j) > best) [best, bi, bj] = [link.get(i, j), i, j];
      }
    if (bi < 0 || best < threshold) break;
    const [a, b] = [members[bi]!, members[bj]!];
    for (let k = 0; k < n; k++) {
      if (!members[k] || k === bi || k === bj) continue;
      link.set(bi, k, (a.length * link.get(bi, k) + b.length * link.get(bj, k)) / (a.length + b.length));
      intentLink.set(bi, k, (a.length * intentLink.get(bi, k) + b.length * intentLink.get(bj, k)) / (a.length + b.length));
    }
    members[bi] = [...a, ...b].sort((x, y) => x - y);
    members[bj] = null;
  }
  return members.filter((m): m is number[] => m !== null);
}

const key = (clusters: number[][]) => clusters.map((m) => m.join(",")).sort();

describe("clustering at scale", async () => {
  const fixtures = await fixtureTraces();
  const evalSessions = await fixtureTraces(EVAL_SESSIONS);

  for (const [name, traces] of [
    ["fixtures", fixtures],
    ["eval set", evalSessions],
    ["exact copies, so every link ties", synthetic(fixtures, 120, 7, 0)],
    ["300 varied sessions", synthetic([...fixtures, ...evalSessions], 300, 3)],
  ] as const) {
    it(`merges exactly as scanning every pair does: ${name}`, () => {
      for (const threshold of [0.3, 0.45, 0.6])
        for (const minIntent of [0, MIN_INTENT_LINK]) {
          const fast = clusterTraces(traces, threshold, undefined, minIntent).map((c) => c.members);
          expect(key(fast)).toEqual(key(referenceMembers(traces, threshold, minIntent)));
        }
    });
  }

  it("clusters 2,000 sessions in well under a minute", () => {
    const traces = synthetic(fixtures, 2000, 1);
    const start = performance.now();
    const clusters = clusterTraces(traces);
    expect(performance.now() - start).toBeLessThan(20_000);
    expect(clusters.reduce((n, c) => n + c.members.length, 0)).toBe(2000);
  }, 60_000);
});
