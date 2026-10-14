import type { WorkflowTrace } from "@reflex/core";
import { DEVELOPER_WORDS } from "./intents";
import { actionSimilarity } from "./similarity";

/**
 * Filler words learned from the user's own history, in any language and with no list: a word whose
 * sessions do unrelated kinds of work (CI fixes, docs, refactors) says nothing about the task,
 * while a task word's sessions behave alike. Such words are quieted in word matching, never removed.
 * The effect grows with the history: barely anything with a few dozen sessions, where chance
 * spread is common, and full strength from FULL_AT sessions on. Developer words are never quieted.
 */
export const LEARN_FROM = 20;
export const FULL_AT = 200;
/** A filler keeps at least this share of its weight. */
const FLOOR = 0.2;
/** How far above the history's typical action similarity a word's sessions must be to count as a task word. */
const MARGIN = 0.15;
const MAX_PAIRS = 300;

/** Deterministic sample of index pairs from a list, at most MAX_PAIRS. */
function pairsOf(ix: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const total = (ix.length * (ix.length - 1)) / 2;
  const step = Math.max(1, Math.floor(total / MAX_PAIRS));
  let k = 0;
  for (let a = 0; a < ix.length; a++)
    for (let b = a + 1; b < ix.length; b++) if (k++ % step === 0 && out.length < MAX_PAIRS) out.push([ix[a]!, ix[b]!]);
  return out;
}

export function fillerWeights(traces: Pick<WorkflowTrace, "intents" | "actionSequence">[]): Map<string, number> {
  const n = traces.length;
  const weights = new Map<string, number>();
  if (n < LEARN_FROM) return weights;
  const ramp = Math.min(1, (n - LEARN_FROM) / (FULL_AT - LEARN_FROM));
  const sim = new Map<string, number>();
  const actions = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let v = sim.get(key);
    if (v === undefined) sim.set(key, (v = actionSimilarity(traces[a]!.actionSequence, traces[b]!.actionSequence)));
    return v;
  };
  const mean = (pairs: Array<[number, number]>) => pairs.reduce((s, [a, b]) => s + actions(a, b), 0) / (pairs.length || 1);
  const baseline = mean(pairsOf(traces.map((_, i) => i)));
  const sessionsOf = new Map<string, number[]>();
  traces.forEach((t, i) => {
    for (const term of new Set(t.intents)) sessionsOf.set(term, [...(sessionsOf.get(term) ?? []), i]);
  });
  const minSessions = Math.max(3, Math.ceil(0.05 * n));
  for (const [term, ix] of sessionsOf) {
    if (ix.length < minSessions || DEVELOPER_WORDS.has(term)) continue;
    const spread = Math.min(1, Math.max(0, (baseline + MARGIN - mean(pairsOf(ix))) / MARGIN));
    if (spread > 0) weights.set(term, 1 - ramp * spread * (1 - FLOOR));
  }
  return weights;
}
