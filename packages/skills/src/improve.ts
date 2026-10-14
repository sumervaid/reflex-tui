import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SkillReview } from "@reflex/analysis";
import { sha256 } from "@reflex/core";
import { ensureDir, findLeaks, isSymlink, redact, replaceOwnedFile, writeNewFile } from "@reflex/safety";

/** Names of skills you wrote, as their folder names: letters, digits, dot, dash, underscore. */
export const OWN_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const LEARNED_START = "<!-- reflex:learned:start -->";
export const LEARNED_END = "<!-- reflex:learned:end -->";

/**
 * The section Reflex proposes adding to a skill you wrote, or undefined when there is nothing to
 * add. By default only what makes the same work faster: commands that worked for steps the skill
 * already names. With `behavior`, also missing steps and repeated corrections, which can change
 * what the agent does. Only Reflex's own step wording, recurring commands that passed the safety
 * filter, and constraints built from corrections you repeated: never text from the sessions.
 */
export function learnedSection(review: SkillReview, opts: { behavior?: boolean; now?: Date } = {}): string | undefined {
  const missing = opts.behavior ? review.missing : [];
  const constraints = opts.behavior ? review.constraints : [];
  if (!review.commands.length && !missing.length && !constraints.length) return undefined;
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const lines = [LEARNED_START, "## Learned from your sessions", "", `From ${review.sessions} sessions that loaded this skill (Reflex, ${day}).`];
  if (review.protected.length) {
    lines.push(`Nothing here changes what this skill produces: keep the output exactly as ${review.protected.map((p) => `"${p}"`).join(", ")} specifies.`);
  }
  if (review.commands.length) {
    lines.push("", "Commands that worked for steps above, so they need not be worked out again:", "");
    for (const s of review.commands) lines.push(`- ${s.label}: ${s.examples.map((e) => `\`${e}\``).join(", ")}`);
  }
  if (missing.length) {
    lines.push("", "Steps your agents took in most of them that this skill does not mention:", "");
    missing.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.instruction}`);
      if (s.examples.length) lines.push(`   Commands seen: ${s.examples.map((e) => `\`${e}\``).join(", ")}`);
    });
  }
  if (constraints.length) {
    lines.push("", "Corrections you gave in more than one of them:", "");
    for (const c of constraints) lines.push(`- ${c.text} (${c.sessions} sessions)`);
  }
  lines.push(LEARNED_END);
  const section = redact(lines.join("\n"));
  if (findLeaks(section).length) throw new Error("The proposed section still contains sensitive-looking content; refusing to propose it.");
  return section;
}

/** `content` with Reflex's learned section added, or replaced if an earlier one is there. Everything else is kept byte for byte. */
export function applyLearned(content: string, section: string): string {
  const start = content.indexOf(LEARNED_START);
  const end = start >= 0 ? content.indexOf(LEARNED_END, start) : -1;
  if (start >= 0 && end >= 0) return content.slice(0, start) + section + content.slice(end + LEARNED_END.length);
  return content.replace(/\n*$/, "\n\n") + section + "\n";
}

/** Read a skill file you wrote: a regular file, never through a symlink. */
export async function readOwnSkill(path: string): Promise<string> {
  if (basename(path) !== "SKILL.md" || (await isSymlink(path)) || (await isSymlink(dirname(path)))) throw new Error("Reflex only reads a regular SKILL.md, not through a symlink.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Replace your skill file with `next`, keeping a copy of what was there under `backupDir`. Refuses
 * if the file changed since it was read (`readHash`), so an edit you made meanwhile is never lost.
 */
export async function applyToOwnSkill(path: string, readHash: string, next: string, backupDir: string, name: string, now = new Date()): Promise<string> {
  if (!OWN_SKILL_NAME.test(name)) throw new Error("Not a skill name Reflex will use in a file name.");
  const current = await readOwnSkill(path);
  if (sha256(current) !== readHash) throw new Error("The skill changed since Reflex read it; run `reflex improve` again.");
  if (!(await lstat(path)).isFile()) throw new Error("Not a regular file.");
  await ensureDir(backupDir, 0o700);
  const backup = join(backupDir, `${name}-${now.toISOString().replace(/[:.]/g, "-")}.md`);
  await writeNewFile(backup, current, 0o600);
  await replaceOwnedFile(path, next, 0o644);
  return backup;
}
