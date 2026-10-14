import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { OWN_SKILL_NAME, detectTargets } from "@reflex/skills";

/** `path` is the real `SKILL.md`; `link` is the agent's folder entry when it is a symlink (a skills repo). */
export type Found = { name: string; path: string; target: string; link?: string };

/**
 * Skills in each agent's skill folder: folder names and whether `SKILL.md` is a regular file.
 * Nothing is read. A symlinked folder (skills kept in one repo and linked in) resolves to the real
 * folder, so Reflex reads and writes the real file and never writes through the link.
 */
export async function skillFiles(): Promise<Found[]> {
  const out: Found[] = [];
  for (const t of await detectTargets()) {
    let entries;
    try {
      entries = await readdir(t.skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!(e.isDirectory() || e.isSymbolicLink()) || !OWN_SKILL_NAME.test(e.name)) continue;
      const entry = join(t.skillsDir, e.name);
      try {
        const dir = e.isSymbolicLink() ? await realpath(entry) : entry;
        if (!(await lstat(dir)).isDirectory()) continue;
        const path = join(dir, "SKILL.md");
        if ((await lstat(path)).isFile()) out.push({ name: e.name, path, target: t.label, link: e.isSymbolicLink() ? entry : undefined });
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** Folder names of the skills in your agents' skill folders (Reflex's installs included). */
export const userSkills = async (): Promise<Set<string>> => new Set((await skillFiles()).map((f) => f.name));
