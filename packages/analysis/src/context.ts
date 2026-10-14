import type { NormalizedSession, WorkflowTrace } from "@reflex/core";
import { sha256 } from "@reflex/core";
import { excerpt } from "@reflex/safety";

/** Sentence vectors keyed by session id. Unit length, so a dot product is the cosine. */
export type SessionVectors = ReadonlyMap<string, ArrayLike<number>>;

/**
 * Request characters given to the embedding model: all the adapters keep. The model reads as many
 * tokens of it as fit its own input limit (256 for the default model), so no budget is wasted on a
 * character count that suits one language or writing style: 1,000 characters of English prose is
 * about 216 tokens, of code-heavy text about 340, of Korean about 1,200.
 */
export const CONTEXT_CHARS = 2000;

/** A pasted line that carries no request: stack frames, timestamped logs, test-runner output, symbol soup. */
function isNoiseLine(line: string): boolean {
  return (
    /^\s*at\s/.test(line) ||
    /\d{4}-\d\d-\d\dT\d\d:\d\d/.test(line) ||
    /^\s*[✓✗✔✘×√]\s/.test(line) ||
    /^\s*\[[\w-]+\]/.test(line) ||
    // Mostly digits and symbols. Letters of any script count, so non-English text is never noise.
    (line.length > 30 && (line.match(/\p{L}{2,}/gu) ?? []).join("").length / line.length < 0.4)
  );
}

/**
 * The words of a request without pasted code blocks, stack frames and log output, which otherwise
 * fill the model's token budget before the task is stated. Error messages themselves stay. A
 * request that is nothing but such output is kept as it is.
 */
export function requestWords(text: string): string {
  const kept = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .split("\n")
    .filter((line) => !isNoiseLine(line))
    .join("\n")
    .replace(/\bat [\w.<>$]+ \([^)]*:\d+:\d+\)/g, " ")
    .trim();
  return kept || text;
}

/**
 * What a session was about, in plain text, for a sentence-embedding model: the kinds of files the
 * agent touched, then the redacted opening request(s) without pasted output (see requestWords). Files
 * come first so a long request, cut at the model's token limit, never loses them. Actions are left
 * out on purpose: they already have their own weight in the similarity, and embedding them as well
 * made unrelated sessions with similar steps (read, edit, test) look alike in meaning. Without the
 * request text (sessions stored before it was kept), the display excerpt stands in.
 */
export function contextDocument(t: Pick<WorkflowTrace, "excerpt" | "fileCategories">, request?: string): string {
  const text = request === undefined ? t.excerpt.trim() : excerpt(requestWords(request), CONTEXT_CHARS);
  const files = t.fileCategories.map((f) => f.replace(/-/g, " "));
  return files.length ? `Files: ${files.join(", ")}.\n${text}` : text;
}

/**
 * Requests of a session that go into its context document. The second one is included because a
 * first message is often only an opener ("get familiar with the repo first") and the task follows;
 * on the evaluation set it raised clustering F1 from 0.68 to 0.70, and a third added nothing.
 */
export const CONTEXT_REQUESTS = 2;

/** The context document of a parsed session, which still holds the full (redacted) request text. */
export function sessionContext(session: Pick<NormalizedSession, "requests">, t: Pick<WorkflowTrace, "excerpt" | "fileCategories">): string {
  return contextDocument(t, session.requests.slice(0, CONTEXT_REQUESTS).map((r) => r.text).join("\n"));
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
