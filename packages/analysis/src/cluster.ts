import type { WorkflowTrace } from "@reflix/core";
import { buildTfIdf, concepts, cosine } from "./intents";
import { opKeys, similarity } from "./similarity";

export const CLUSTER_THRESHOLD = 0.45;

export type Cluster = {
  members: number[];
  /** Mean pairwise hybrid similarity among members (1 for singletons). */
  cohesion: number;
  /** Mean pairwise intent similarity: do the requests share a purpose? */
  intentCohesion: number;
  /** Mean pairwise action-sequence similarity: does the behavior repeat? */
  actionCohesion: number;
};

type Matrices = { total: number[][]; intent: number[][]; actions: number[][] };

/** Semantic intent = blend of concept overlap (synonym-aware) and TF-IDF term overlap. */
export function intentSimilarities(traces: WorkflowTrace[]): (i: number, j: number) => number {
  const tfidf = buildTfIdf(traces.map((t) => t.intents));
  const conceptVectors = traces.map((t) => concepts(t.intents));
  return (i, j) => 0.5 * cosine(conceptVectors[i]!, conceptVectors[j]!) + 0.5 * cosine(tfidf.vectors[i]!, tfidf.vectors[j]!);
}

/** Pairwise similarity matrices. O(n^2), fine for hundreds of sessions. */
export function similarityMatrices(traces: WorkflowTrace[]): Matrices {
  const intentOf = intentSimilarities(traces);
  const keys = traces.map(opKeys);
  const n = traces.length;
  const make = () => Array.from({ length: n }, () => new Array<number>(n).fill(1));
  const m: Matrices = { total: make(), intent: make(), actions: make() };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = similarity(traces[i]!, traces[j]!, intentOf(i, j), keys[i], keys[j]);
      for (const [name, v] of [
        ["total", s.total],
        ["intent", s.intent],
        ["actions", s.actions],
      ] as const) {
        m[name][i]![j] = v;
        m[name][j]![i] = v;
      }
    }
  }
  return m;
}

function meanPairwise(matrix: number[][], members: number[]): number {
  let total = 0;
  let pairs = 0;
  for (let x = 0; x < members.length; x++)
    for (let y = x + 1; y < members.length; y++) {
      total += matrix[members[x]!]![members[y]!]!;
      pairs++;
    }
  return pairs ? total / pairs : 1;
}

/**
 * Average-linkage agglomerative clustering: repeatedly merge the two clusters whose members are
 * most similar on average, until no pair reaches the threshold. Deterministic for a given input.
 */
export function clusterTraces(traces: WorkflowTrace[], threshold = CLUSTER_THRESHOLD): Cluster[] {
  const sim = similarityMatrices(traces);
  const n = traces.length;
  const members: (number[] | null)[] = traces.map((_, i) => [i]);
  // link[i][j] = average similarity between clusters i and j (Lance-Williams update).
  const link = sim.total.map((row) => [...row]);

  for (;;) {
    let best = -1;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++) {
      if (!members[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!members[j]) continue;
        if (link[i]![j]! > best) {
          best = link[i]![j]!;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0 || best < threshold) break;
    const a = members[bi]!;
    const b = members[bj]!;
    for (let k = 0; k < n; k++) {
      if (!members[k] || k === bi || k === bj) continue;
      const v = (a.length * link[bi]![k]! + b.length * link[bj]![k]!) / (a.length + b.length);
      link[bi]![k] = v;
      link[k]![bi] = v;
    }
    members[bi] = [...a, ...b].sort((x, y) => x - y);
    members[bj] = null;
  }

  return members
    .filter((m): m is number[] => m !== null)
    .map((m) => ({
      members: m,
      cohesion: meanPairwise(sim.total, m),
      intentCohesion: meanPairwise(sim.intent, m),
      actionCohesion: meanPairwise(sim.actions, m),
    }))
    .sort((p, q) => q.members.length - p.members.length || p.members[0]! - q.members[0]!);
}
