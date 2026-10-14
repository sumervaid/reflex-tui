import { describe, expect, it } from "vitest";
import type { SourceId, WorkflowTrace } from "@reflex/core";
import { costFields, priceTraces } from "../src/live/costs";

const NOW = new Date(2026, 9, 13, 15, 0);
const at = (daysAgo: number) => new Date(2026, 9, 13 - daysAgo, 10).toISOString();
const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

function trace(id: string, source: SourceId, startedAt: string, priced: boolean): WorkflowTrace {
  return {
    sessionId: `${source}:${id}`,
    source,
    startedAt,
    intents: [],
    tools: [],
    commands: [],
    fileCategories: [],
    actionSequence: [],
    displaySteps: [],
    outcome: { verified: false, recoveredFromFailure: false, modified: false, summarized: false },
    excerpt: "",
    fingerprint: id,
    eventHashes: [],
    sourceFile: id,
    usage: priced ? usage : undefined,
    usageByModel: priced ? { "claude-sonnet-5-5": usage } : undefined,
  };
}

describe("costFields", () => {
  it("leaves a day with only Cursor sessions unknown instead of $0, and counts unpriced sessions today", () => {
    const priced = priceTraces([trace("a", "claude-code", at(2), true), trace("b", "cursor", at(1), false), trace("c", "cursor", at(0), false)]);
    const days = [2, 1].map((n) => new Date(2026, 9, 13 - n));
    const f = costFields(priced, days, NOW)!;
    expect(f.dayCost.map((d) => d.usd)).toEqual([2, undefined]);
    expect(f.money.today).toEqual({ usd: undefined, sessions: 1, unpriced: 1 });
    const mixed = costFields(priceTraces([trace("d", "claude-code", at(0), true), trace("e", "cursor", at(0), false)]), [], NOW)!;
    expect(mixed.money.today).toEqual({ usd: 2, sessions: 2, unpriced: 1 });
  });
});
