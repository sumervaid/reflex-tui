import type { NormalizedSession, WorkflowTrace } from "@reflex/core";
import { sha256 } from "@reflex/core";
import { excerpt } from "@reflex/safety";

/** Sentence vectors keyed by session id. Unit length, so a dot product is the cosine. */
export type SessionVectors = ReadonlyMap<string, ArrayLike<number>>;

/**
 * Request characters given to the embedding model: about its 256-token input limit. The stored
 * excerpt (180 characters, for display) is too short; real requests often open with context and
 * state the task later.
 */
export const CONTEXT_CHARS = 1000;

/**
 * What a session was about, in plain text, for a sentence-embedding model: the redacted first
 * request (up to CONTEXT_CHARS) and the kinds of files the agent touched. Actions are left out on
 * purpose: they already have their own weight in the similarity, and embedding them as well made
 * unrelated sessions with similar steps (read, edit, test) look alike in meaning. Without the
 * request text (sessions stored before it was kept), the display excerpt stands in.
 */
export function contextDocument(t: Pick<WorkflowTrace, "excerpt" | "fileCategories">, request?: string): string {
  const text = request === undefined ? t.excerpt.trim() : excerpt(request, CONTEXT_CHARS);
  const files = t.fileCategories.map((f) => f.replace(/-/g, " "));
  return files.length ? `${text}\nFiles: ${files.join(", ")}.` : text;
}

/** The context document of a parsed session, which still holds the full (redacted) request text. */
export function sessionContext(session: Pick<NormalizedSession, "requests">, t: Pick<WorkflowTrace, "excerpt" | "fileCategories">): string {
  return contextDocument(t, session.requests[0]?.text ?? "");
}

/** Identifies a context document without storing its text, so later commands can find its vector. */
export function contextHash(doc: string): string {
  return sha256(doc);
}

export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
