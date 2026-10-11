import type { ActionCategory, CommandFingerprint, FileOp } from "@reflix/core";

export type FileCategory =
  | "ci-config"
  | "dependency-manifest"
  | "test"
  | "config"
  | "docs"
  | "migration"
  | "logs"
  | "source";

export function fileCategory(path: string): FileCategory {
  const p = path.toLowerCase();
  const name = p.split("/").pop() ?? p;
  if (/(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$|(^|\/)\.circleci\/|jenkinsfile$|azure-pipelines|buildkite/.test(p)) return "ci-config";
  if (
    /^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|requirements.*\.txt|pyproject\.toml|poetry\.lock|pipfile(\.lock)?|cargo\.(toml|lock)|go\.(mod|sum)|gemfile(\.lock)?|pnpm-workspace\.yaml)$/.test(name)
  )
    return "dependency-manifest";
  if (/\.(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?|e2e)\//.test(p) || /^test_.*\.py$/.test(name)) return "test";
  if (/(^|\/)migrations?\/|\.sql$/.test(p)) return "migration";
  if (/\.log$|(^|\/)logs?\//.test(p)) return "logs";
  if (/\.(md|mdx|rst|txt)$|(^|\/)docs\//.test(p)) return "docs";
  if (
    /^(tsconfig.*\.json|\.eslintrc.*|eslint\.config\..*|\.prettierrc.*|vite\.config\..*|vitest\.config\..*|jest\.config\..*|webpack.*|babel\.config\..*|\.babelrc|dockerfile|docker-compose.*|makefile|turbo\.json|\.env.*|.*\.(toml|ini|ya?ml|cfg))$/.test(
      name,
    )
  )
    return "config";
  return "source";
}

export function fileAction(op: FileOp, category: FileCategory): ActionCategory {
  if (op === "read") {
    if (category === "ci-config") return "inspect-ci";
    if (category === "dependency-manifest") return "inspect-dependencies";
    if (category === "logs") return "inspect-logs";
    return "inspect-code";
  }
  if (category === "ci-config") return "modify-ci";
  if (category === "dependency-manifest") return "modify-dependencies";
  if (category === "config") return "modify-config";
  if (category === "test") return "modify-tests";
  return "modify-code";
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const TEST_RUNNERS = new Set(["vitest", "jest", "pytest", "mocha", "rspec", "playwright", "cypress", "ava", "tap"]);
const READERS = new Set(["cat", "sed", "head", "tail", "less", "more", "bat", "nl"]);
const SEARCHERS = new Set(["rg", "grep", "ag", "ack", "fd", "find", "git-grep"]);
const LISTERS = new Set(["ls", "tree", "pwd", "wc", "stat", "du"]);

function scriptAction(script: string): ActionCategory | undefined {
  const s = script.toLowerCase();
  if (/^(test|tests|spec|e2e|test:.*|.*:test)$/.test(s)) return "run-tests";
  if (/^(build|typecheck|type-check|tsc|compile|check-types|build:.*)$/.test(s)) return "run-build";
  if (/^(lint|lint:.*|format|prettier|eslint|check)$/.test(s)) return "run-lint";
  return undefined;
}

/** Split a shell line into the segments that actually run, ignoring pipes' downstream filters. */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((seg) => seg.split("|")[0]!.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  // Drop leading env assignments (FOO=bar cmd) and wrappers that don't change intent.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
  while (tokens.length && ["sudo", "time", "env", "command", "npx", "bunx", "pnpx"].includes(tokens[0]!)) tokens.shift();
  if (tokens[0]) tokens[0] = tokens[0].split("/").pop()!;
  return tokens;
}

function generalizeArg(token: string): string {
  if (token.startsWith("-")) {
    const flag = token.split("=")[0]!;
    return flag.length > 32 ? "<flag>" : flag;
  }
  if (/^["']/.test(token)) return "<str>";
  if (/^https?:\/\//.test(token)) return "<url>";
  if (/^#?\d+$/.test(token)) return "<n>";
  if (/^[0-9a-f]{7,40}$/.test(token)) return "<sha>";
  if (/^(HEAD|main|master|origin)([~^./]|$)|\.\.\./.test(token)) return "<ref>";
  if (/[/.]/.test(token) || /^[\w-]+\.[a-z]{1,5}$/i.test(token)) return "<file>";
  return "<arg>";
}

const REF_FLAGS = new Set(["--branch", "-b", "--base", "--head", "--ref"]);

const SUBCOMMAND_DEPTH: Record<string, number> = { gh: 2, git: 1, docker: 1, kubectl: 1, cargo: 1, go: 1, pip: 1, poetry: 1, make: 1 };

/** `git diff src/a.ts` -> `git diff <file>`; `gh run view 123 --log-failed` -> `gh run view <n> --log-failed`. */
export function normalizeSegment(segment: string): string {
  const tokens = tokenize(segment);
  if (!tokens.length) return "";
  const [program, ...rest] = tokens;
  const depth = PACKAGE_MANAGERS.has(program!) ? (rest[0] === "run" || rest[0] === "exec" ? 2 : 1) : (SUBCOMMAND_DEPTH[program!] ?? 0);
  const head = [program!, ...rest.slice(0, depth).filter((t) => !t.startsWith("-"))];
  const args: string[] = [];
  let prev = "";
  for (const t of rest.slice(head.length - 1)) {
    const g = REF_FLAGS.has(prev) && !t.startsWith("-") ? "<ref>" : generalizeArg(t);
    if (args[args.length - 1] !== g) args.push(g);
    prev = t;
  }
  return [...head, ...args].join(" ").slice(0, 120);
}

function classifySegment(tokens: string[]): ActionCategory {
  const [program = "", sub = "", sub2 = ""] = tokens;
  const argText = tokens.slice(1).join(" ");
  const targetCategory = () => {
    const target = [...tokens].reverse().find((t) => !t.startsWith("-") && /[/.]/.test(t));
    return target ? fileCategory(target.replace(/^["']|["']$/g, "")) : undefined;
  };

  if (program === "git") {
    if (sub === "diff") return "inspect-diff";
    if (sub === "commit") return "commit";
    if (sub === "push") return "push";
    if (sub === "grep") return "search-code";
    return "inspect-git";
  }
  if (program === "gh") {
    if (sub === "run" || sub === "workflow" || (sub === "pr" && sub2 === "checks")) return "inspect-ci";
    if (sub === "pr" && (sub2 === "review" || sub2 === "comment")) return "submit-review";
    if (sub === "pr" || sub === "issue") return "inspect-pr";
    return "run-command";
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const script = sub === "run" || sub === "exec" ? sub2 : sub;
    if (["install", "i", "ci", "add", "remove", "rm", "update", "up", "upgrade", "dedupe", ""].includes(script)) return "install-dependencies";
    if (["why", "ls", "list", "outdated", "explain", "audit", "info", "view"].includes(script)) return "inspect-dependencies";
    if (TEST_RUNNERS.has(script)) return "run-tests";
    if (script === "tsc") return "run-build";
    if (script === "eslint" || script === "prettier") return "run-lint";
    return scriptAction(script) ?? "run-command";
  }
  if (TEST_RUNNERS.has(program)) return "run-tests";
  if (program === "tsc") return "run-build";
  if (program === "eslint" || program === "prettier" || program === "ruff") return "run-lint";
  if ((program === "go" || program === "cargo") && sub === "test") return "run-tests";
  if ((program === "go" || program === "cargo") && (sub === "build" || sub === "check")) return "run-build";
  if ((program === "go" && sub === "mod" && sub2 === "why") || (program === "cargo" && sub === "tree") || (program === "pip" && (sub === "show" || sub === "list")))
    return "inspect-dependencies";
  if ((program === "pip" || program === "poetry") && sub === "install") return "install-dependencies";
  if (program === "make") return scriptAction(sub) ?? "run-command";
  if (program === "rm" && /node_modules|\.venv|target\b/.test(argText)) return "install-dependencies";
  if ((program === "kubectl" || program === "docker") && sub === "logs") return "inspect-logs";
  if (program === "journalctl") return "inspect-logs";
  if (SEARCHERS.has(program)) return "search-code";
  if (READERS.has(program) || LISTERS.has(program)) {
    const cat = targetCategory();
    if (cat === "ci-config" || /\.github\/workflows/.test(argText)) return "inspect-ci";
    if (cat === "dependency-manifest") return "inspect-dependencies";
    if (cat === "logs") return "inspect-logs";
    return READERS.has(program) ? "inspect-code" : "inspect-repository";
  }
  return "run-command";
}

export function classifyCommand(command: string): CommandFingerprint[] {
  const out: CommandFingerprint[] = [];
  for (const seg of commandSegments(command)) {
    const tokens = tokenize(seg);
    if (!tokens.length) continue;
    const normalized = normalizeSegment(seg);
    out.push({ normalized, action: classifySegment(tokens) });
  }
  return out;
}

/** Coarse operation key used for command/tool similarity, comparable across agents. */
export function opKey(fp: CommandFingerprint): string {
  if (fp.action === "inspect-code") return "read-file";
  if (fp.action === "search-code") return "search";
  return fp.normalized.split(" ").filter((t) => !t.startsWith("<") && !t.startsWith("-")).slice(0, 3).join(" ");
}

export const VERIFY_ACTIONS: ReadonlySet<ActionCategory> = new Set(["run-tests", "run-build", "run-lint"]);
export const MODIFY_ACTIONS: ReadonlySet<ActionCategory> = new Set([
  "modify-code",
  "modify-tests",
  "modify-config",
  "modify-ci",
  "modify-dependencies",
]);
