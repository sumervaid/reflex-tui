import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { analyze } from "../src/suggest";
import { FIXED_START, outputShape, protectedSections, reviewSkill } from "../src/improve";
import { deduplicate } from "../src/dedup";
import { fixtureTraces } from "./helpers";

/** The fixture's fix-CI sessions, as if the developer's own skills had been loaded in some of them. */
async function withSkills(skills: (t: WorkflowTrace, i: number) => string[]): Promise<WorkflowTrace[]> {
  let i = 0;
  return (await fixtureTraces()).map((t) => (t.actionSequence.includes("inspect-ci") ? { ...t, skillsUsed: skills(t, i++) } : t));
}

describe("workflows your own skills already handle", () => {
  it("are reported as covered instead of suggested again", async () => {
    const traces = await withSkills((_, i) => (i % 3 === 2 ? [] : i % 2 ? ["deploy", "tools:rca"] : ["rca"]));
    const { suggestions, stats } = analyze(traces);
    expect(suggestions.map((s) => s.slug)).not.toContain("fix-ci");
    expect(stats.covered).toHaveLength(1);
    expect(stats.covered![0]!.skills.map((s) => s.name)).toEqual(["rca", "deploy"]);
    expect(stats.covered![0]!.instances).toBe(6);
  });

  it("ignore general skills loaded in most sessions, like house rules", async () => {
    const traces = (await fixtureTraces()).map((t) => ({ ...t, skillsUsed: ["house-rules"] }));
    const { suggestions, stats } = analyze(traces);
    expect(suggestions.map((s) => s.slug)).toContain("fix-ci");
    expect(stats.covered).toEqual([]);
    expect(stats.generalSkills).toEqual(["house-rules"]);
  });

  it("are covered by your skill even when it has the name Reflex would give the suggestion", async () => {
    const { suggestions, stats } = analyze(await withSkills(() => ["fix-ci"]));
    expect(suggestions.map((s) => s.slug)).not.toContain("fix-ci");
    expect(stats.covered![0]!.skills.map((s) => s.name)).toEqual(["fix-ci"]);
  });

  it("are not covered by a plugin's skill that isn't in your skill folders", async () => {
    const traces = await withSkills(() => ["superpowers:systematic-debugging"]);
    const mine = analyze(traces, { userSkills: new Set(["rca"]) });
    expect(mine.suggestions.map((s) => s.slug)).toContain("fix-ci");
    expect(mine.stats.covered).toEqual([]);
    expect(analyze(traces, { userSkills: new Set(["systematic-debugging"]) }).stats.covered).toHaveLength(1);
  });

  it("still suggest when few sessions used your skills, or the skills are Reflex's own", async () => {
    expect(analyze(await withSkills((_, i) => (i === 0 ? ["rca"] : []))).suggestions.map((s) => s.slug)).toContain("fix-ci");
    const own = await withSkills(() => ["ci-fixer"]);
    expect(analyze(own, { ownSkills: new Set(["ci-fixer"]) }).suggestions.map((s) => s.slug)).toContain("fix-ci");
    expect(analyze(own).suggestions.map((s) => s.slug)).not.toContain("fix-ci");
  });
});

