import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const SKILL = ["---", "name: rca", "description: Root-cause a failure", "---", "", "1. Read the error.", "2. Write the RCA.", "3. Push the fix to the release branch.", ""].join("\n");

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
});

afterAll(async () => {
  vi.restoreAllMocks();
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

  it("proposes the steps and corrections the skill misses, then applies them with a backup", async () => {
    const text = await capture(() => improve("rca", { yes: true }));
    expect(text).toMatch(/3 sessions loaded it/);
    expect(text).toContain("+ inspect CI failure");
    expect(text).toContain("+ run relevant tests");
    expect(text).toMatch(/\? push/);
    expect(text).toMatch(/\+ .*lockfile.* \(3 sessions\)/i);
    expect(text).toContain("Updated");
    const updated = await readFile(skillFile(), "utf8");
    expect(updated.startsWith(SKILL)).toBe(true);
    expect(updated).toContain(LEARNED_START);
    expect(updated).toContain("Inspect the failing CI run");
    expect(updated).not.toMatch(/root-cause it|nightly build broke/);
    const backups = await readdir(join(root, "home", "backups"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(root, "home", "backups", backups[0]!), "utf8")).toBe(SKILL);

    await capture(() => improve("rca", { yes: true }));
    expect((await readFile(skillFile(), "utf8")).split(LEARNED_START)).toHaveLength(2);
  });

  it("refuses unknown skills and odd names", async () => {
    await expect(improve("nope", {})).rejects.toThrow(/No skill "nope"/);
    await expect(improve("../etc", {})).rejects.toThrow(/not a skill name/);
  });
});
