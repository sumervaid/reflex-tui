import type { WorkflowTrace } from "@reflex/core";
import { type SessionVectors, dotProduct } from "./context";
import { fillerWeights } from "./fillers";
import { concepts, cosine, termSimilarities } from "./intents";
import { similarity, traceFeatures } from "./similarity";

export const CLUSTER_THRESHOLD = 0.45;

/** Least mean intent similarity for a cluster to become a suggestion: the requests must share a purpose. */
export const MIN_INTENT_COHESION = 0.2;

/**
 * Least mean intent similarity for two clusters to merge. Sessions that behave alike (read, edit,
 * test) but ask for different things otherwise merge on behavior alone into one mixed cluster,
 * which MIN_INTENT_COHESION then rejects as a whole, losing every workflow inside it. Checked while
 * merging, they stay apart. Set above the suggestion gate so merging stays conservative.
 */
export const MIN_INTENT_LINK = 0.35;

export type Cluster = {
  members: number[];
  /** Mean pairwise hybrid similarity among members (1 for singletons). */
  cohesion: number;
  /** Mean pairwise intent similarity: do the requests share a purpose? */
  intentCohesion: number;
  /** Mean pairwise action-sequence similarity: does the behavior repeat? */
  actionCohesion: number;
};

/**
 * A symmetric similarity matrix that stores each pair once (the upper triangle), with 1 on the
 * diagonal: half the memory of a full n × n table.
 */
export class PairMatrix {
  private readonly values: Float64Array;

  constructor(readonly size: number) {
    this.values = new Float64Array((size * (size - 1)) / 2);
  }

  private index(i: number, j: number): number {
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    return (a * (2 * this.size - a - 1)) / 2 + b - a - 1;
  }

  get(i: number, j: number): number {
    return i === j ? 1 : this.values[this.index(i, j)]!;
  }

  set(i: number, j: number, value: number): void {
    this.values[this.index(i, j)] = value;
  }

  copy(): PairMatrix {
    const m = new PairMatrix(this.size);
    m.values.set(this.values);
    return m;
  }
}

type Matrices = { total: PairMatrix; intent: PairMatrix; actions: PairMatrix };

/**
 * Embedding cosine at or below which two sessions count as unrelated in meaning, when the vectors do
 * not carry their model's own (SessionVectors.floor). Session vectors are centered on the model's
 * reference mean (see centerOnReference in @reflex/embeddings), which removes the direction every
 * coding request shares, so unrelated requests land near zero. Rescaling from this floor puts
 * embeddings on the same 0..1 footing as the lexical signals.
 */
export const EMBEDDING_FLOOR = 0.05;

export function rescaleEmbedding(cos: number, floor = EMBEDDING_FLOOR): number {
  return Math.min(1, Math.max(0, (cos - floor) / (1 - floor)));
}

/**
 * Semantic intent = blend of concept overlap (synonym-aware) and TF-IDF term overlap. With session
 * vectors, intent is the stronger of that lexical match and the embedding match of the two
 * sessions' context documents, so meaning can connect requests that share no words but can never
 * pull apart requests that do. A session without a vector is compared lexically.
 */
export function intentSimilarities(traces: WorkflowTrace[], vectors?: SessionVectors): (i: number, j: number) => number {
  const termSim = termSimilarities(
    traces.map((t) => t.intents),
    traces.every((t) => t.actionSequence) ? fillerWeights(traces) : undefined,
  );
  const conceptVectors = traces.map((t) => concepts(t.intents));
  const embedded = traces.map((t) => vectors?.get(t.sessionId));
  return (i, j) => {
    const lexical = 0.5 * cosine(conceptVectors[i]!, conceptVectors[j]!) + 0.5 * termSim(i, j);
    const a = embedded[i];
    const b = embedded[j];
    return a && b ? Math.max(lexical, rescaleEmbedding(dotProduct(a, b), vectors?.floor)) : lexical;
  };
}

