import { findLeaks, isValidSlug } from "@reflix/safety";
import { MAX_SKILL_LINES } from "./generate";

export type SkillCheck = { ok: boolean; errors: string[]; warnings: string[]; name?: string; steps: number; lines: number };

const REQUIRED_SECTIONS = ["## When to use", "## Workflow", "## Completion criteria"];

export function parseFrontmatter(content: string): Record<string, string> | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const m = /^([a-z][a-z0-9-]*):\s*(.*)$/i.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        /* keep raw */
      }
    }
    out[m[1]!] = v;
  }
  return out;
}

/** Static checks a generated or installed SKILL.md must pass. */
export function checkSkill(content: string, expectedName?: string): SkillCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = content.trimEnd().split("\n").length;
  if (lines > MAX_SKILL_LINES) errors.push(`${lines} lines (limit ${MAX_SKILL_LINES})`);

  const fm = parseFrontmatter(content);
  if (!fm) errors.push("missing YAML frontmatter");
  const name = fm?.name;
  if (!name || !isValidSlug(name)) errors.push("frontmatter `name` is missing or not a valid skill name");
  if (expectedName && name !== expectedName) errors.push(`frontmatter name "${name}" does not match "${expectedName}"`);
  const description = fm?.description ?? "";
  if (!description) errors.push("frontmatter `description` is missing");
  if (description.length > 1024) errors.push("description is longer than 1024 characters");

  for (const section of REQUIRED_SECTIONS) if (!content.includes(`\n${section}\n`)) errors.push(`missing section "${section}"`);
  const steps = (content.split("## Workflow")[1]?.split("\n## ")[0] ?? "").split("\n").filter((l) => /^\d+\. /.test(l)).length;
  if (steps < 3) errors.push(`workflow has ${steps} steps; at least 3 expected`);

  if (findLeaks(content).length) errors.push("contains sensitive-looking content (secret, email, or home path)");
  if (/(^|[\s`'"(])(\/Users\/|\/home\/|[A-Z]:\\Users\\)/m.test(content)) errors.push("contains a local absolute path");
  if (!/generator: reflix/.test(content)) warnings.push("no Reflix provenance metadata (hand-written or edited skill)");

  return { ok: errors.length === 0, errors, warnings, name, steps, lines };
}
