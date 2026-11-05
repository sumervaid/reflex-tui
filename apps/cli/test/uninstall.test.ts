import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@reflex/core";
import { Store } from "@reflex/storage";
import { uninstallCommand } from "../src/commands/skills";

const CONTENT = "---\nname: fix-ci\n---\n";
const KEYS = ["REFLEX_HOME", "REFLEX_CLAUDE_SKILLS_DIR", "REFLEX_CODEX_SKILLS_DIR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let root: string;
let output: string;

async function installed(target: "claude-code" | "codex", dirEnv: string, folder = "fix-ci", skill = "fix-ci"): Promise<string> {
  const dir = join(root, dirEnv, folder);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(path, CONTENT);
  const store = new Store();
  store.saveInstallation({ skill, target, path, installedAt: new Date().toISOString(), contentHash: sha256(CONTENT) });
  store.close();
  return path;
}

function records(): number {
  const store = new Store();
  try {
    return store.installations().length;
  } finally {
    store.close();
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cli-uninstall-"));
  process.env.REFLEX_HOME = join(root, "home");
  process.env.REFLEX_CLAUDE_SKILLS_DIR = join(root, "claude");
  process.env.REFLEX_CODEX_SKILLS_DIR = join(root, "codex");
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

describe("reflex uninstall", () => {
  it("removes every unchanged copy and its record", async () => {
    const a = await installed("claude-code", "claude");
    const b = await installed("codex", "codex");
    await uninstallCommand("fix-ci", {});
    await expect(stat(a)).rejects.toThrow();
    await expect(stat(b)).rejects.toThrow();
    expect(records()).toBe(0);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports an edited copy, leaves it in place and keeps its record", async () => {
    const path = await installed("claude-code", "claude");
    await writeFile(path, `${CONTENT}my edit\n`);
    await uninstallCommand("fix-ci", {});
    expect(await readFile(path, "utf8")).toContain("my edit");
    expect(output).toContain("has changed since Reflex installed it");
    expect(records()).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it("touches only the targets asked for", async () => {
    const a = await installed("claude-code", "claude");
    const b = await installed("codex", "codex");
    await uninstallCommand("fix-ci", { target: ["codex"] });
    expect(await readFile(a, "utf8")).toBe(CONTENT);
    await expect(stat(b)).rejects.toThrow();
    expect(records()).toBe(1);
  });

  it("finds a copy by the name it was installed under", async () => {
    const path = await installed("claude-code", "claude", "my-ci", "fix-ci");
    await uninstallCommand("my-ci", {});
    await expect(stat(path)).rejects.toThrow();
    expect(records()).toBe(0);
  });

  it("drops the record of a copy that is already gone", async () => {
    const path = await installed("claude-code", "claude");
    await rm(path);
    await uninstallCommand("fix-ci", {});
    expect(output).toContain("already gone");
    expect(records()).toBe(0);
  });

  it("says when there is nothing to remove", async () => {
    await expect(uninstallCommand("fix-ci", {})).rejects.toThrow("is not installed");
    await installed("claude-code", "claude");
    await expect(uninstallCommand("fix-ci", { target: ["cursor"] })).rejects.toThrow("not installed in Cursor");
    expect(records()).toBe(1);
  });

  it("refuses a name that could leave the skills folder", async () => {
    await expect(uninstallCommand("../../etc", {})).rejects.toThrow();
  });
});
