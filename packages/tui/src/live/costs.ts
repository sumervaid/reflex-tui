import { type Cost, type WorkflowTrace, addCost, costOf } from "@reflex/core";
import type { Bar, Day, Money, PromptRow, SessionRow, TokenWindow } from "../model";
import { toCells } from "../render/text";
import type { ToolId } from "../types";
import { dayLabel, dayStart } from "./labels";
import { TOOL_OF } from "./skills";

/** A session with its API-list-price cost, when its source recorded tokens per model. */
export type Priced = { t: WorkflowTrace; at: number; tool: ToolId; cost?: Cost; byModel: Record<string, number>; unpriced: string[] };

export function priceTraces(traces: WorkflowTrace[]): Priced[] {
  return traces.map((t) => ({
    t,
    at: t.startedAt ? Date.parse(t.startedAt) || 0 : 0,
    tool: TOOL_OF[t.source],
    ...costOf(t.usageByModel),
  }));
}

/** Traces stored before Reflex recorded usage per model: they have tokens but no models to price. */
export const needsRescan = (priced: Priced[]): number => priced.filter((p) => p.t.usage && !p.t.usageByModel).length;

/** What kind of task a session was, from what the agent did. Used by Tokens and the Router. */
export function taskKind(t: WorkflowTrace): { key: string; name: string } {
  const a = new Set(t.actionSequence);
  const modified = [...a].some((x) => x.startsWith("modify-"));
  if (a.has("inspect-pr") || a.has("submit-review")) return { key: "review", name: "Code review" };
  if (a.has("inspect-ci") || a.has("modify-ci")) return { key: "ci", name: "CI and builds" };
  if (modified && t.outcome.recoveredFromFailure) return { key: "debug", name: "Debugging" };
  if (modified && (a.has("modify-tests") || a.has("run-tests"))) return { key: "feature", name: "Features and tests" };
  if (modified) return { key: "edit", name: "Edits" };
  if (a.has("research")) return { key: "research", name: "Research" };
  return { key: "explore", name: "Questions and exploration" };
}

const sum = (xs: Priced[]): number => xs.reduce((a, p) => a + (p.cost?.usd ?? 0), 0);
const between = (xs: Priced[], from: Date, to: Date): Priced[] => xs.filter((p) => p.at >= from.getTime() && p.at < to.getTime());

function bars(xs: Priced[], key: (p: Priced) => Array<[string, number]>): Bar[] {
  const m = new Map<string, number>();
  for (const p of xs) for (const [k, v] of key(p)) m.set(k, (m.get(k) ?? 0) + v);
  return [...m]
    .filter(([, v]) => v > 0)
    .map(([name, usd]) => ({ name: toCells(name), usd }))
    .sort((a, b) => b.usd - a.usd);
}
const byTool = (xs: Priced[]): Bar[] => bars(xs, (p) => (p.cost ? [[p.tool, p.cost.usd]] : []));
const byModel = (xs: Priced[]): Bar[] => bars(xs, (p) => Object.entries(p.byModel));
const byProject = (xs: Priced[]): Bar[] => bars(xs, (p) => (p.cost ? [[p.t.projectName ?? "—", p.cost.usd]] : []));

export type CostFields = {
  money: Money;
  /** Cost and cost per tool for each day of `days`, in the same order. */
  dayCost: Array<Pick<Day, "usd" | "byTool">>;
  windowUsd: NonNullable<TokenWindow["usd"]>;
  windowByModel: Bar[];
  windowByProject: Bar[];
  yesterday: { byTool: Bar[]; byModel: Bar[]; byProject: Bar[] };
  toolUsd: Partial<Record<ToolId, number>>;
  topSessions: SessionRow[];
  topPrompts: PromptRow[];
};

/**
 * Dollar figures for the Dashboard, Morning and Tokens views: every session whose models have a
 * known price, at API list prices. Undefined when nothing could be priced (only Cursor, which
 * records no tokens, or traces from before Reflex recorded models).
 */
export function costFields(priced: Priced[], dayStarts: Date[], now: Date): CostFields | undefined {
  const paid = priced.filter((p) => p.cost);
  if (!paid.length) return undefined;
  const total = paid.reduce<Cost | undefined>((a, p) => (a ? addCost(a, p.cost!) : p.cost), undefined)!;
  const today = between(priced, dayStart(now), dayStart(now, 1));
  const first = Math.min(...priced.filter((p) => p.at).map((p) => p.at));
  const money: Money = {
    today: { usd: sum(today), sessions: today.length },
    allTime: { usd: total.usd, since: dayLabel(new Date(first)) },
    month: { usd: sum(between(priced, new Date(now.getFullYear(), now.getMonth(), 1), dayStart(now, 1))) },
  };
  const dayCost = dayStarts.map((d) => {
    const xs = between(priced, d, dayStart(d, 1));
    const tools: Partial<Record<ToolId, number>> = {};
    for (const b of byTool(xs)) tools[b.name as ToolId] = b.usd;
    return { usd: sum(xs), byTool: tools };
  });
  const y = between(priced, dayStart(now, -1), dayStart(now));
  const toolUsd: Partial<Record<ToolId, number>> = {};
  for (const b of byTool(priced)) toolUsd[b.name as ToolId] = b.usd;
  const top = [...paid].sort((a, b) => b.cost!.usd - a.cost!.usd).slice(0, 8);
  return {
    money,
    dayCost,
    windowUsd: { ...total.split, total: total.usd, uncached: total.uncached },
    windowByModel: byModel(paid),
    windowByProject: byProject(paid),
    yesterday: { byTool: byTool(y), byModel: byModel(y), byProject: byProject(y) },
    toolUsd,
    topSessions: top.map((p) => {
      const u = p.t.usage!;
      return {
        usd: p.cost!.usd,
        date: p.at ? dayLabel(new Date(p.at)) : "—",
        tool: p.tool,
        project: toCells(p.t.projectName ?? "—"),
        kind: taskKind(p.t).key,
        turns: p.t.requests ?? 0,
        toolCalls: p.t.toolCalls ?? 0,
        contextTokens: u.input + u.cacheRead + u.cacheWrite,
        prompt: toCells(p.t.excerpt),
      };
    }),
    // A session's cost is attributed to the request that opened it.
    topPrompts: top.map((p) => ({ usd: p.cost!.usd, project: toCells(p.t.projectName ?? "—"), text: toCells(p.t.excerpt) })),
  };
}
