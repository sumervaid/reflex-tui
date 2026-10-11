import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, CodexAdapter } from "@reflex/adapters";
import { analyze, buildTrace, type Suggestion } from "@reflex/analysis";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { findLeaks } from "@reflex/safety";
import { MAX_SKILL_LINES, generateSkill, renameSkill } from "../src/generate";
import { checkSkill, parseFrontmatter } from "../src/validate";
import { install, planInstall, storeGenerated, type InstallTarget } from "../src/install";
import { createFixCiSandbox, sandboxTestsPass } from "../src/sandbox";
import { lineDiff } from "../src/diff";

const NOW = new Date("2026-10-11T12:00:00Z");
let tmp: string;
let suggestions: Suggestion[];

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "reflex-skills-"));
  const h = await writeFixtureHistory(join(tmp, "history"), NOW);
  const traces = [];
  for (const a of [new ClaudeCodeAdapter(h.claudeRoot), new CodexAdapter(h.codexRoot)])
    for (const f of await a.discover({ days: 7, now: NOW })) traces.push(...(await a.parse(f, { days: 7, now: NOW })).sessions.map(buildTrace));
  suggestions = analyze(traces).suggestions;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("skill generation", () => {
  it("produces a valid, bounded SKILL.md for every suggestion", () => {
    for (const s of suggestions) {
      const skill = generateSkill(s, NOW);
      const check = checkSkill(skill.content, s.slug);
      expect(check.errors).toEqual([]);
      expect(check.lines).toBeLessThanOrEqual(MAX_SKILL_LINES);
      expect(skill.content.startsWith("---\nname: ")).toBe(true);
      const fm = parseFrontmatter(skill.content)!;
      expect(fm.name).toBe(s.slug);
      expect(fm.description!.length).toBeGreaterThan(20);
    }
  });

  it("only contains steps supported by the evidence", () => {
    const ci = suggestions.find((s) => s.slug === "fix-ci")!;
    const skill = generateSkill(ci, NOW);
    const workflow = skill.content.split("## Workflow")[1]!.split("\n## ")[0]!;
    const numbered = workflow.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(numbered).toHaveLength(ci.steps.length);
    numbered.forEach((line, i) => expect(line).toContain(ci.steps[i]!.instruction));
    for (const unsupported of [/deploy/i, /slack/i, /restart/i, /production/i]) expect(workflow).not.toMatch(unsupported);
  });

  it("writes recurring corrections as constraints, and only when there are some", () => {
    const ci = suggestions.find((s) => s.slug === "fix-ci")!;
    const section = generateSkill(ci, NOW).content.split("## Constraints")[1]!.split("\n## ")[0]!;
    expect(section.split("\n").filter((l) => l.startsWith("- "))).toEqual(["- Don't change ci workflow. (2 sessions)"]);
    const none = suggestions.find((s) => !s.constraints?.length)!;
    expect(generateSkill(none, NOW).content).not.toContain("## Constraints");
  });

  it("has no secrets, raw paths or transcript excerpts", () => {
    for (const s of suggestions) {
      const { content } = generateSkill(s, NOW);
      expect(findLeaks(content)).toEqual([]);
      expect(content).not.toMatch(/\/Users\/|\/home\//);
      for (const e of s.evidence) expect(content).not.toContain(e.excerpt.slice(0, 30));
    }
  });

  it("records provenance metadata", () => {
    const ci = suggestions.find((s) => s.slug === "fix-ci")!;
    const skill = generateSkill(ci, NOW);
    expect(skill.content).toContain("generator: reflex");
    expect(skill.content).toContain('independent-sessions: "6"');
    expect(skill.provenance.sourceSessions.every((r) => /^(claude-code|codex):[A-Za-z0-9-]{1,8}$/.test(r))).toBe(true);
    expect(skill.provenance.independentSessions).toBe(6);
    expect(JSON.stringify(skill.provenance)).not.toMatch(/\/Users|jsonl/);
  });

  it("rejects invalid skills", () => {
    expect(checkSkill("# no frontmatter").ok).toBe(false);
    const long = "---\nname: x-y\ndescription: d\n---\n" + "line\n".repeat(200);
    expect(checkSkill(long).errors.join()).toMatch(/lines/);
    expect(() => generateSkill({ ...suggestions[0]!, slug: "../../etc" }, NOW)).toThrow();
  });

  it("renames only the frontmatter name", () => {
    const { content } = generateSkill(suggestions[0]!, NOW);
    const renamed = renameSkill(content, "fix-ci-2");
    expect(parseFrontmatter(renamed)!.name).toBe("fix-ci-2");
    expect(renamed.split("\n").slice(2)).toEqual(content.split("\n").slice(2));
  });
});

describe("installation", () => {
  const target = (dir: string): InstallTarget => ({ id: "claude-code", label: "Claude Code", skillsDir: dir, detected: true });

  it("writes a new skill and refuses to overwrite an existing one", async () => {
    const skill = generateSkill(suggestions[0]!, NOW);
    const t = target(join(tmp, "claude-skills"));
    const plan = await planInstall(t, skill.name, skill.content);
    expect(plan.existing).toBeUndefined();
    await install(plan, skill.content);
    expect(await readFile(plan.destination, "utf8")).toBe(skill.content);
    const again = await planInstall(t, skill.name, skill.content);
    expect(again.existing).toBe(skill.content);
    expect(again.identical).toBe(true);
    await expect(install(again, skill.content)).rejects.toThrow(/already exists/);
  });

  it("refuses symlinked skill folders and files", async () => {
    const dir = join(tmp, "claude-skills");
    await mkdir(dir, { recursive: true });
    await mkdir(join(tmp, "elsewhere"));
    await symlink(join(tmp, "elsewhere"), join(dir, "fix-ci"));
    await expect(planInstall(target(dir), "fix-ci", "x")).rejects.toThrow(/symlink/);
  });

  it("rejects traversal in skill names", async () => {
    await expect(planInstall(target(join(tmp, "s")), "../evil", "x")).rejects.toThrow();
  });

  it("stores generated skills in Reflex-owned storage", async () => {
    const skill = generateSkill(suggestions[0]!, NOW);
    const file = await storeGenerated(join(tmp, "reflex-skills"), skill.name, skill.content, "{}");
    expect(await readFile(file, "utf8")).toBe(skill.content);
    await storeGenerated(join(tmp, "reflex-skills"), skill.name, skill.content, "{}");
  });

  it("shows a readable diff", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toBe("  a\n- b\n+ B\n  c");
  });
});

describe("fresh-task sandbox", () => {
  it("creates a new repository whose tests fail until fixed", async () => {
    const skill = generateSkill(suggestions.find((s) => s.slug === "fix-ci")!, NOW);
    const sb = await createFixCiSandbox(join(tmp, "validation"), skill.name, skill.content);
    expect(sandboxTestsPass(sb.dir)).toBe(false);
    expect(await readFile(sb.skillPath, "utf8")).toBe(skill.content);
    await writeFile(join(sb.dir, "config/default.json"), JSON.stringify({ retries: 3, timeoutMs: 5000 }));
    expect(sandboxTestsPass(sb.dir)).toBe(true);
  });
});
