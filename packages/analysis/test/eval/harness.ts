import type { NormalizedSession, WorkflowTrace } from "@reflex/core";
import { EVAL_SESSIONS, type FixtureSession, evalTask, fixtureUuid } from "@reflex/test-fixtures";
import { CLUSTER_THRESHOLD, clusterTraces, similarityMatrices } from "../../src/cluster";
import type { SessionVectors } from "../../src/context";
import { deduplicate } from "../../src/dedup";
import { type AnalyzeOptions, analyze } from "../../src/suggest";
import { buildTrace, isGenericTrace } from "../../src/trace";
import { fixtureSessions } from "../helpers";

export type EvalData = { sessions: NormalizedSession[]; traces: WorkflowTrace[]; taskOf: (sessionId: string) => string };

/** Parse the labeled evaluation history once; every variant is measured on the same traces. */
export async function loadEvalData(fixtures: FixtureSession[] = EVAL_SESSIONS): Promise<EvalData> {
  const sessions = await fixtureSessions(fixtures);
  const traces = sessions.map(buildTrace);
  // Resumed copies (fixture variants) carry their own id and belong to the original's task.
  const keyOf = new Map(fixtures.flatMap((f) => [[fixtureUuid(`session:${f.key}`), f.key], [fixtureUuid(`session:${f.key}:resumed`), f.key]] as const));
  const taskOf = (sessionId: string) => {
    for (const [uuid, key] of keyOf) if (sessionId.includes(uuid)) return evalTask(key);
    throw new Error(`Unlabeled session ${sessionId}`);
  };
  return { sessions, traces, taskOf };
}

export type EvalResult = {
  /** Same-task vs different-task pairs ranked by intent similarity (0.5 = chance, 1 = perfect). */
  intentAuc: number;
  /** Same, for the full weighted similarity that clustering uses. */
  totalAuc: number;
  /** Mean intent similarity of same-task pairs minus different-task pairs. */
  intentGap: number;
  /** Pairwise F1 of the clusters against the task labels. */
  clusterF1: number;
  /** Task families (with at least 3 independent sessions) that came out as one clean suggestion. */
  recovered: number;
  recoverable: number;
  /** Suggestions made of one task only (what a user wants to see). */
  clean: number;
  /** Suggestions that mix sessions from different tasks (a skill nobody asked for). */
  impure: number;
  suggestions: number;
  /** Per-suggestion task make-up, for reading the result. */
  detail: string[];
};

function auc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x: number) => Math.round(x * 1000) / 1000;

function pairF1(groups: number[][], labels: string[]): number {
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => g.forEach((i) => groupOf.set(i, gi)));
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const together = groupOf.has(i) && groupOf.get(i) === groupOf.get(j);
      const same = labels[i] === labels[j];
      if (together && same) tp++;
      else if (together) fp++;
      else if (same) fn++;
    }
  return tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
}

/** Measure request matching on the labeled history, as the pipeline runs it (dedup, generic filter, clustering, gates). */
export function evaluate(data: EvalData, opts: AnalyzeOptions = {}): EvalResult {
  const { instances } = deduplicate(data.traces);
  const candidates = instances.filter((i) => !isGenericTrace(i.primary)).map((i) => i.primary);
  const labels = candidates.map((t) => data.taskOf(t.sessionId));
  const m = similarityMatrices(candidates, opts.vectors);

  const intent = { same: [] as number[], diff: [] as number[] };
  const total = { same: [] as number[], diff: [] as number[] };
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      const k = labels[i] === labels[j] ? "same" : "diff";
      intent[k].push(m.intent[i]![j]!);
      total[k].push(m.total[i]![j]!);
    }

  const clusters = clusterTraces(candidates, CLUSTER_THRESHOLD, opts.vectors).map((c) => c.members);

  const { suggestions } = analyze(data.traces, opts);
  const index = new Map(candidates.map((t, i) => [t.sessionId, i]));
  const sizeOf = new Map<string, number>();
  for (const l of labels) sizeOf.set(l, (sizeOf.get(l) ?? 0) + 1);
  const recoverable = [...sizeOf].filter(([, n]) => n >= 3).map(([t]) => t);

  let impure = 0;
  let clean = 0;
  const recoveredTasks = new Set<string>();
  const detail: string[] = [];
  for (const s of suggestions) {
    const members = s.sourceSessions.map((id) => index.get(id)).filter((i): i is number => i !== undefined);
    const counts = new Map<string, number>();
    for (const i of members) counts.set(labels[i]!, (counts.get(labels[i]!) ?? 0) + 1);
    const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["?", 0];
    if (counts.size > 1) impure++;
    else clean++;
    // Clean: only this task, and at least three quarters of its sessions.
    if (counts.size === 1 && n >= Math.ceil(0.75 * (sizeOf.get(top) ?? 0))) recoveredTasks.add(top);
    detail.push(`${s.slug}: ${[...counts].map(([t, c]) => `${t}×${c}`).join(" + ")}`);
  }

  return {
    intentAuc: round(auc(intent.same, intent.diff)),
    totalAuc: round(auc(total.same, total.diff)),
    intentGap: round(mean(intent.same) - mean(intent.diff)),
    clusterF1: round(pairF1(clusters, labels)),
    recovered: recoverable.filter((t) => recoveredTasks.has(t)).length,
    recoverable: recoverable.length,
    clean,
    impure,
    suggestions: suggestions.length,
    detail,
  };
}

/** Vectors for every trace from a document builder, keyed by session id. */
export async function vectorsFor(
  data: EvalData,
  embed: (docs: string[]) => Promise<Float32Array[]>,
  doc: (session: NormalizedSession, trace: WorkflowTrace) => string,
): Promise<SessionVectors> {
  const docs = data.sessions.map((s, i) => doc(s, data.traces[i]!));
  const v = await embed(docs);
  return new Map(data.traces.map((t, i) => [t.sessionId, v[i]!]));
}
