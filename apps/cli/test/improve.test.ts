import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LEARNED_START } from "@reflex/skills";
import { scan } from "../src/commands/scan";
import { improve } from "../src/commands/improve";

let root: string;
let output = "";
const capture = async (fn: () => Promise<void>) => {
  output = "";
  await fn();
  return output;
};
const skillFile = () => join(root, "claude-skills", "rca", "SKILL.md");
const SKILL = [
  "---",
  "name: rca",
  "description: Root-cause a failure",
  "---",
  "",
  "1. Read the error.",
  "2. Run the tests to confirm the fix.",
  "3. Push the fix to the release branch.",
  "",
  "## Output format",
  "",
  "## Root cause",
  "- what broke, when",
  "",
].join("\n");

/** Stands in for `claude -p`: answers in the skill's format, or adds a section when the proposal is installed and FAKE_SHAPE=differ. */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$FAKE_SHAPE" = differ ] && grep -q "reflex:learned" .claude/skills/rca/SKILL.md; then
  body='## Root cause\\n\\nRetries at 12:0'$$'\\n\\n- y\\n\\n## Extra\\n\\n- z'
else
  body='## Root cause\\n\\nRetries at 12:0'$$'\\n\\n- y'
fi
printf '{"type":"result","is_error":false,"num_turns":2,"total_cost_usd":0.5,"result":"%s"}\\n' "$body"
`;
let repo: string;
const PATH = process.env.PATH;

/** A Claude Code session that loads the `rca` skill, reads the failed CI run, edits code and runs the tests. */
function session(id: string, minutesAgo: number, prompt: string): string {
  const t = (s: number) => new Date(Date.now() - minutesAgo * 60_000 + s * 1000).toISOString();
  const base = { sessionId: id, cwd: "/Users/dev/code/app" };
  let n = 0;
  const tool = (name: string, input: Record<string, unknown>) => ({
    ...base,
    type: "assistant",
    timestamp: t(++n),
    message: { role: "assistant", content: [{ type: "tool_use", id: `${id}-${n}`, name, input }] },
  });
  return [
    { ...base, type: "user", timestamp: t(0), message: { role: "user", content: prompt } },
    tool("Skill", { skill: "rca" }),
    tool("Bash", { command: "gh run view 4512 --log-failed" }),
    tool("Read", { file_path: "/Users/dev/code/app/src/retry.ts" }),
    tool("Edit", { file_path: "/Users/dev/code/app/src/retry.ts", old_string: "a", new_string: "b" }),
    tool("Bash", { command: "pnpm test" }),
    { ...base, type: "user", timestamp: t(9), message: { role: "user", content: "don't touch the lockfile" } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-improve-"));
  process.env.REFLEX_HOME = join(root, "home");
  process.env.REFLEX_CLAUDE_SKILLS_DIR = join(root, "claude-skills");
  process.env.REFLEX_CODEX_SKILLS_DIR = join(root, "codex-skills");
  process.env.REFLEX_CURSOR_SKILLS_DIR = join(root, "cursor-skills");
  await mkdir(join(root, "claude-skills", "rca"), { recursive: true });
  await writeFile(skillFile(), SKILL);
  const dir = join(root, "claude", "-Users-dev-code-app");
  await mkdir(dir, { recursive: true });
  const prompts = ["CI is red on main, find the root cause", "the deploy job failed, root-cause it", "nightly build broke, find out why"];
  for (const [i, p] of prompts.entries()) await writeFile(join(dir, `s${i}.jsonl`), session(`s${i}`, 60 * (i + 1), p) + "\n");
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  await scan({ days: 7, claudeDir: join(root, "claude"), source: ["claude-code"], yes: true });

  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), FAKE_CLAUDE);
  await chmod(join(bin, "claude"), 0o755);
  process.env.PATH = `${bin}${delimiter}${PATH}`;
  repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "# app\n");
  const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});

afterAll(async () => {
  vi.restoreAllMocks();
  process.env.PATH = PATH;
  for (const k of ["REFLEX_CLAUDE_SKILLS_DIR", "REFLEX_CODEX_SKILLS_DIR", "REFLEX_CURSOR_SKILLS_DIR"]) delete process.env[k];
  await rm(root, { recursive: true, force: true });
});

describe("reflex improve", () => {
  it("lists your skills with the sessions that loaded them, reading no skill file", async () => {
    const text = await capture(() => improve(undefined, {}));
    expect(text).toContain("Your skills");
    expect(text).toMatch(/rca\s+Claude Code\s+loaded in 3 sessions/);
  });

  it("asks before reading, and changes nothing without consent", async () => {
    const text = await capture(() => improve("rca", {}));
    expect(text).toContain("no (not interactive; pass --yes to consent)");
    expect(await readFile(skillFile(), "utf8")).toBe(SKILL);
  });

  it("by default proposes only what keeps the skill doing the same thing, and keeps its output section", async () => {
    const text = await capture(() => improve("rca", { yes: true }));
    expect(text).toMatch(/3 sessions loaded it/);
    expect(text).toMatch(/Output\s+fixed by "Output format": never changed/);
    expect(text).toContain("+ run relevant tests: `pnpm test`");
    expect(text).toContain("(not proposed; --behavior adds them)");
    expect(text).toContain("· inspect CI failure");
    expect(text).toMatch(/· .*lockfile.* \(3 sessions\)/i);
    expect(text).toMatch(/\? push/);
    expect(text).toContain("Not checked.");
    expect(text).toContain("Updated");
    const updated = await readFile(skillFile(), "utf8");
    expect(updated.startsWith(SKILL)).toBe(true);
    expect(updated).toContain(LEARNED_START);
    expect(updated).toContain('keep the output exactly as "Output format" specifies');
    expect(updated).toContain("`pnpm test`");
    expect(updated).not.toContain("Inspect the failing CI run");
    expect(updated).not.toMatch(/lockfile|root-cause it|nightly build broke/);
    const backups = await readdir(join(root, "home", "backups"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, "home", "backups", backups[0]!), "utf8")).toBe(SKILL);
  });

  it("adds steps and corrections only with --behavior, replacing its own section", async () => {
    await capture(() => improve("rca", { yes: true, behavior: true }));
    const updated = await readFile(skillFile(), "utf8");
    expect(updated.split(LEARNED_START)).toHaveLength(2);
    expect(updated).toContain("Inspect the failing CI run");
    expect(updated).toMatch(/lockfile/);
    const history = await capture(() => improve("rca", { history: true }));
    expect(history.match(/applied/g)?.length).toBeGreaterThanOrEqual(2);
    expect(history).toContain("not checked");
  });

  it("--verify applies only when the answer keeps its format", async () => {
    await writeFile(skillFile(), SKILL);
    const before = SKILL;
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      process.env.FAKE_SHAPE = "differ";
      const blocked = await capture(() => improve("rca", { yes: true, behavior: true, verify: "the deploy job failed, root-cause it", timeout: "1" }));
      expect(blocked).toMatch(/Output format\s+different/);
      expect(blocked).toContain("+ h2:extra");
      expect(blocked).toContain("Not applied");
      expect(await readFile(skillFile(), "utf8")).toBe(before);

      process.env.FAKE_SHAPE = "same";
      const passed = await capture(() => improve("rca", { yes: true, verify: "the deploy job failed, root-cause it", timeout: "1" }));
      expect(passed).toMatch(/Output format\s+same in 1 run/);
      expect(passed).toMatch(/Cost per run\s+\$0\.50 → \$0\.50/);
      expect(passed).toContain("Updated");
    } finally {
      process.chdir(cwd);
      delete process.env.FAKE_SHAPE;
    }
    const history = await capture(() => improve("rca", { history: true }));
    expect(history).toContain("output format changed");
    expect(history).toContain("same output format");
    expect(await readdir(join(root, "home", "bench"))).toEqual([]);
  });

  it("refuses unknown skills and odd names", async () => {
    await expect(improve("nope", {})).rejects.toThrow(/No skill "nope"/);
    await expect(improve("../etc", {})).rejects.toThrow(/not a skill name/);
  });
});
