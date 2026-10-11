import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion, WorkflowCost } from "@reflex/analysis";
import { sha256 } from "@reflex/core";
import { pathExists } from "@reflex/safety";
import { type GeneratedSkill, generateSkill } from "./generate";
import { storeGenerated } from "./install";

/** The parts of Reflex's store that approving touches (`Store` in @reflex/storage implements it). */
export type ApprovalStore = {
  skill(name: string): { contentHash: string } | undefined;
  saveSkill(skill: { name: string; suggestionSlug: string; path: string; createdAt: string; contentHash: string; baseline?: WorkflowCost }): void;
  setStatus(slug: string, status: "approved"): void;
};

export type ApproveResult = {
  skill: GeneratedSkill;
  /** Where the SKILL.md lives in Reflex's skills folder. */
  path: string;
  /** False when an edited copy was kept: then nothing was written and the suggestion is still pending. */
  written: boolean;
};

/**
 * Generate a skill from a suggestion into Reflex's own skills folder (`skillsRoot/<name>/`), record
 * it with the workflow's cost as its baseline and mark the suggestion approved. A SKILL.md that
 * differs from what Reflex last wrote there (or that Reflex has no record of) is replaced only when
 * `replaceEdited` agrees; otherwise nothing changes.
 */
export async function approveSuggestion(
  store: ApprovalStore,
  entry: { slug: string; data: Suggestion },
  skillsRoot: string,
  replaceEdited: (file: string) => Promise<boolean>,
): Promise<ApproveResult> {
  const skill = generateSkill(entry.data);
  const file = join(skillsRoot, skill.name, "SKILL.md");
  const previous = store.skill(skill.name);
  if (await pathExists(file)) {
    const current = await readFile(file, "utf8");
    const editedByUser = !previous || previous.contentHash !== sha256(current);
    if (editedByUser && !(await replaceEdited(file))) return { skill, path: file, written: false };
  }
  const path = await storeGenerated(skillsRoot, skill.name, skill.content, JSON.stringify(skill.provenance, null, 2) + "\n");
  store.saveSkill({
    name: skill.name,
    suggestionSlug: entry.slug,
    path,
    createdAt: skill.provenance.createdAt,
    contentHash: skill.contentHash,
    baseline: entry.data.cost,
  });
  store.setStatus(entry.slug, "approved");
  return { skill, path, written: true };
}
