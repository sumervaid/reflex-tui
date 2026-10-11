import type { WorkflowTrace } from "@reflex/core";
import { buildTfIdf, cosine } from "./intents";
import { actionSimilarity } from "./similarity";

/** One independent occurrence of a workflow, possibly backed by several duplicate records. */
export type WorkflowInstance = {
  id: string;
  /** Representative trace (the most complete copy, or the first attempt for retries). */
  primary: WorkflowTrace;
  /** Other traces folded into this instance (copies, resumes, retries). */
  merged: WorkflowTrace[];
};

export type DedupStats = {
  input: number;
  copies: number;
  resumed: number;
  retries: number;
  instances: number;
};

const RESUME_OVERLAP = 0.8;
const RETRY_WINDOW_MS = 4 * 3600 * 1000;
const RETRY_INTENT = 0.45;
const RETRY_ACTIONS = 0.5;

const size = (t: WorkflowTrace) => t.eventHashes.length + t.actionSequence.length;
const time = (t: WorkflowTrace) => (t.startedAt ? Date.parse(t.startedAt) : NaN);

export function deduplicate(traces: WorkflowTrace[]): { instances: WorkflowInstance[]; stats: DedupStats } {
  const stats: DedupStats = { input: traces.length, copies: 0, resumed: 0, retries: 0, instances: 0 };

  // 1. Identical content (same file read twice, mirrored or copied history).
  const byFingerprint = new Map<string, WorkflowTrace>();
  const copiesOf = new Map<string, WorkflowTrace[]>();
  // Prefer the shortest source path as the original (backups and mirrors tend to be nested or suffixed).
  for (const t of [...traces].sort((a, b) => a.sourceFile.length - b.sourceFile.length)) {
    if (byFingerprint.has(t.fingerprint)) {
      stats.copies++;
      copiesOf.set(t.fingerprint, [...(copiesOf.get(t.fingerprint) ?? []), t]);
    } else byFingerprint.set(t.fingerprint, t);
  }
  let unique = [...byFingerprint.values()].sort((a, b) => size(b) - size(a));

  // 2. Resumed sessions replay earlier events: fold a trace into a larger one that contains most of its events.
  const owner = new Map<string, number>();
  const instances: WorkflowInstance[] = [];
  for (const t of unique) {
    const counts = new Map<number, number>();
    for (const h of t.eventHashes) {
      const idx = owner.get(h);
      if (idx !== undefined) counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    let host: number | undefined;
    for (const [idx, c] of counts) if (t.eventHashes.length && c / t.eventHashes.length >= RESUME_OVERLAP) host = idx;
    const copies = copiesOf.get(t.fingerprint) ?? [];
    if (host !== undefined) {
      instances[host]!.merged.push(t, ...copies);
      stats.resumed++;
      continue;
    }
    const idx = instances.push({ id: t.sessionId, primary: t, merged: [...copies] }) - 1;
    for (const h of t.eventHashes) if (!owner.has(h)) owner.set(h, idx);
  }

  // 3. Retries: the same request in the same repository within a few hours is one occurrence, not two.
  unique = instances.map((i) => i.primary);
  const tfidf = buildTfIdf(unique.map((t) => t.intents));
  const absorbed = new Set<number>();
  const order = unique.map((_, i) => i).sort((a, b) => (time(unique[a]!) || 0) - (time(unique[b]!) || 0));
  for (let x = 0; x < order.length; x++) {
    const i = order[x]!;
    if (absorbed.has(i)) continue;
    for (let y = x + 1; y < order.length; y++) {
      const j = order[y]!;
      if (absorbed.has(j)) continue;
      const a = unique[i]!;
      const b = unique[j]!;
      const dt = time(b) - time(a);
      if (!(dt >= 0) || dt > RETRY_WINDOW_MS) break;
      if (!a.projectHash || a.projectHash !== b.projectHash) continue;
      if (cosine(tfidf.vectors[i]!, tfidf.vectors[j]!) < RETRY_INTENT) continue;
      if (actionSimilarity(a.actionSequence, b.actionSequence) < RETRY_ACTIONS) continue;
      absorbed.add(j);
      instances[i]!.merged.push(b, ...instances[j]!.merged);
      stats.retries++;
    }
  }

  const result = instances.filter((_, i) => !absorbed.has(i));
  stats.instances = result.length;
  return { instances: result, stats };
}
