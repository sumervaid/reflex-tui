import { afterEach, describe, expect, it } from "vitest";
import { costAt, costOf, priceOf, setPriceOverrides, unknownModels } from "../src/pricing";

describe("model prices", () => {
  it.each([
    ["claude-opus-5-5", 4, 20],
    ["claude-opus-5", 5, 25],
    ["claude-opus-4-5-20251101", 5, 25],
    ["claude-opus-4-1-20250805", 15, 75],
    ["claude-sonnet-5-5", 2, 10],
    ["claude-sonnet-5", 2, 10],
    ["claude-sonnet-4-5-20250929", 3, 15],
    ["claude-haiku-4-5-20251001", 1, 5],
    ["claude-fable-5-1", 10, 50],
    ["gpt-5.6-sol", 4, 20],
    ["gpt-5.3-codex", 1.75, 14],
    ["gpt-5-codex", 1.25, 10],
  ])("%s costs $%s in and $%s out per million tokens", (model, input, output) => {
    expect(priceOf(model)).toMatchObject({ input, output });
  });

  it("leaves unknown models unpriced", () => {
    expect(priceOf("some-new-model")).toBeUndefined();
    expect(costOf({ "some-new-model": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })).toEqual({ byModel: {}, unpriced: ["some-new-model"] });
  });

  it("prices each token kind and what it would cost without caching", () => {
    const c = costAt({ input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }, priceOf("claude-opus-5-5")!);
    expect(c.split).toEqual({ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 });
    expect(c.usd).toBeCloseTo(29.2, 9);
    expect(c.uncached).toBeCloseTo(3 * 4 + 20, 9);
  });

  it("adds sessions that ran on several models", () => {
    const u = { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 };
    const r = costOf({ "claude-opus-5-5": u, "claude-sonnet-5-5": u, mystery: u });
    expect(r.cost!.usd).toBeCloseTo(6, 9);
    expect(r.byModel).toEqual({ "claude-opus-5-5": 4, "claude-sonnet-5-5": 2 });
    expect(r.unpriced).toEqual(["mystery"]);
  });

  it("prices 1-hour cache writes at 2x input and the rest at the 5-minute rate", () => {
    const c = costAt({ input: 0, output: 0, cacheWrite: 3e6, cacheWrite1h: 1e6, cacheRead: 0 }, priceOf("claude-opus-5-5")!);
    expect(c.split.cacheWrite).toBeCloseTo(2 * 5 + 1 * 8, 9);
  });

  it("prices 1-hour writes at the 5-minute rate for models without one", () => {
    const c = costAt({ input: 0, output: 0, cacheWrite: 1e6, cacheWrite1h: 1e6, cacheRead: 0 }, priceOf("gpt-5.6-sol")!);
    expect(c.split.cacheWrite).toBeCloseTo(5, 9);
  });

  // Every model the agents currently run. A new model belongs here, and in the table, before release.
  it.each([
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-5-5",
    "claude-haiku-4-5-20251001",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3-codex",
    "gpt-5-codex",
  ])("has a price for %s", (model) => {
    expect(priceOf(model)).toBeDefined();
  });

  it("lists the models it can't price, by how many sessions used them", () => {
    const u = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    expect(unknownModels([{ "claude-opus-5-5": u, mystery: u }, { mystery: u, other: u }, undefined])).toEqual([
      { model: "mystery", sessions: 2 },
      { model: "other", sessions: 1 },
    ]);
  });
});

describe("your own prices", () => {
  afterEach(() => setPriceOverrides({}));
  const mine = { input: 1, output: 2, cacheWrite: 1.25, cacheRead: 0.1 };

  it("price a model Reflex doesn't know, by id or by prefix", () => {
    setPriceOverrides({ "Some-New-Model": mine, "acme-*": mine });
    expect(priceOf("some-new-model")).toEqual(mine);
    expect(priceOf("acme-large-2")).toEqual(mine);
    expect(priceOf("some-new-model-2")).toBeUndefined();
  });

  it("come before the built-in prices", () => {
    setPriceOverrides({ "claude-opus-5-5": mine });
    expect(priceOf("claude-opus-5-5")).toEqual(mine);
    expect(priceOf("claude-sonnet-5-5")).toMatchObject({ input: 2 });
  });
});
