import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { MEMORY_START } from "@reflex/skills";
import { scan } from "../src/commands/scan";
import { memoryAdd, memoryForget, memoryOff, memoryOn, memoryStatus } from "../src/commands/memory";
import { reset } from "../src/commands/misc";

let root: string;
let history: { claudeDir: string; codexDir: string };
let output = "";
const capture = async (fn: () => Promise<void>) => {
  output = "";
  await fn();
  return output;
};
const claudeFile = () => join(root, "claude", "CLAUDE.md");
const codexFile = () => join(root, "codex", "AGENTS.md");
const MINE = "# My own rules\n\nAlways run the linter.\n";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-memory-"));
  process.env.REFLEX_HOME = join(root, "home");
  process.env.REFLEX_CLAUDE_MEMORY_FILE = claudeFile();
  process.env.REFLEX_CODEX_MEMORY_FILE = codexFile();
  process.env.REFLEX_CLAUDE_SKILLS_DIR = join(root, "claude-skills");
  process.env.REFLEX_CODEX_SKILLS_DIR = join(root, "codex-skills");
  const h = await writeFixtureHistory(join(root, "history"));
  history = { claudeDir: h.claudeRoot, codexDir: h.codexRoot };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "claude"), { recursive: true });
  await writeFile(claudeFile(), MINE);
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
});

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.REFLEX_CLAUDE_MEMORY_FILE;
  delete process.env.REFLEX_CODEX_MEMORY_FILE;
  await rm(root, { recursive: true, force: true });
});

describe("agent memory across sessions", () => {
  it("mines recurring corrections at scan time without touching agent files while off", async () => {
    const text = await capture(() => scan({ days: 7, ...history, yes: true }));
    expect(text).toMatch(/your agents could remember across sessions: reflex memory/);
    expect(await readFile(claudeFile(), "utf8")).toBe(MINE);
    const status = await capture(() => memoryStatus());
    expect(status).toContain("Agent memory");
    expect(status).toMatch(/\d+ sessions\)/);
  });

  it("on: writes a marked block into both agents' files and keeps the user's text", async () => {
    await capture(() => memoryOn({ yes: true }));
    const claude = await readFile(claudeFile(), "utf8");
    expect(claude.startsWith(MINE)).toBe(true);
    expect(claude).toContain(MEMORY_START);
    expect(claude).toContain("## Remembered by Reflex");
    expect(await readFile(codexFile(), "utf8")).toContain(MEMORY_START);
  });

  it("add and forget update the files; secrets are refused", async () => {
    await capture(() => memoryAdd(["use", "pnpm,", "not", "npm"]));
    expect(await readFile(claudeFile(), "utf8")).toContain("- use pnpm, not npm");
    await capture(() => memoryForget("use pnpm, not npm"));
    expect(await readFile(claudeFile(), "utf8")).not.toContain("use pnpm, not npm");
    await expect(memoryAdd(["token", "ghp_" + "a".repeat(36)])).rejects.toThrow(/secret/);
  });

  it("a rescan refreshes the block in place", async () => {
    await capture(() => scan({ days: 7, ...history, yes: true }));
    const claude = await readFile(claudeFile(), "utf8");
    expect(claude.split(MEMORY_START).length).toBe(2);
    expect(claude.startsWith(MINE)).toBe(true);
  });

  it("off removes the block and restores the user's file exactly", async () => {
    await capture(() => memoryOff());
    expect(await readFile(claudeFile(), "utf8")).toBe(MINE);
    expect(await readFile(codexFile(), "utf8")).toBe("");
  });

  it("never writes through a symlinked instructions file", async () => {
    const real = join(root, "elsewhere.md");
    await writeFile(real, "dotfiles\n");
    await rm(codexFile());
    await symlink(real, codexFile());
    const text = await capture(() => memoryOn({ yes: true }));
    expect(text).toMatch(/symlink/);
    expect(await readFile(real, "utf8")).toBe("dotfiles\n");
  });

  it("reset removes Reflex's block from the agents' files", async () => {
    await capture(() => reset({ yes: true }));
    expect(await readFile(claudeFile(), "utf8")).toBe(MINE);
  });
});
