import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Suggestion } from "@reflex/analysis";
import { Store } from "@reflex/storage";
import { adjustBar, evidenceFirst, FIRST_DECISIONS, reject, renderImpactPreview, renderSuggestion } from "../src/commands/review";
import { settingsMatching } from "../src/commands/settings";

// Tests run without a TTY, so `reflex reject` records its default reason ("not useful to me").

const suggestion = (slug: string) => ({ slug, title: "Fix CI", steps: [], evidence: [] }) as unknown as Suggestion;

describe("the learned bar", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-review-"));
  });

  function storeWithSuggestions(): Store {
    const store = new Store();
    store.saveSuggestions(1, ["a", "b", "c", "d", "e"].map(suggestion));
    return store;
  }

  it("moves a step looser after enough approvals, and says so", async () => {
    const store = storeWithSuggestions();
    try {
      for (const slug of ["a", "b", "c", "d"]) {
        store.setStatus(slug, "approved");
        adjustBar(store);
      }
      await reject("e");
      const matching = store.matchingSettings();
      expect(matching).toMatchObject({ sessions: 3, strictness: "looser", origin: "reflex", decisionsSinceMove: 0 });
    } finally {
      store.close();
    }
  });

  it("does not move before there are enough decisions", async () => {
    const store = storeWithSuggestions();
    try {
      for (const slug of ["a", "b", "c"]) {
        store.setStatus(slug, "approved");
        adjustBar(store);
      }
      await reject("d");
      expect(store.matchingSettings()).toMatchObject({ sessions: 3, strictness: "default", decisionsSinceMove: 4 });
    } finally {
      store.close();
    }
  });

  it("stops learning once the user has set matching themselves", async () => {
    const store = storeWithSuggestions();
    try {
      store.setMatchingSettings({ sessions: 3, strictness: "default", origin: "user" });
      for (const slug of ["a", "b", "c", "d"]) {
        store.setStatus(slug, "approved");
        adjustBar(store);
      }
      await reject("e");
      expect(store.matchingSettings()).toMatchObject({ sessions: 3, strictness: "default", origin: "user" });
    } finally {
      store.close();
    }
  });

  it("stops learning when the bar is locked", () => {
    const store = storeWithSuggestions();
    try {
      store.setMatchingSettings({ sessions: 3, strictness: "default", locked: true });
      for (const slug of ["a", "b", "c", "d"]) store.setStatus(slug, "approved");
      adjustBar(store);
      expect(store.matchingSettings()).toMatchObject({ sessions: 3, strictness: "default", locked: true });
    } finally {
      store.close();
    }
  });

  it("hands the bar back to Reflex on --reset", async () => {
    const store = storeWithSuggestions();
    try {
      store.setMatchingSettings({ sessions: 4, strictness: "stricter", origin: "user", locked: true });
      await settingsMatching({ reset: true });
      expect(store.matchingSettings()).toMatchObject({ sessions: 3, strictness: "default", origin: "reflex", locked: false });
    } finally {
      store.close();
    }
  });
});

describe("evidence and impact in the review flow", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-evidence-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const evidence = (date: string, project: string, excerpt: string, tokens = 12_000) => ({
    sessionId: date + project,
    source: "claude-code",
    date,
    project,
    excerpt,
    actions: ["inspect CI", "patch", "run tests"],
    verified: true,
    duplicates: 0,
    sourceFile: "/tmp/a.jsonl",
    tokens,
    toolCalls: 40,
  });

  const full = {
    slug: "fix-ci",
    title: "Fix the failing CI run",
    description: "d",
    whenToUse: "w",
    confidence: 0.8,
    cohesion: 0.9,
    instances: 4,
    records: 5,
    repositories: ["billing-api"],
    sources: { "claude-code": 4 },
    steps: [{ label: "run the tests", support: 1, examples: [] }],
    completion: [],
    topTerms: ["ci"],
    notes: [],
    verifiedRate: 0.75,
    evidence: [evidence("2026-11-12T10:00:00Z", "billing-api", "the CI run is red again, fix the flaky test"), evidence("2026-11-13T10:00:00Z", "billing-api", "red CI, same flake as yesterday"), evidence("2026-11-14T10:00:00Z", "billing-api", "flake again")],
    cost: { runs: 4, runsWithTokens: 4, medianTokens: 12_000, medianToolCalls: 40 },
  } as unknown as Suggestion;

  function printed(fn: () => void): string {
    let text = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      text += String(chunk);
      return true;
    });
    fn();
    return text;
  }

  it("the suggest list shows the moments behind a suggestion, not only counts", () => {
    const text = printed(() => renderSuggestion({ rank: 1, slug: "fix-ci", status: "pending", data: full }));
    expect(text).toContain("Moments");
    expect(text).toContain("Nov 12, billing-api");
    expect(text).toContain("the CI run is red again");
    expect(text).toContain("+1 more session");
    expect(text).toContain("reflex evidence 1");
  });

  it("the impact preview says what approving would change, with the sessions and their costs", () => {
    const text = printed(() => renderImpactPreview(full));
    expect(text).toContain("What approving would change");
    expect(text).toContain("would have applied to 4 past sessions");
    expect(text).toContain("median 12.0k tokens");
    expect(text).toContain("Evidence for fix-ci");
    expect(text).toContain("40 tool calls");
  });

  it("evidence opens by default until a few decisions are made, then collapses", () => {
    const store = new Store();
    try {
      store.saveSuggestions(1, ["a", "b", "c", "d"].map(suggestion));
      expect(evidenceFirst(store)).toBe(true);
      for (let i = 0; i < FIRST_DECISIONS; i++) store.setStatus(["a", "b", "c"][i]!, "approved");
      expect(store.recentDecisions(FIRST_DECISIONS)).toHaveLength(FIRST_DECISIONS);
      expect(evidenceFirst(store)).toBe(false);
    } finally {
      store.close();
    }
  });
});
