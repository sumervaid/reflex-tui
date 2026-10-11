import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db";

describe("embedding cache", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-store-"));
  });

  it("round-trips vectors and prunes ones no longer needed", () => {
    const store = new Store();
    try {
      store.saveEmbeddings("m", [["a", Float32Array.of(0.5, -0.25)], ["b", Float32Array.of(1, 0)]]);
      expect(Array.from(store.embeddings(["a", "missing"]).get("a")!)).toEqual([0.5, -0.25]);
      expect(store.embeddings(["missing"]).size).toBe(0);
      store.pruneEmbeddings(["b"]);
      expect([...store.embeddings(["a", "b"]).keys()]).toEqual(["b"]);
    } finally {
      store.close();
    }
  });
});
