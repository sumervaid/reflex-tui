import type { WorkflowTrace } from "@reflex/core";
import { type SessionVectors, dotProduct } from "./context";
import { concepts, cosine, termSimilarities } from "./intents";
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

/**
 * Embedding cosine at or below which two sessions count as unrelated in meaning. Sentences about
 * coding share a domain, so unrelated requests still score above zero; rescaling from this floor
 * puts embeddings on the same 0..1 footing as the lexical signals.
 */
export const EMBEDDING_FLOOR = 0.2;

export function rescaleEmbedding(cos: number): number {
  return Math.min(1, Math.max(0, (cos - EMBEDDING_FLOOR) / (1 - EMBEDDING_FLOOR)));
}

/**
 * Semantic intent = blend of concept overlap (synonym-aware) and TF-IDF term overlap. With session
 * vectors, intent is the stronger of that lexical match and the embedding match of the two
 * sessions' context documents, so meaning can connect requests that share no words but can never
 * pull apart requests that do. A session without a vector is compared lexically.
 */
export function intentSimilarities(traces: WorkflowTrace[], vectors?: SessionVectors): (i: number, j: number) => number {
  const termSim = termSimilarities(traces.map((t) => t.intents));
  const conceptVectors = traces.map((t) => concepts(t.intents));
  const embedded = traces.map((t) => vectors?.get(t.sessionId));
  return (i, j) => {
    const lexical = 0.5 * cosine(conceptVectors[i]!, conceptVectors[j]!) + 0.5 * termSim(i, j);
    const a = embedded[i];
    const b = embedded[j];
    return a && b ? Math.max(lexical, rescaleEmbedding(dotProduct(a, b))) : lexical;
  };
}

/** Pairwise similarity matrices. O(n^2), fine for hundreds of sessions. */
export function similarityMatrices(traces: WorkflowTrace[], vectors?: SessionVectors): Matrices {
  const intentOf = intentSimilarities(traces, vectors);
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
export function clusterTraces(traces: WorkflowTrace[], threshold = CLUSTER_THRESHOLD, vectors?: SessionVectors): Cluster[] {
  const sim = similarityMatrices(traces, vectors);
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
