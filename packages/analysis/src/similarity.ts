import type { WorkflowTrace } from "@reflex/core";
import { opKey } from "./classify";

/**
 * Ranking heuristic, not a calibrated probability. Weights were chosen as starting points and
 * checked against the fixture families (see test/workflow.test.ts).
 */
export const WEIGHTS = {
  intent: 0.4,
  actions: 0.3,
  commands: 0.15,
  files: 0.1,
  repository: 0.05,
} as const;

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  return setJaccard(new Set(a), new Set(b));
}

function setJaccard<T>(A: ReadonlySet<T>, B: ReadonlySet<T>): number {
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Two rows of the LCS table, reused across calls: clustering compares every pair of sessions. */
let lcsRows = new Int32Array(0);

export function lcsLength<T>(a: T[], b: T[]): number {
  if (!a.length || !b.length) return 0;
  const width = b.length + 1;
  if (lcsRows.length < 2 * width) lcsRows = new Int32Array(2 * width);
  const rows = lcsRows;
  let prev = 0;
  let cur = width;
  rows.fill(0, prev, prev + width);
  for (let i = 1; i <= a.length; i++) {
    rows[cur] = 0;
    for (let j = 1; j <= b.length; j++) {
      rows[cur + j] = a[i - 1] === b[j - 1] ? rows[prev + j - 1]! + 1 : Math.max(rows[prev + j]!, rows[cur + j - 1]!);
    }
    const done = prev;
    prev = cur;
    cur = done;
  }
  return rows[prev + b.length]!;
}

/** Coarse behavior classes, so "patched config" and "patched code" still count as the same step shape. */
const COARSE: Record<string, string> = {
  "inspect-git": "git",
  "inspect-diff": "changes",
  "inspect-pr": "changes",
  "inspect-ci": "ci",
  "inspect-code": "read",
  "search-code": "read",
  "inspect-repository": "read",
  "inspect-dependencies": "deps",
  "install-dependencies": "deps",
  "modify-code": "modify",
  "modify-tests": "modify",
  "modify-config": "modify",
  "modify-ci": "modify",
  "modify-dependencies": "modify",
  "run-tests": "verify",
  "run-build": "verify",
  "run-lint": "verify",
};

function collapse(seq: string[]): string[] {
  return seq.filter((s, i) => i === 0 || seq[i - 1] !== s);
}

/** A sequence and its set of steps. */
type Steps = { seq: string[]; set: Set<string> };

/** An action sequence as actionSimilarity compares it, at fine and coarse granularity. */
type ActionShape = { fine: Steps; coarse: Steps };

const steps = (seq: string[]): Steps => ({ seq, set: new Set(seq) });

function actionShape(sequence: string[]): ActionShape {
  const fine = sequence.filter((s) => s !== "summarize");
  return { fine: steps(fine), coarse: steps(collapse(fine.map((v) => COARSE[v] ?? v))) };
}

function sequenceAgreement(x: Steps, y: Steps): number {
  if (!x.seq.length || !y.seq.length) return 0;
  const lcs = (2 * lcsLength(x.seq, y.seq)) / (x.seq.length + y.seq.length);
  return 0.5 * lcs + 0.5 * setJaccard(x.set, y.set);
}

function shapeSimilarity(a: ActionShape, b: ActionShape): number {
  return 0.5 * sequenceAgreement(a.fine, b.fine) + 0.5 * sequenceAgreement(a.coarse, b.coarse);
}

/** Order-aware (LCS) and order-free (set overlap) agreement, at fine and coarse granularity. */
export function actionSimilarity(a: string[], b: string[]): number {
  return shapeSimilarity(actionShape(a), actionShape(b));
}

export type SimilarityParts = {
  intent: number;
  actions: number;
  commands: number;
  files: number;
  repository: number;
  total: number;
};

export function opKeys(t: WorkflowTrace): Set<string> {
  const keys = new Set(t.commands.map(opKey));
  for (const tool of t.tools) {
    if (tool === "file-read") keys.add("read-file");
    else if (tool === "file-edit" || tool === "file-write") keys.add("edit-file");
    else if (tool === "Grep" || tool === "Glob") keys.add("search");
  }
  keys.delete("");
  return keys;
}

/** What `similarity` compares in one trace, worked out once instead of for every pair. */
export type TraceFeatures = { actions: ActionShape; keys: Set<string>; files: Set<string> };

export function traceFeatures(t: WorkflowTrace): TraceFeatures {
  return { actions: actionShape(t.actionSequence), keys: opKeys(t), files: new Set(t.fileCategories) };
}

export function similarity(
  a: WorkflowTrace,
  b: WorkflowTrace,
  intentScore: number,
  fa: TraceFeatures = traceFeatures(a),
  fb: TraceFeatures = traceFeatures(b),
): SimilarityParts {
  const parts = {
    intent: intentScore,
    actions: shapeSimilarity(fa.actions, fb.actions),
    commands: setJaccard(fa.keys, fb.keys),
    files: setJaccard(fa.files, fb.files),
    repository: a.projectHash && a.projectHash === b.projectHash ? 1 : 0,
  };
  const total =
    WEIGHTS.intent * parts.intent +
    WEIGHTS.actions * parts.actions +
    WEIGHTS.commands * parts.commands +
    WEIGHTS.files * parts.files +
    WEIGHTS.repository * parts.repository;
  return { ...parts, total };
}
