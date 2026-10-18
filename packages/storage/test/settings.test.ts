import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
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
});
