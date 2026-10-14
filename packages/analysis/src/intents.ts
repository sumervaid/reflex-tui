import { isForeignStopword, koreanStem, latinLanguage, meaningfulSingle, splitUnspaced } from "./languages";

const STOPWORDS = new Set(
  (
    "a an the and or but if then so to of in on at by for with from into onto about as is are was were be been being am " +
    "it its this that these those there here i me my mine we us our you your he she they them their what which who whom " +
    "why how when where can could would should will shall may might must do does did done doing have has had having " +
    "please pls help figure out look looking see seem seems seemed get got make made just still again also really very " +
    "some any all every each more most other such only own same than too can't cant don't dont won't isnt isn't im i'm " +
    "it's thing things stuff want need like know before after while because over under up down now new one two vs " +
    "let lets let's try trying anymore keep keeps kept anything everything something sure ok okay hey hi thanks thank " +
    "weird going went via what's says prints"
  ).split(/\s+/),
);

/** Fold common phrasings of the same concept onto one term. Applied to lowercased text. */
const PHRASES: Array<[RegExp, string]> = [
  [/\bgithub actions?\b|\bgh actions?\b|\bworkflow runs?\b|\bci\/cd\b|\bpipelines?\b|\bchecks\b/g, " ci "],
  [/\bpull requests?\b|\bmerge requests?\b|\bprs\b/g, " pr "],
  [/\bcode review\b|\blook over\b|\blook at the changes\b/g, " review "],
  [/\bpeer dep(endenc(y|ies))?\b|\bdeps\b|\bdependenc(y|ies)\b|\bpackages?\b|\bmodules?\b/g, " dependency "],
  [/\block ?files?\b|\bpnpm-lock\b|\bpackage-lock\b|\byarn\.lock\b/g, " lockfile "],
];

const CANONICAL: Record<string, string> = {
  failing: "fail",
  fails: "fail",
  failed: "fail",
  failure: "fail",
  failures: "fail",
  broken: "fail",
  broke: "fail",
  breaks: "fail",
  break: "fail",
  red: "fail",
  error: "fail",
  errors: "fail",
  crash: "fail",
  crashing: "fail",
  reviewing: "review",
  reviews: "review",
  approve: "review",
  bugs: "bug",
  builds: "build",
  building: "build",
  installs: "install",
  installing: "install",
  installed: "install",
  upgrade: "upgrade",
  upgrading: "upgrade",
  bump: "upgrade",
  bumping: "upgrade",
  bumped: "upgrade",
  versions: "version",
  tests: "test",
  testing: "test",
  resolve: "resolve",
  resolving: "resolve",
  unresolved: "resolve",
  logs: "log",
  deploys: "deploy",
  deploying: "deploy",
  migrations: "migration",
  releases: "release",
  releasing: "release",
};

