import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { analyze } from "../src/suggest";
import { reviewSkill } from "../src/improve";
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
});
