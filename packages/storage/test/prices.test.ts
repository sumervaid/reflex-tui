import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { priceOf, setPriceOverrides } from "@reflex/core";
import { paths } from "../src/paths";
import { loadPriceFile, readPriceFile } from "../src/prices";

describe("prices.json", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-prices-"));
  });
  afterEach(() => setPriceOverrides({}));

  it("is optional", () => {
    expect(readPriceFile()).toEqual({ prices: {}, problems: [] });
  });

  it("adds prices and skips entries with a missing or negative number", async () => {
    await writeFile(
      paths.prices(),
      JSON.stringify({
        "acme-large": { input: 1, output: 2, cacheWrite: 1.25, cacheRead: 0.1, cacheWrite1h: 2 },
        "acme-small": { input: 1, output: 2, cacheRead: 0.1 },
        "acme-free": { input: -1, output: 0, cacheWrite: 0, cacheRead: 0 },
      }),
    );
    expect(loadPriceFile()).toEqual([
      expect.stringContaining('"acme-small" needs a number of dollars per million tokens for cacheWrite'),
      expect.stringContaining('"acme-free" needs a number of dollars per million tokens for input'),
    ]);
    expect(priceOf("acme-large")).toEqual({ input: 1, output: 2, cacheWrite: 1.25, cacheRead: 0.1, cacheWrite1h: 2 });
    expect(priceOf("acme-small")).toBeUndefined();
  });

  it("says when the file isn't JSON and uses none of it", async () => {
    await writeFile(paths.prices(), "{ not json");
    expect(loadPriceFile()).toEqual([expect.stringContaining("is not valid JSON")]);
  });
});