describe("reviewSkill", () => {
  const SKILL = ["---", "name: rca", "description: Root-cause a failure", "---", "", "1. Read the error.", "2. Write the RCA.", "3. Push the fix to the release branch."].join("\n");

  it("finds steps the skill misses, steps it names that rarely happen, and needs two sessions", async () => {
    const traces = await withSkills(() => ["rca"]);
    const r = reviewSkill("rca", SKILL, traces);
    expect(r.sessions).toBe(deduplicate(traces).instances.filter((i) => i.primary.skillsUsed?.includes("rca")).length);
    expect(r.missing.map((s) => s.kind)).toEqual(expect.arrayContaining(["inspect-ci", "run-tests"]));
    expect(r.missing.map((s) => s.kind)).not.toContain("inspect-code");
    expect(r.rarelyTaken.map((s) => s.kind)).toContain("push");
    const covered = reviewSkill("rca", `${SKILL}\nCheck the failing CI job logs and run the tests.`, traces);
    expect(covered.missing.map((s) => s.kind)).not.toContain("run-tests");
    expect(covered.missing.map((s) => s.kind)).not.toContain("inspect-ci");

    const one = await withSkills((_, i) => (i === 0 ? ["rca"] : []));
    expect(reviewSkill("rca", SKILL, one)).toMatchObject({ sessions: 1, missing: [], rarelyTaken: [], constraints: [] });
  });

  it("offers commands for steps the skill already names, and never a summary step when the output is fixed", async () => {
    const traces = await withSkills(() => ["rca"]);
    const named = `${SKILL}\nRun the tests.\nInspect the failing CI job.`;
    const r = reviewSkill("rca", named, traces);
    expect(r.commands.map((s) => s.kind)).toEqual(expect.arrayContaining(["inspect-ci"]));
    expect(r.commands.every((s) => s.examples.length > 0)).toBe(true);
    expect(r.protected).toEqual([]);
    const fixed = reviewSkill("rca", `${named}\n\n## Output format\n\n- Root cause`, traces);
    expect(fixed.protected).toEqual(["Output format"]);
    expect(fixed.missing.map((s) => s.kind)).not.toContain("summarize");
  });
});

describe("commands that failed", () => {
  it("are never offered as examples", async () => {
    const traces = await withSkills(() => ["rca"]);
    const skill = "Run the tests. Inspect the failing CI job.";
    const all = reviewSkill("rca", skill, traces).commands.flatMap((s) => s.examples);
    expect(all.length).toBeGreaterThan(0);
    const failed = traces.map((t) => ({ ...t, commands: t.commands.map((c) => (all.includes(c.normalized) ? { ...c, failed: true } : c)) }));
    expect(reviewSkill("rca", skill, failed).commands.flatMap((s) => s.examples)).toEqual([]);
  });
});

describe("protectedSections", () => {
  it("finds output headings and fixed markers", () => {
    expect(protectedSections("# RCA\n## Steps\n## Response template\n### Report\n## 7. Plain English Output\n")).toEqual(["Response template", "Report", "7. Plain English Output"]);
    expect(protectedSections("## 2.5. Hard checks the orchestrator runs (always cite results)\n## Reporting bugs to the vendor\n")).toEqual([]);
    expect(protectedSections(`# x\n${FIXED_START}\nkeep\n<!-- reflex:fixed:end -->`)).toEqual(["sections marked fixed"]);
  });
});

describe("outputShape", () => {
  it("is the same for answers in one format with different values", () => {
    const a = "## Root cause: retries at 12:04\n\nThe config was a string.\n\n- step one\n- step two\n\n| file | change |\n|---|---|\n| a.ts | x |\n| b.ts | y |\n\n**Verified**: yes";
    const b = "## Root cause: timeout at 09:31\n\nA flaky network call.\n\n- only step\n\n| file | change |\n|---|---|\n| c.ts | z |\n\n**Verified**: no";
    expect(outputShape(a)).toEqual(outputShape(b));
    expect(outputShape(a)).toEqual(["h2:root cause", "list", "table:2", "table:row", "label:verified"]);
  });

  it("differs when the format changes", () => {
    const a = "## Root cause\n\n- x";
    expect(outputShape(`${a}\n\n## Extra section\n\n- y`)).not.toEqual(outputShape(a));
    expect(outputShape("1. x\n2. y")).not.toEqual(outputShape(a));
    expect(outputShape('{"cause":"x","fix":"y"}')).toEqual(["json:object", "key:cause", "key:fix"]);
    expect(outputShape('{"cause":"z","fix":"w"}')).toEqual(outputShape('{"fix":"y","cause":"x"}'));
  });
});
