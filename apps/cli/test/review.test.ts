import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Suggestion } from "@reflex/analysis";
import { Store } from "@reflex/storage";
import { adjustBar, reject } from "../src/commands/review";
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
