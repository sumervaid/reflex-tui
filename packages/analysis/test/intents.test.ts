import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { intentSimilarities } from "../src/cluster";
import { bigrams, buildTfIdf, concepts, cosine, intentTerms, stem, termSimilarities } from "../src/intents";

describe("stemming", () => {
  it("folds inflections of the same word together", () => {
    const same = (...words: string[]) => expect(new Set(words.map(stem)).size).toBe(1);
    same("load", "loads", "loaded", "loading");
    same("change", "changes", "changed", "changing");
    same("cache", "cached", "caching");
    same("query", "queries");
    same("run", "running");
    same("install", "installed", "installing");
    same("pass", "passes", "passed");
    same("debug", "debugging");
  });

  it("leaves words that only look inflected alone", () => {
    for (const w of ["string", "thing", "need", "speed", "status", "class", "analysis", "add"]) {
      expect(stem(w)).toBe(w);
    }
    expect(stem("added")).toBe("add");
    expect(stem("ci")).toBe("ci");
    expect(stem("@tanstack/query")).toBe("@tanstack/query");
  });
});

describe("term similarity", () => {
  const sim = (...requests: string[]) => termSimilarities(requests.map(intentTerms));

  it("pairs adjacent stems into bigrams", () => {
    expect(bigrams(intentTerms("the login pages load slowly").map(stem))).toEqual(["login pag", "pag load", "load slowly"]);
  });

  it("matches requests that differ only in inflection", () => {
    const s = sim("checkout tests failing", "checkout test failed", "rename the user model");
    expect(s(0, 1)).toBeGreaterThan(0.99);
    expect(s(0, 2)).toBe(0);
  });

  it("scores a shared phrase above the same words scattered", () => {
    const s = sim("slow login page", "login page loads slowly", "page title wrong after login");
    expect(s(0, 1)).toBeGreaterThan(s(0, 2));
  });

  it("never scores below word overlap alone", () => {
    const requests = ["review the pr", "review changes on this branch", "leave review comments on the pr", "pr review"];
    const s = sim(...requests);
    const words = buildTfIdf(requests.map((r) => intentTerms(r).map(stem))).vectors;
    for (let i = 0; i < requests.length; i++) {
      for (let j = i + 1; j < requests.length; j++) expect(s(i, j)).toBeGreaterThanOrEqual(cosine(words[i]!, words[j]!));
    }
  });
});

describe("intent similarity", () => {
  const traces = (...requests: string[]) => requests.map((r) => ({ intents: intentTerms(r) }) as WorkflowTrace);

  it("recognizes lexicon words in inflected forms", () => {
    const sim = intentSimilarities(traces("address the reviewer comments", "reply to review comment", "update the readme"));
    expect(sim(0, 1)).toBeGreaterThan(sim(0, 2));
  });

  it("does not let stemming pull unrelated words into a concept", () => {
    // "works" is an explain word; "working" must not inherit it through its stem.
    expect(concepts(["working"]).size).toBe(0);
    expect([...concepts(["comments"]).keys()]).toEqual(["review"]);
  });
});
