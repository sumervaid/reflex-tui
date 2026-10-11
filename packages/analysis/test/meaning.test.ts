import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { ALL_SESSIONS, SPEED_UP } from "@reflex/test-fixtures";
import { loadEmbedder } from "@reflex/embeddings";
import { intentSimilarities } from "../src/cluster";
import { contextDocument } from "../src/context";
import { intentTerms } from "../src/intents";
import { analyze } from "../src/suggest";
import { fixtureTraces } from "./helpers";

const DIM = 64;
const oneHot = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === k ? 1 : 0));
const isSpeedUp = (t: WorkflowTrace) => SPEED_UP.some((s) => t.excerpt.startsWith(s.prompt.slice(0, 20)));
const summary = (traces: WorkflowTrace[], vectors?: Map<string, Float32Array>) =>
  analyze(traces, { vectors }).suggestions.map((s) => `${s.instances}:${s.evidence.map((e) => e.sessionId).sort().join(",")}`).sort();

describe("context document", () => {
  it("holds the request and file kinds, not the action steps", () => {
    const doc = contextDocument({ excerpt: "CI is failing on main", fileCategories: ["ci-config", "dependency-manifest"], actionSequence: ["inspect-ci", "run-tests"] } as WorkflowTrace);
    expect(doc).toBe("CI is failing on main\nFiles: ci config, dependency manifest.");
  });
});

describe("meaning-based intent", () => {
  const traces = (...requests: string[]) => requests.map((r, i) => ({ sessionId: `s${i}`, intents: intentTerms(r) }) as WorkflowTrace);

  it("connects requests with no words in common when their meanings match", () => {
    const t = traces("make the login page load faster", "the invoice screen is really slow");
    expect(intentSimilarities(t)(0, 1)).toBe(0);
    const same = new Map([["s0", oneHot(0)], ["s1", oneHot(0)]]);
    expect(intentSimilarities(t, same)(0, 1)).toBe(1);
  });

  it("never lowers a lexical match", () => {
    const t = traces("checkout tests failing", "checkout test failed");
    const unrelated = new Map([["s0", oneHot(0)], ["s1", oneHot(1)]]);
    expect(intentSimilarities(t, unrelated)(0, 1)).toBe(intentSimilarities(t)(0, 1));
  });

  it("compares a session without a vector lexically", () => {
    const t = traces("make the login page load faster", "the invoice screen is really slow");
    expect(intentSimilarities(t, new Map([["s0", oneHot(0)]]))(0, 1)).toBe(0);
  });

  it("finds a workflow that is worded differently every time", async () => {
    const all = await fixtureTraces([...ALL_SESSIONS, ...SPEED_UP]);
    const lexical = summary(all);
    let k = 1;
    const vectors = new Map(all.map((t) => [t.sessionId, isSpeedUp(t) ? oneHot(0) : oneHot(k++ % DIM)]));
    const withMeaning = summary(all, vectors);
    expect(withMeaning).toHaveLength(lexical.length + 1);
    for (const s of lexical) expect(withMeaning).toContain(s);
    const speed = analyze(all, { vectors }).suggestions.find((s) => s.evidence.every((e) => SPEED_UP.some((f) => e.excerpt.startsWith(f.prompt.slice(0, 20)))));
    expect(speed?.instances).toBe(4);
  });

  it("changes nothing when no two sessions mean the same thing", async () => {
    const all = await fixtureTraces();
    const vectors = new Map(all.map((t, i) => [t.sessionId, oneHot(i % DIM)]));
    expect(summary(all, vectors)).toEqual(summary(all));
  });
});

const modelDir = process.env.REFLEX_TEST_MODEL_DIR;

describe.skipIf(!modelDir)("meaning-based detection (real model)", () => {
  it("adds the reworded workflow and keeps the existing ones", async () => {
    const embedder = await loadEmbedder(modelDir!);
    const all = await fixtureTraces([...ALL_SESSIONS, ...SPEED_UP]);
    const v = await embedder.embed(all.map(contextDocument));
    const vectors = new Map(all.map((t, i) => [t.sessionId, v[i]!]));
    const lexical = summary(all);
    const withMeaning = summary(all, vectors);
    for (const s of lexical) expect(withMeaning).toContain(s);
    const speed = analyze(all, { vectors }).suggestions.filter((s) => s.evidence.some((e) => SPEED_UP.some((f) => e.excerpt.startsWith(f.prompt.slice(0, 20)))));
    expect(speed).toHaveLength(1);
    expect(speed[0]!.instances).toBe(4);
  });
});
