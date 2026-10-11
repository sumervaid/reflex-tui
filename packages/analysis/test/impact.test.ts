import { describe, expect, it } from "vitest";
import type { NormalizedSession, SessionEvent, TokenUsage } from "@reflex/core";
import { MIN_COMPARISON_RUNS, measureImpact, workflowCost } from "../src/impact";
import { buildTrace, usedSkill } from "../src/trace";

const usage = (total: number): TokenUsage => ({ input: total / 2, output: total / 4, cacheRead: total / 4, cacheWrite: 0 });

function session(i: number, opts: { tokens?: number; extra?: SessionEvent[]; tools?: number } = {}): NormalizedSession {
  const at = new Date(Date.UTC(2026, 9, 1 + i, 10)).toISOString();
  const shells: SessionEvent[] = Array.from({ length: opts.tools ?? 4 }, (_, k) => ({ kind: "shell", at, command: `pnpm test --shard ${k}` }));
  return {
    id: `claude-code:s${i}`,
    source: "claude-code",
    startedAt: at,
    endedAt: at,
    project: { name: `p${i}`, pathHash: `p${i}` },
    requests: [{ at, text: `review pull request ${i}` }],
    events: [{ kind: "user", at, text: `review pull request ${i}` }, ...(opts.extra ?? []), ...shells],
    sourceRef: { file: `~/x/s${i}.jsonl`, nativeId: `s${i}` },
    skippedRecords: 0,
    usage: opts.tokens === undefined ? undefined : usage(opts.tokens),
  };
}

const loadsSkill: SessionEvent = { kind: "tool", tool: "Skill", skill: "review-pr" };
const readsSkill: SessionEvent = { kind: "file", op: "read", path: "~/.cursor/skills/review-pr/SKILL.md" };

describe("skill use detection", () => {
  it("counts Skill tool calls, plugin-prefixed names and SKILL.md reads", () => {
    expect(usedSkill(buildTrace(session(1, { extra: [loadsSkill] })), "review-pr")).toBe(true);
    expect(usedSkill(buildTrace(session(1, { extra: [{ kind: "tool", tool: "Skill", skill: "tools:review-pr" }] })), "review-pr")).toBe(true);
    expect(usedSkill(buildTrace(session(1, { extra: [readsSkill] })), "review-pr")).toBe(true);
    expect(usedSkill(buildTrace(session(1, { extra: [{ kind: "shell", command: "cat ~/.codex/skills/review-pr/SKILL.md" }] })), "review-pr")).toBe(true);
  });

  it("ignores Reflex's own generated copies and other skills", () => {
    const own: SessionEvent = { kind: "file", op: "read", path: "~/.reflex/skills/review-pr/SKILL.md" };
    expect(usedSkill(buildTrace(session(1, { extra: [own] })), "review-pr")).toBe(false);
    expect(usedSkill(buildTrace(session(1, { extra: [loadsSkill] })), "fix-ci")).toBe(false);
    expect(buildTrace(session(1)).skillsUsed).toEqual([]);
  });
});

describe("workflow cost", () => {
  it("takes medians over runs with token data and counts tool calls for all", () => {
    const cost = workflowCost([session(1, { tokens: 1000 }), session(2, { tokens: 3000 }), session(3)].map(buildTrace));
    expect(cost).toMatchObject({ runs: 3, runsWithTokens: 2, medianTokens: 2000, medianToolCalls: 4 });
    expect(cost.usage).toEqual({ input: 2000, output: 1000, cacheRead: 1000, cacheWrite: 0 });
  });

  it("has no token median when no run recorded tokens (Cursor)", () => {
    const cost = workflowCost([session(1), session(2)].map(buildTrace));
    expect(cost.medianTokens).toBeUndefined();
    expect(cost.usage).toBeUndefined();
    expect(cost.runsWithTokens).toBe(0);
  });
});

describe("measureImpact", () => {
  const before = workflowCost([1, 2, 3, 4].map((i) => buildTrace(session(i, { tokens: 40_000, tools: 10 }))));

  it("reports the change only with enough runs on both sides", () => {
    const after = [10, 11, 12].map((i) => buildTrace(session(i, { tokens: 30_000, tools: 5, extra: [loadsSkill] })));
    const unrelated = buildTrace(session(13, { tokens: 1_000_000 }));
    const impact = measureImpact("review-pr", before, [...after, unrelated]);
    expect(impact.after.runs).toBe(3);
    expect(impact.tokenChange).toBeCloseTo(-0.25);
    // 5 shell calls plus the Skill call itself, against 10 before.
    expect(impact.toolCallChange).toBeCloseTo(-0.4);
  });

  it("refuses to compare small samples", () => {
    const after = [10, 11].map((i) => buildTrace(session(i, { tokens: 10_000, extra: [loadsSkill] })));
    const impact = measureImpact("review-pr", before, after);
    expect(after.length).toBeLessThan(MIN_COMPARISON_RUNS);
    expect(impact.tokenChange).toBeUndefined();
    expect(impact.toolCallChange).toBeUndefined();
  });
});
