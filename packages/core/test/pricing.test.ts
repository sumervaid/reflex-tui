import { describe, expect, it } from "vitest";
import { costAt, costOf, priceOf } from "../src/pricing";

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
});
