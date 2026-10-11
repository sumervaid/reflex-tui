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
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function lcsLength<T>(a: T[], b: T[]): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev = cur;
  }
  return prev[b.length]!;
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

function sequenceAgreement(x: string[], y: string[]): number {
  if (!x.length || !y.length) return 0;
  const lcs = (2 * lcsLength(x, y)) / (x.length + y.length);
  return 0.5 * lcs + 0.5 * jaccard(x, y);
}

/** Order-aware (LCS) and order-free (set overlap) agreement, at fine and coarse granularity. */
export function actionSimilarity(a: string[], b: string[]): number {
  const x = a.filter((s) => s !== "summarize");
  const y = b.filter((s) => s !== "summarize");
  const coarse = (s: string[]) => collapse(s.map((v) => COARSE[v] ?? v));
  return 0.5 * sequenceAgreement(x, y) + 0.5 * sequenceAgreement(coarse(x), coarse(y));
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

export function similarity(
  a: WorkflowTrace,
  b: WorkflowTrace,
  intentScore: number,
  keysA: Set<string> = opKeys(a),
  keysB: Set<string> = opKeys(b),
): SimilarityParts {
  const parts = {
    intent: intentScore,
    actions: actionSimilarity(a.actionSequence, b.actionSequence),
    commands: jaccard(keysA, keysB),
    files: jaccard(a.fileCategories, b.fileCategories),
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
