import type { WorkflowTrace } from "@reflex/core";

/** Sentence vectors keyed by session id. Unit length, so a dot product is the cosine. */
export type SessionVectors = ReadonlyMap<string, ArrayLike<number>>;

/**
 * What a session was about, in plain text, for a sentence-embedding model: the (already redacted)
 * first request and the kinds of files the agent touched. Actions are left out on purpose: they
 * already have their own weight in the similarity, and embedding them as well made unrelated
 * sessions with similar steps (read, edit, test) look alike in meaning.
 */
export function contextDocument(t: WorkflowTrace): string {
  const files = t.fileCategories.map((f) => f.replace(/-/g, " "));
  return files.length ? `${t.excerpt.trim()}\nFiles: ${files.join(", ")}.` : t.excerpt.trim();
}

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
