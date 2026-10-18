import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findLeaks } from "@reflex/safety";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { scan } from "../src/commands/scan";
import { approve, evidence, reject, suggest } from "../src/commands/review";
import { explain, installCommand, listSkills } from "../src/commands/skills";
import { stats } from "../src/commands/misc";
import { impact } from "../src/commands/impact";

let root: string;
let history: { claudeDir: string; codexDir: string };
let output = "";

async function capture(fn: () => Promise<void>): Promise<string> {
  output = "";
  await fn();
  return output;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cli-"));
  process.env.REFLEX_HOME = join(root, "home");
  process.env.REFLEX_CLAUDE_SKILLS_DIR = join(root, "claude-skills");
  process.env.REFLEX_CODEX_SKILLS_DIR = join(root, "codex-skills");
  const h = await writeFixtureHistory(join(root, "history"));
  history = { claudeDir: h.claudeRoot, codexDir: h.codexRoot };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("reflex end-to-end loop on fixture transcripts", () => {
  it("reads nothing without consent", async () => {
    const text = await capture(() => scan({ days: 7, ...history }));
    expect(text).toContain("Permission not granted. Nothing was read");
    await expect(stat(join(root, "home", "reflex.db"))).rejects.toThrow();
  });

  it("scans, de-duplicates and suggests only the recurring workflows", async () => {
    const text = await capture(() => scan({ days: 7, ...history, yes: true }));
    expect(text).toMatch(/0 bytes uploaded/);
    expect(text).toContain("3 repeated workflows found");
    expect(text).toContain(join(root, "home", "reflex.db").replace(homedir(), "~"));
    const list = await capture(() => suggest({ interactive: false }));
    expect(list).toContain("3 repeated workflows");
    expect(list).toContain("fix-ci");
    expect(list).toContain("review-pr");
    expect(list).toContain("debug-dependency");
    expect(list).not.toContain("explain-ci");
  });

  it("shows redacted evidence", async () => {
    const text = await capture(() => evidence("fix-ci"));
    expect(text).toContain("NPM_TOKEN=[REDACTED]");
    expect(findLeaks(text)).toEqual([]);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("/Users/jordan");
  });

  it("approves into Reflex's own folder only, then installs on explicit consent", async () => {
    await capture(() => approve("fix-ci", { yes: true, install: false }));
    const skillPath = join(root, "home", "skills", "fix-ci", "SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    expect(skill.split("\n").length).toBeLessThanOrEqual(150);
    const constraints = skill.split("## Constraints")[1]!.split("\n## ")[0]!;
    expect(constraints.split("\n").filter((l) => l.startsWith("- "))).toEqual(["- Don't change ci workflow. (2 sessions)"]);
    expect(findLeaks(skill)).toEqual([]);
    await expect(stat(join(root, "claude-skills", "fix-ci"))).rejects.toThrow();

    const declined = await capture(() => installCommand("fix-ci", { target: ["claude-code"] }));
    expect(declined).toContain("Nothing was written");
    await expect(stat(join(root, "claude-skills", "fix-ci"))).rejects.toThrow();

    await capture(() => installCommand("fix-ci", { target: ["claude-code"], yes: true }));
    expect(await readFile(join(root, "claude-skills", "fix-ci", "SKILL.md"), "utf8")).toBe(skill);
  });

  it("shows the workflow's measured cost and an honest impact report", async () => {
    const shown = await capture(() => suggest({ interactive: false }));
    expect(shown).toMatch(/Cost\s+6 runs · median [\d.]+k tokens · median \d+ tool calls/);
    expect(await capture(() => evidence("fix-ci"))).toMatch(/[\d.]+k tokens, \d+ tool calls/);
    const report = await capture(() => impact("fix-ci"));
    expect(report).toMatch(/Before the skill\s+6 runs · median [\d.]+k tokens/);
    expect(report).toContain("no runs yet");
    expect(report).toContain("not enough runs to compare");
    expect(report).toMatch(/Skill overhead\s+≈[\d.]+k? tokens/);
    await expect(impact("nope")).rejects.toThrow('No generated skill "nope"');
  });

  it("explains provenance, lists skills and reports counts", async () => {
    const why = await capture(() => explain("fix-ci"));
    expect(why).toMatch(/Independent sessions\s+6/);
    expect(why).toContain("Claude Code 4, Codex 2");
    expect(await capture(() => listSkills())).toContain("fix-ci");
    const counts = await capture(() => stats());
    expect(counts).toMatch(/Bytes uploaded\s+0/);
  });

  it("stops suggesting rejected workflows", async () => {
    await capture(() => reject("review-pr"));
    const list = await capture(() => suggest({ interactive: false }));
    expect(list).not.toMatch(/#\d+ · review-pr/);
  });
});