/** Pairwise similarity matrices: O(n^2) pairs, each trace's features worked out once. */
export function similarityMatrices(traces: WorkflowTrace[], vectors?: SessionVectors): Matrices {
  const intentOf = intentSimilarities(traces, vectors);
  const features = traces.map(traceFeatures);
  const n = traces.length;
  const m: Matrices = { total: new PairMatrix(n), intent: new PairMatrix(n), actions: new PairMatrix(n) };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = similarity(traces[i]!, traces[j]!, intentOf(i, j), features[i], features[j]);
      m.total.set(i, j, s.total);
      m.intent.set(i, j, s.intent);
      m.actions.set(i, j, s.actions);
    }
  }
  return m;
}

function meanPairwise(matrix: PairMatrix, members: number[]): number {
  let total = 0;
  let pairs = 0;
  for (let x = 0; x < members.length; x++)
    for (let y = x + 1; y < members.length; y++) {
      total += matrix.get(members[x]!, members[y]!);
      pairs++;
    }
  return pairs ? total / pairs : 1;
}

/**
 * Average-linkage agglomerative clustering: repeatedly merge the two clusters whose members are
 * most similar on average, until no pair reaches the threshold. Two clusters whose requests share
 * too little purpose on average (below `minIntent`) are never merged. Deterministic for a given input.
 */
export function clusterTraces(
  traces: WorkflowTrace[],
  threshold = CLUSTER_THRESHOLD,
  vectors?: SessionVectors,
  minIntent = MIN_INTENT_LINK,
): Cluster[] {
  const sim = similarityMatrices(traces, vectors);
  const n = traces.length;
  const members: (number[] | null)[] = traces.map((_, i) => [i]);
  // link / intentLink = average total / intent similarity between clusters i and j (Lance-Williams update).
  const link = sim.total.copy();
  const intentLink = sim.intent.copy();

  // Each cluster's best partner among the clusters after it: the first j with the highest link
  // that may merge. Merging changes only a few rows, so the best pair overall is found from these
  // n entries instead of from all n^2 pairs, in the same order as scanning every pair.
  const bestJ = new Int32Array(n).fill(-1);
  const bestLink = new Float64Array(n).fill(-1);
  const findBest = (i: number) => {
    bestJ[i] = -1;
    bestLink[i] = -1;
    for (let j = i + 1; j < n; j++) {
      if (!members[j] || intentLink.get(i, j) < minIntent) continue;
      const v = link.get(i, j);
      if (v > bestLink[i]!) {
        bestLink[i] = v;
        bestJ[i] = j;
      }
    }
  };
  for (let i = 0; i < n; i++) findBest(i);

  for (;;) {
    let best = -1;
    let bi = -1;
    for (let i = 0; i < n; i++) {
      if (members[i] && bestJ[i]! >= 0 && bestLink[i]! > best) {
        best = bestLink[i]!;
        bi = i;
      }
    }
    if (bi < 0 || best < threshold) break;
    const bj = bestJ[bi]!;
    const a = members[bi]!;
    const b = members[bj]!;
    for (let k = 0; k < n; k++) {
      if (!members[k] || k === bi || k === bj) continue;
      link.set(bi, k, (a.length * link.get(bi, k) + b.length * link.get(bj, k)) / (a.length + b.length));
      intentLink.set(bi, k, (a.length * intentLink.get(bi, k) + b.length * intentLink.get(bj, k)) / (a.length + b.length));
    }
    members[bi] = [...a, ...b].sort((x, y) => x - y);
    members[bj] = null;
    bestJ[bj] = -1;

    findBest(bi);
    // Rows before bi now have a new link to bi; rows before bj may have pointed at bj.
    for (let k = 0; k < bj; k++) {
      if (!members[k] || k === bi) continue;
      if (bestJ[k] === bi || bestJ[k] === bj) findBest(k);
      else if (k < bi && intentLink.get(k, bi) >= minIntent) {
        const v = link.get(k, bi);
        if (v > bestLink[k]! || (v === bestLink[k]! && bi < bestJ[k]!)) {
          bestLink[k] = v;
          bestJ[k] = bi;
        }
      }
    }
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
