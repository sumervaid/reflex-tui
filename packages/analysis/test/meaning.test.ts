import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { ALL_SESSIONS, LONG_PREAMBLE, SPEED_UP } from "@reflex/test-fixtures";
import { loadEmbedder } from "@reflex/embeddings";
import { intentSimilarities } from "../src/cluster";
import { CONTEXT_CHARS, contextDocument, contextHash, dotProduct, sessionContext } from "../src/context";
import { intentTerms } from "../src/intents";
import { analyze } from "../src/suggest";
import { buildTrace } from "../src/trace";
import { fixtureSessions, fixtureTraces } from "./helpers";

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

  it("reads the request well past the 180-character display excerpt", () => {
    const request = `${"context ".repeat(40)}then make the checkout page load faster`;
    const t = { excerpt: request.slice(0, 180), fileCategories: [] };
    expect(contextDocument(t, request)).toContain("checkout page load faster");
    expect(contextDocument(t)).not.toContain("checkout");
  });

  it("stops at the model's input budget", () => {
    const doc = contextDocument({ excerpt: "", fileCategories: [] }, "word ".repeat(1000));
    expect(doc.length).toBeLessThanOrEqual(CONTEXT_CHARS);
  });

  it("keys sessions that share an opening but differ later by different hashes, without storing the text", async () => {
    const sessions = await fixtureSessions(LONG_PREAMBLE);
    const traces = sessions.map(buildTrace);
    expect(new Set(traces.map((t) => t.excerpt.slice(0, 170))).size).toBe(1);
    expect(new Set(traces.map((t) => t.contextHash)).size).toBe(traces.length);
    traces.forEach((t, i) => expect(t.contextHash).toBe(contextHash(sessionContext(sessions[i]!, t))));
    for (const t of traces) expect(JSON.stringify(t)).not.toContain("getUserById to findUser");
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
    const v = await embedder.embed(all.map((t) => contextDocument(t)));
    const vectors = new Map(all.map((t, i) => [t.sessionId, v[i]!]));
    const lexical = summary(all);
    const withMeaning = summary(all, vectors);
    for (const s of lexical) expect(withMeaning).toContain(s);
    const speed = analyze(all, { vectors }).suggestions.filter((s) => s.evidence.some((e) => SPEED_UP.some((f) => e.excerpt.startsWith(f.prompt.slice(0, 20)))));
    expect(speed).toHaveLength(1);
    expect(speed[0]!.instances).toBe(4);
  });
});

describe.skipIf(!modelDir)("long requests (real model)", () => {
  it("tells tasks apart that only differ after a shared opening", async () => {
    const embedder = await loadEmbedder(modelDir!);
    const sessions = await fixtureSessions(LONG_PREAMBLE);
    const traces = sessions.map(buildTrace);
    const task = (i: number) => (/^pre-rename/.test(LONG_PREAMBLE.find((f) => sessions[i]!.requests[0]!.text.endsWith(f.prompt.slice(-20)))!.key) ? "rename" : "perf");
    const mean = (docs: string[]) =>
      embedder.embed(docs).then((v) => {
        const same: number[] = [];
        const diff: number[] = [];
        for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) (task(i) === task(j) ? same : diff).push(dotProduct(v[i]!, v[j]!));
        const avg = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
        return { same: avg(same), diff: avg(diff) };
      });
    const excerptOnly = await mean(traces.map((t) => contextDocument(t)));
    expect(excerptOnly.same - excerptOnly.diff).toBeLessThan(0.01);
    const longer = await mean(sessions.map((s, i) => sessionContext(s, traces[i]!)));
    expect(longer.same - longer.diff).toBeGreaterThan(0.08);
  });
});
