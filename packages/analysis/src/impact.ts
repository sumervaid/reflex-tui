import type { TokenUsage, WorkflowTrace } from "@reflex/core";
import { addUsage, totalTokens } from "@reflex/core";
import { deduplicate } from "./dedup";
import { usedSkill } from "./trace";

/** Fewer runs than this on either side and Reflex reports no change at all. */
export const MIN_COMPARISON_RUNS = 3;

export type WorkflowCost = {
  runs: number;
  /** Runs whose source recorded token usage (Claude Code, Codex; not Cursor). */
  runsWithTokens: number;
  medianTokens?: number;
  /** Summed over the runs with token data. */
  usage?: TokenUsage;
  medianToolCalls?: number;
};

export type SkillImpact = {
  skill: string;
  before: WorkflowCost;
  after: WorkflowCost;
  /** Relative change of the median (-0.3 = 30% fewer). Set only when both sides have enough runs. */
  tokenChange?: number;
  toolCallChange?: number;
};

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
}

/** Cost of whole sessions: a session may contain other work besides the workflow. */
export function workflowCost(runs: WorkflowTrace[]): WorkflowCost {
  const withTokens = runs.filter((t) => t.usage && totalTokens(t.usage) > 0);
  let usage: TokenUsage | undefined;
  for (const t of withTokens) usage = addUsage(usage, t.usage!);
  const toolCalls = runs.map((t) => t.toolCalls).filter((n): n is number => typeof n === "number");
  return {
    runs: runs.length,
    runsWithTokens: withTokens.length,
    medianTokens: median(withTokens.map((t) => totalTokens(t.usage!))),
    usage,
    medianToolCalls: median(toolCalls),
  };
}

function change(before: number | undefined, after: number | undefined, nBefore: number, nAfter: number): number | undefined {
  if (before === undefined || after === undefined || before <= 0) return undefined;
  if (nBefore < MIN_COMPARISON_RUNS || nAfter < MIN_COMPARISON_RUNS) return undefined;
  return (after - before) / before;
}

/** Compare a skill's baseline with the sessions that have since loaded it. */
export function measureImpact(skill: string, before: WorkflowCost, traces: WorkflowTrace[]): SkillImpact {
  const runs = deduplicate(traces)
    .instances.filter((i) => [i.primary, ...i.merged].some((t) => usedSkill(t, skill)))
    .map((i) => i.primary);
  const after = workflowCost(runs);
  return {
    skill,
    before,
    after,
    tokenChange: change(before.medianTokens, after.medianTokens, before.runsWithTokens, after.runsWithTokens),
    toolCallChange: change(before.medianToolCalls, after.medianToolCalls, before.runs, after.runs),
  };
}
