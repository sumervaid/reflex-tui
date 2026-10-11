import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@reflix/core";
import { assertInside, assertSlug, displayPath, ensureDir, isSymlink, pathExists, replaceOwnedFile, writeNewFile } from "@reflix/safety";

export type TargetId = "claude-code" | "codex";

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
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      skillsDir: process.env.REFLIX_CLAUDE_SKILLS_DIR ?? join(claudeHome, "skills"),
      detected: process.env.REFLIX_CLAUDE_SKILLS_DIR ? true : await pathExists(claudeHome),
    },
    {
      id: "codex",
      label: "Codex",
      skillsDir: process.env.REFLIX_CODEX_SKILLS_DIR ?? join(codexHome, "skills"),
      detected: process.env.REFLIX_CODEX_SKILLS_DIR ? true : await pathExists(codexHome),
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

/** Write a generated skill into Reflix-owned storage (~/.reflix/skills/<name>/). */
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
