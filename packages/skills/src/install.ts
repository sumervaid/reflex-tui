import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { sha256 } from "@reflex/core";
import { assertInside, assertSlug, displayPath, ensureDir, isSymlink, isValidSlug, pathExists, replaceOwnedFile, writeNewFile } from "@reflex/safety";

export type TargetId = "claude-code" | "codex" | "cursor";

export type InstallTarget = {
  id: TargetId;
  label: string;
  /** Directory that holds <skill-name>/SKILL.md. */
  skillsDir: string;
  /** The agent's home directory exists on this machine. */
  detected: boolean;
};

export async function detectTargets(): Promise<InstallTarget[]> {
  const claudeHome = join(homedir(), ".claude");
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const cursorHome = join(homedir(), ".cursor");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      skillsDir: process.env.REFLEX_CLAUDE_SKILLS_DIR ?? join(claudeHome, "skills"),
      detected: process.env.REFLEX_CLAUDE_SKILLS_DIR ? true : await pathExists(claudeHome),
    },
    {
      id: "codex",
      label: "Codex",
      skillsDir: process.env.REFLEX_CODEX_SKILLS_DIR ?? join(codexHome, "skills"),
      detected: process.env.REFLEX_CODEX_SKILLS_DIR ? true : await pathExists(codexHome),
    },
    {
      id: "cursor",
      label: "Cursor",
      skillsDir: process.env.REFLEX_CURSOR_SKILLS_DIR ?? join(cursorHome, "skills"),
      detected: process.env.REFLEX_CURSOR_SKILLS_DIR ? true : await pathExists(cursorHome),
    },
  ];
}

export type InstallPlan = {
  target: InstallTarget;
  name: string;
  destination: string;
  displayDestination: string;
  existing?: string;
  /** The existing file is byte-identical to what would be written. */
  identical: boolean;
};

export async function planInstall(target: InstallTarget, name: string, content: string): Promise<InstallPlan> {
  assertSlug(name);
  const dir = assertInside(target.skillsDir, join(target.skillsDir, name));
  if (await isSymlink(dir)) throw new Error(`${displayPath(dir)} is a symlink; refusing to install through it.`);
  const destination = join(dir, "SKILL.md");
  let existing: string | undefined;
  if (await pathExists(destination)) {
    if (await isSymlink(destination)) throw new Error(`${displayPath(destination)} is a symlink; refusing to overwrite it.`);
    existing = await readFile(destination, "utf8");
  }
  return { target, name, destination, displayDestination: displayPath(destination), existing, identical: existing === content };
}

/** Write a skill into an agent's skills directory. Never overwrites: fails if the file appeared meanwhile. */
export async function install(plan: InstallPlan, content: string): Promise<{ path: string; contentHash: string }> {
  if (plan.existing !== undefined) throw new Error(`A skill named ${plan.name} already exists at ${plan.displayDestination}.`);
  // The agent's skills root may itself be a symlink (dotfile managers); the per-skill folder may not.
  await mkdir(plan.target.skillsDir, { recursive: true, mode: 0o755 });
  await ensureDir(join(plan.target.skillsDir, plan.name), 0o755);
  await writeNewFile(plan.destination, content, 0o644);
  return { path: plan.destination, contentHash: sha256(content) };
}

/** What an installation record says Reflex wrote. */
export type InstalledFile = { path: string; contentHash: string };

/**
 * `removed`: the file was deleted. `missing`: nothing is there any more. `edited`: the file is not
 * what Reflex wrote (content changed, replaced by a symlink or folder, or outside the target's
 * `<skillsDir>/<name>/SKILL.md`), so it was left alone.
 */
export type UninstallResult = "removed" | "missing" | "edited";

/**
 * Remove a skill Reflex installed, only if it is still exactly what Reflex wrote: a regular file
 * (never a symlink) at `<skillsDir>/<name>/SKILL.md` whose sha256 matches the record. The per-skill
 * folder is removed too when that leaves it empty. Nothing else is touched.
 */
export async function uninstall(target: InstallTarget, record: InstalledFile): Promise<UninstallResult> {
  const file = resolve(record.path);
  const dir = dirname(file);
  if (basename(file) !== "SKILL.md" || !isValidSlug(basename(dir)) || dirname(dir) !== resolve(target.skillsDir)) return "edited";
  if (await isSymlink(dir)) return "edited";
  try {
    if (!(await lstat(file)).isFile()) return "edited";
  } catch {
    return "missing";
  }
  // O_NOFOLLOW: if the file was swapped for a symlink after the check, the open fails instead of following it.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return "edited";
  let content: string;
  try {
    content = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  if (sha256(content) !== record.contentHash) return "edited";
  await unlink(file);
  // rmdir only removes an empty folder; anything the user added next to SKILL.md keeps it.
  await rmdir(dir).catch(() => undefined);
  return "removed";
}

/** Write a generated skill into Reflex-owned storage (~/.reflex/skills/<name>/). */
export async function storeGenerated(skillsRoot: string, name: string, content: string, provenanceJson: string): Promise<string> {
  assertSlug(name);
  await ensureDir(skillsRoot, 0o700);
  const dir = assertInside(skillsRoot, join(skillsRoot, name));
  await ensureDir(dir, 0o700);
  const file = join(dir, "SKILL.md");
  await replaceOwnedFile(file, content, 0o644);
  await replaceOwnedFile(join(dir, "provenance.json"), provenanceJson, 0o600);
  return file;
}
