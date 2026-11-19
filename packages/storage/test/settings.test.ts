import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Suggestion } from "@reflex/analysis";
import { Store } from "../src/db";

describe("matching settings", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-settings-"));
  });

  it("default to 3 sessions and default strictness, and keep what you set", () => {
    const store = new Store();
    try {
      expect(store.matchingSettings()).toEqual({ sessions: 3, strictness: "default" });
      store.setMatchingSettings({ sessions: 2, strictness: "looser" });
      expect(store.matchingSettings()).toEqual({ sessions: 2, strictness: "looser" });
      expect(() => store.setMatchingSettings({ sessions: 9, strictness: "looser" })).toThrow();
      expect(store.matchingSettings()).toEqual({ sessions: 2, strictness: "looser" });
    } finally {
      store.close();
    }
  });

  it("keep who set the bar and whether it is locked", () => {
    const store = new Store();
    try {
      store.setMatchingSettings({ sessions: 2, strictness: "looser", origin: "reflex", locked: true, decisionsSinceMove: 3 });
      expect(store.matchingSettings()).toEqual({ sessions: 2, strictness: "looser", origin: "reflex", locked: true, decisionsSinceMove: 3 });
    } finally {
      store.close();
    }
  });
});

describe("suggestion decisions", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-decisions-"));
  });

  const suggestion = (slug: string) => ({ slug, title: "Fix CI", steps: [], evidence: [] }) as unknown as Suggestion;

  it("store when each decision was made and why a rejection happened", () => {
    const store = new Store();
    try {
      store.saveSuggestions(1, [suggestion("a"), suggestion("b"), suggestion("c")]);
      store.setStatus("a", "approved");
      store.setStatus("b", "rejected", "wrong-grouping");
      store.setStatus("c", "rejected");
      const bySlug = Object.fromEntries(store.recentDecisions(10).map((d) => [d.slug, d]));
      expect(bySlug.a).toMatchObject({ status: "approved", rejectReason: undefined });
      expect(bySlug.b).toMatchObject({ status: "rejected", rejectReason: "wrong-grouping" });
      expect(bySlug.c).toMatchObject({ status: "rejected", rejectReason: "not-useful" });
      // Newest first: c was decided last.
      expect(store.recentDecisions(10).map((d) => d.slug)).toEqual(["c", "b", "a"]);
      // Approving later clears the reason but keeps the decision time.
      store.setStatus("b", "approved");
      expect(store.recentDecisions(10).find((d) => d.slug === "b")).toMatchObject({ status: "approved", rejectReason: undefined });
    } finally {
      store.close();
    }
  });

  it("keep decisions out of recentDecisions until one is made, even after a rescan", () => {
    const store = new Store();
    try {
      store.saveSuggestions(1, [suggestion("a")]);
      expect(store.recentDecisions(10)).toEqual([]);
      // A scan rewrites updated_at for every stored suggestion; decided_at must survive it.
      store.setStatus("a", "approved");
      store.saveSuggestions(2, [suggestion("a")]);
      expect(store.recentDecisions(10)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