export function intentTerms(text: string): string[] {
  let t = text.toLowerCase();
  t = t.replace(/https?:\/\/\S+/g, " ").replace(/\[redacted[^\]]*\]|\[email\]|\[REDACTED[^\]]*\]/gi, " ");
  for (const [re, rep] of PHRASES) t = t.replace(re, rep);
  // Words in scripts written without spaces (Japanese, Chinese, Thai) are split by the platform's segmenter.
  const words = t
    .split(/[^\p{L}\p{N}\p{M}#@'-]+/u)
    .flatMap(splitUnspaced)
    .map((w) => koreanStem(w.replace(/^['#-]+|['-]+$/g, "")));
  const latinLang = latinLanguage(words);
  const out: string[] = [];
  for (let w of words) {
    if ((w.length < 2 && !meaningfulSingle(w)) || /^\d+$/.test(w) || STOPWORDS.has(w) || isForeignStopword(w, latinLang, DEVELOPER_WORDS)) continue;
    w = CANONICAL[w] ?? w;
    if (STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

const VOWEL = /[aeiouy]/;

/**
 * Light inflectional stemmer, so "loads", "loaded" and "loading" match. Used only for matching:
 * stored and displayed terms keep their surface form, so stems need not be real words.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length < 4 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const suffix of ["ing", "ed"]) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, -suffix.length);
    // "string", "need", "speed": too short, no vowel, or a doubled e means it is not an inflection.
    if (base.length < 3 || !VOWEL.test(base) || (suffix === "ed" && base.endsWith("e"))) break;
    // "running" -> "run", but "added" stays "add" and "installed" keeps its "ll".
    w = base.length >= 4 && /([^aeiouylsz])\1$/.test(base) ? base.slice(0, -1) : base;
    break;
  }
  // Drop a final silent e so "change", "changes" and "changing" share "chang".
  if (w.length >= 4 && w.endsWith("e") && !w.endsWith("ee")) w = w.slice(0, -1);
  return w;
}

export function bigrams(stems: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < stems.length; i++) out.push(`${stems[i - 1]} ${stems[i]}`);
  return out;
}

/** How much a shared phrase can lift term similarity. */
const BIGRAM_BLEND = 0.3;

/**
 * TF-IDF similarity over stemmed terms. Adjacent-pair bigrams ("login pag") can raise a score when
 * requests share a phrase, but never lower it: requests that share words in a different order
 * score exactly as they would on words alone.
 */
export function termSimilarities(termLists: string[][], weights?: ReadonlyMap<string, number>): (i: number, j: number) => number {
  const stems = termLists.map((terms) => terms.map(stem));
  const words = buildTfIdf(stems, weights && new Map([...weights].map(([t, w]) => [stem(t), w]))).vectors;
  const pairs = buildTfIdf(stems.map(bigrams)).vectors;
  return (i, j) => {
    const w = cosine(words[i]!, words[j]!);
    return w + BIGRAM_BLEND * cosine(pairs[i]!, pairs[j]!) * (1 - w);
  };
}

/** Small developer-workflow lexicon: different words for the same purpose map to one concept. */
const CONCEPT_WORDS: Record<string, string[]> = {
  ci: ["ci", "workflow", "workflows", "job", "jobs", "runner", "action", "actions", "pipeline"],
  failure: ["fail", "bug", "issue", "problem", "cannot", "wrong", "fix", "broken", "debug", "resolve"],
  build: ["build", "compile", "typecheck", "tsc", "types", "type", "bundle", "webpack", "vite"],
  lint: ["lint", "eslint", "prettier", "format", "formatting"],
  test: ["test", "spec", "e2e", "suite", "coverage", "jest", "vitest", "pytest"],
  dependency: ["dependency", "install", "lockfile", "version", "upgrade", "peer", "pnpm", "npm", "yarn", "node_modules", "react", "zod"],
  review: ["review", "pr", "comment", "comments", "feedback", "diff", "changes"],
  merge: ["merge", "merged", "merging", "branch", "main", "master"],
  explain: ["explain", "walk", "understand", "works", "overview", "new", "means"],
  deploy: ["deploy", "production", "prod", "incident", "outage", "release", "staging"],
  logs: ["log", "trace", "stack", "stacktrace"],
  migration: ["migration", "schema", "sql", "index", "table", "column", "database", "db"],
  docs: ["readme", "docs", "documentation", "section"],
  refactor: ["rename", "refactor", "convert", "cleanup", "move", "extract", "everywhere"],
  feature: ["add", "implement", "create", "toggle", "page", "feature", "component"],
};

const CONCEPT_OF = new Map<string, string>();
/** Words of the developer lexicon and canonical forms: kept even where another language lists them as stopwords. */
export const DEVELOPER_WORDS = new Set([...Object.values(CONCEPT_WORDS).flat(), ...Object.values(CANONICAL)]);
for (const [concept, words] of Object.entries(CONCEPT_WORDS)) for (const w of words) CONCEPT_OF.set(w, concept);

export function concepts(terms: string[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of terms) {
    // Fall back to the stem only against exact lexicon words ("comments" -> "comment"); stemming
    // the lexicon itself would let "works" (explain) capture "working".
    const c = t.startsWith("@") ? "dependency" : (CONCEPT_OF.get(t) ?? CONCEPT_OF.get(stem(t)));
    if (c) v.set(c, (v.get(c) ?? 0) + 1);
  }
  let norm = 0;
  for (const w of v.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  for (const [k, w] of v) v.set(k, w / norm);
  return v;
}

export type TfIdfModel = { idf: Map<string, number>; vectors: Map<string, number>[] };

/** `weights` scales individual terms (1 when absent), e.g. to quiet words learned to be filler. */
export function buildTfIdf(docs: string[][], weights?: ReadonlyMap<string, number>): TfIdfModel {
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log((n + 1) / (count + 1)) + 1);
  const vectors = docs.map((doc) => {
    const tf = new Map<string, number>();
    for (const term of doc) tf.set(term, (tf.get(term) ?? 0) + 1);
    const v = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of tf) {
      const w = (1 + Math.log(count)) * (idf.get(term) ?? 1) * (weights?.get(term) ?? 1);
      v.set(term, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [term, w] of v) v.set(term, w / norm);
    return v;
  });
  return { idf, vectors };
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, w] of small) dot += w * (large.get(term) ?? 0);
  return dot;
}
