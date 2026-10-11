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
  const words = t.split(/[^\p{L}\p{N}#@'-]+/u);
  const out: string[] = [];
  for (let w of words) {
    w = w.replace(/^['#-]+|['-]+$/g, "");
    if (w.length < 2 || /^\d+$/.test(w) || STOPWORDS.has(w)) continue;
    w = CANONICAL[w] ?? w;
    if (STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
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
for (const [concept, words] of Object.entries(CONCEPT_WORDS)) for (const w of words) CONCEPT_OF.set(w, concept);

export function concepts(terms: string[]): Map<string, number> {
  const v = new Map<string, number>();
  for (const t of terms) {
    const c = t.startsWith("@") ? "dependency" : CONCEPT_OF.get(t);
    if (c) v.set(c, (v.get(c) ?? 0) + 1);
  }
  let norm = 0;
  for (const w of v.values()) norm += w * w;
  norm = Math.sqrt(norm) || 1;
  for (const [k, w] of v) v.set(k, w / norm);
  return v;
}

export type TfIdfModel = { idf: Map<string, number>; vectors: Map<string, number>[] };

export function buildTfIdf(docs: string[][]): TfIdfModel {
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
      const w = (1 + Math.log(count)) * (idf.get(term) ?? 1);
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
