import type { Correction } from "@reflex/core";
import { stem } from "./intents";
import { jaccard } from "./similarity";

export type Constraint = {
  polarity: Correction["polarity"];
  /** Rendered rule built only from words that a pair of independent sessions shared. */
  text: string;
  sessions: number;
};

/** Words that open a clause without changing its meaning. `no need to` is itself a correction. */
const OPENER = /^(?:(?:please|and|but|so|also|then|nope|no(?!\s+need\b))\s+)*/;
const AVOID = /^(?:don['’]?t|do not|never|stop|avoid|no need to)\s+/;
const PREFER = /^(?:always|make sure(?: to| you)?|prefer(?: to)?)\s+/;
const TRAILING_INSTEAD = /\s+instead$/;
const INSTEAD = /\b(?:instead of|rather than)\b/;
const LEAD = /^(?:no|nope|wrong|not that|not like that)$/;
/** A prefer rule is written as an instruction, so it has to open with one of these verbs. */
const PREFER_VERBS = new Set(
  (
    "use run keep add pin write put check test read update edit change rename follow format lint build import mock " +
    "name split reuse match stick include wrap handle start"
  ).split(" "),
);
const FILLER = new Set(
  (
    "a an the to it its this that these those please just you we i me my our your of for in on at and or so is are be " +
    "with again any anything then also really actually here there one ones thing things now pls ok okay"
  ).split(" "),
);
/** A plain word, optionally wrapped in quotes or brackets or followed by a colon. */
const WORD = /^["'(]?([a-z0-9][a-z0-9.-]{0,39}?)[)"':]?$/;
/** The only dotted words kept. Hosts, IP addresses and versions disqualify the clause. */
const FILE_NAME =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:json|jsonc|lock|ya?ml|toml|md|txt|[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift|css|scss|html|sql|graphql|proto|xml|gradle|ini)$/;
const MIN_WORDS = 2;
const MAX_WORDS = 8;
const MAX_PER_SESSION = 8;
const MATCH = 0.5;

function words(text: string): string[] | undefined {
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    // Anything that isn't a plain word (redaction markers, shell syntax, flags, URLs, paths) disqualifies the clause.
    const w = WORD.exec(raw)?.[1];
    if (!w || w.includes("redacted") || (w.includes(".") && !FILE_NAME.test(w))) return undefined;
    if (!FILLER.has(w)) out.push(w);
  }
  return out;
}

function build(polarity: Correction["polarity"], ws: string[] | undefined): Correction | undefined {
  const unique = [...new Set(ws ?? [])];
  if (unique.length < MIN_WORDS) return undefined;
  if (polarity === "prefer" && !PREFER_VERBS.has(unique[0]!)) return undefined;
  return { polarity, words: unique.slice(0, MAX_WORDS) };
}

function correction(text: string, afterLead: boolean): Correction | undefined {
  const clause = text.replace(OPENER, "");
  const avoid = AVOID.exec(clause);
  if (avoid) {
    const rest = clause.slice(avoid[0].length);
    // "don't use npm instead of pnpm" and "never not run tests" read both ways.
    if (INSTEAD.test(rest) || /\bnot\b/.test(rest)) return undefined;
    return build("avoid", words(rest));
  }
  const instead = INSTEAD.exec(clause);
  if (instead) {
    const want = words(clause.slice(0, instead.index).replace(PREFER, ""));
    const over = words(clause.slice(instead.index + instead[0].length));
    if (!want?.length || !over?.length || want.includes("not") || over.includes("not")) return undefined;
    return build("prefer", [...want, "not", ...over]);
  }
  if (PREFER.test(clause) || TRAILING_INSTEAD.test(clause)) {
    return build("prefer", words(clause.replace(PREFER, "").replace(TRAILING_INSTEAD, "")));
  }
  return afterLead ? build("prefer", words(clause)) : undefined;
}

/** Corrections in follow-up requests. The first request is the task itself, not a correction. */
export function extractCorrections(requests: string[]): Correction[] {
  const out: Correction[] = [];
  for (const text of requests.slice(1)) {
    let afterLead = false;
    // Split on sentence punctuation only before whitespace, so `package.json` stays whole. The
    // lookbehind keeps a long run of punctuation from backtracking quadratically.
    for (const part of text.toLowerCase().split(/(?<![.!?;,])[.!?;,]+(?=\s|$)|\n+/)) {
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

/** Stemmed match keys. Words after "not" are the rejected side, so "pnpm not npm" never matches "npm not pnpm". */
function matchKeys(ws: string[]): string[] {
  const not = ws.indexOf("not");
  return ws.map((w, i) => (not >= 0 && i > not ? `~${stem(w)}` : stem(w)));
}

function wellFormed(polarity: Correction["polarity"], ws: string[]): boolean {
  if (ws.length < MIN_WORDS) return false;
  return polarity === "avoid" || (PREFER_VERBS.has(ws[0]!) && ws.at(-1) !== "not");
}

function render(polarity: Correction["polarity"], ws: string[]): string {
  const phrase = ws.join(" ");
  return polarity === "avoid" ? `Don't ${phrase}.` : `${phrase[0]!.toUpperCase()}${phrase.slice(1)}.`;
}

type Rule = { polarity: Correction["polarity"]; words: string[]; sessions: Set<number> };

/**
 * Corrections that recur across independent sessions. Each matching pair yields a rule made of
 * the words both sessions used, so no single session's phrasing reaches the skill.
 */
export function recurringCorrections(perInstance: Correction[][]): Constraint[] {
  const items = perInstance.flatMap((cs, inst) => cs.map((c) => ({ ...c, inst, keys: matchKeys(c.words) })));
  const rules = new Map<string, Rule>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.inst === b.inst || a.polarity !== b.polarity || jaccard(a.keys, b.keys) < MATCH) continue;
      const other = new Set(b.keys);
      const shared = a.words.filter((_, k) => other.has(a.keys[k]!));
      if (!wellFormed(a.polarity, shared)) continue;
      const id = `${a.polarity}:${shared.join(" ")}`;
      const rule = rules.get(id) ?? { polarity: a.polarity, words: shared, sessions: new Set<number>() };
      rule.sessions.add(a.inst).add(b.inst);
      rules.set(id, rule);
    }
  }
  const all = [...rules.values()];
  // A longer variant whose sessions all already back a shorter rule adds nothing.
  const covered = (r: Rule) =>
    all.some(
      (s) =>
        s !== r &&
        s.polarity === r.polarity &&
        s.words.length < r.words.length &&
        s.words.every((w) => r.words.includes(w)) &&
        [...r.sessions].every((x) => s.sessions.has(x)),
    );
  return all
    .filter((r) => !covered(r))
    .map((r) => ({ polarity: r.polarity, text: render(r.polarity, r.words), sessions: r.sessions.size }))
    .sort((a, b) => b.sessions - a.sessions || a.text.localeCompare(b.text));
}
