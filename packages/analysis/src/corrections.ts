import type { Correction } from "@reflex/core";

export type Constraint = {
  polarity: Correction["polarity"];
  /** Rendered rule built only from words that recurred across sessions. */
  text: string;
  sessions: number;
};

const AVOID = /\b(?:don['’]?t|do not|never|stop|avoid|shouldn['’]?t|should not|no need to)\b\s*/;
const INSTEAD = /\b(?:instead of|rather than)\b/;
const PREFER = /\b(?:instead|always|make sure(?: to| you)?|prefer)\b\s*/;
const LEAD = /^(?:no|nope|wrong|not that|not like that)$/;
const FILLER = new Set(
  (
    "a an the to it its this that these those please just you we i me my our your of for in on at and or so is are be " +
    "with again any anything then also really actually here there one ones thing things now pls ok okay"
  ).split(" "),
);
/** A plain word, optionally wrapped in quotes or brackets or followed by a colon. */
const WORD = /^["'(]?([a-z0-9][a-z0-9._/-]{0,39}?)[)"':]?$/;
const MIN_WORDS = 2;
const MAX_WORDS = 8;
const MAX_PER_SESSION = 8;
const MATCH = 0.5;

function words(text: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    // Anything that isn't a plain word (redaction markers, shell syntax, flags, URLs) disqualifies the clause.
    const w = WORD.exec(raw)?.[1];
    if (!w || w.includes("redacted")) return undefined;
    if (!FILLER.has(w)) out.push(w);
  }
  return out;
}

function correction(clause: string, afterLead: boolean): Correction | undefined {
  let polarity: Correction["polarity"];
  let ws: string[] | undefined;
  const avoid = AVOID.exec(clause);
  const instead = INSTEAD.exec(clause);
  if (avoid) {
    polarity = "avoid";
    ws = words(clause.slice(avoid.index + avoid[0].length));
  } else if (instead) {
    polarity = "prefer";
    const before = words(clause.slice(0, instead.index));
    const after = words(clause.slice(instead.index + instead[0].length));
    ws = before && after ? [...before, ...(after.length ? ["not", ...after] : [])] : undefined;
  } else if (PREFER.test(clause)) {
    polarity = "prefer";
    ws = words(clause.replace(PREFER, " "));
  } else if (afterLead) {
    polarity = "prefer";
    ws = words(clause);
  } else return undefined;
  if (!ws || ws.length < MIN_WORDS) return undefined;
  return { polarity, words: ws.slice(0, MAX_WORDS) };
}

/** Corrections in follow-up requests. The first request is the task itself, not a correction. */
export function extractCorrections(requests: string[]): Correction[] {
  const out: Correction[] = [];
  for (const text of requests.slice(1)) {
    let afterLead = false;
    // Split on sentence punctuation only before whitespace, so `package.json` and URLs stay whole.
    for (const part of text.toLowerCase().split(/[.!?;,]+(?=\s|$)|\n+/)) {
      const clause = part.trim();
      if (!clause) continue;
      if (LEAD.test(clause)) {
        afterLead = true;
        continue;
      }
      const c = correction(clause, afterLead);
      afterLead = false;
      if (c) out.push(c);
      if (out.length >= MAX_PER_SESSION) return out;
    }
  }
  return out;
}

function jaccard(a: string[], b: string[]): { score: number; shared: number } {
  const A = new Set(a);
  const B = new Set(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return { score: shared / (A.size + B.size - shared || 1), shared };
}

/**
 * Corrections that recur across independent sessions. A rule keeps only the words that appeared in
 * at least `minSessions` sessions, so no single session's phrasing reaches the skill.
 */
export function recurringCorrections(perInstance: Correction[][], minSessions = 2): Constraint[] {
  const items = perInstance.flatMap((cs, inst) => cs.map((c) => ({ ...c, inst })));
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.inst === b.inst || a.polarity !== b.polarity) continue;
      const { score, shared } = jaccard(a.words, b.words);
      if (score >= MATCH && shared >= MIN_WORDS) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, typeof items>();
  items.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]));

  const out: Constraint[] = [];
  for (const group of groups.values()) {
    const sessions = new Set(group.map((g) => g.inst)).size;
    if (sessions < minSessions) continue;
    const seenIn = new Map<string, Set<number>>();
    for (const g of group) for (const w of g.words) seenIn.set(w, (seenIn.get(w) ?? new Set()).add(g.inst));
    const ordered = [...new Set(group.flatMap((g) => g.words))].filter((w) => seenIn.get(w)!.size >= minSessions);
    if (ordered.length < MIN_WORDS) continue;
    const phrase = ordered.join(" ");
    const text = group[0]!.polarity === "avoid" ? `Don't ${phrase}.` : `${phrase[0]!.toUpperCase()}${phrase.slice(1)}.`;
    out.push({ polarity: group[0]!.polarity, text, sessions });
  }
  return out.sort((a, b) => b.sessions - a.sessions || a.text.localeCompare(b.text));
}
