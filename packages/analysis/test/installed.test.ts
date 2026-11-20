import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { FIX_CI } from "@reflex/test-fixtures";
import { analyze } from "../src/suggest";
import { fixtureTraces } from "./helpers";

/** FIX_CI's traces, oldest first, with the cluster's members separated out. */
async function fixCiMembers(): Promise<{ traces: WorkflowTrace[]; members: WorkflowTrace[]; total: number }> {
  const traces = (await fixtureTraces(FIX_CI)).sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const base = analyze(traces).suggestions.find((x) => x.slug.startsWith("fix-ci"))!;
  const ids = new Set(base.evidence.map((e) => e.sessionId));
  const members = traces.filter((t) => ids.has(t.sessionId));
  return { traces, members, total: base.instances };
}

const load = (t: WorkflowTrace): void => {
  t.skillsUsed = ["fix-ci"];
};

describe("sessions that used the installed skill", () => {
  it("count as use, not evidence: the split shows in the count, the evidence and the notes", async () => {
    const { traces, members, total } = await fixCiMembers();
    const boundary = members[members.length - 2]!.startedAt!;
    load(members[members.length - 1]!);
    const { suggestions } = analyze(traces, { installed: new Map([["fix-ci", boundary]]) });
    const s = suggestions.find((x) => x.slug.startsWith("fix-ci"))!;
    expect(s.instances).toBe(total - 1);
    expect(s.usage).toBe(1);
    const used = s.evidence[s.evidence.length - 1]!;
    expect(used.afterInstall).toBe(true);
    expect(s.evidence.slice(0, -1).every((e) => !e.afterInstall)).toBe(true);
    expect(s.notes.some((n) => n.includes("they count as use, not evidence"))).toBe(true);
  });

  it("a session before the install that loaded the skill is still evidence", async () => {
    const { traces, members, total } = await fixCiMembers();
    // Installed after the session that loaded it: at that point the load cannot be Reflex's doing.
    const boundary = new Date(Date.parse(members[members.length - 1]!.startedAt!) + 1).toISOString();
    load(members[members.length - 1]!);
    const { suggestions } = analyze(traces, { installed: new Map([["fix-ci", boundary]]) });
    const s = suggestions.find((x) => x.slug.startsWith("fix-ci"))!;
    expect(s.instances).toBe(total);
    expect(s.usage).toBeUndefined();
    expect(s.evidence.every((e) => !e.afterInstall)).toBe(true);
  });

  it("a session after the install that did not load the skill is still evidence", async () => {
    const { traces, total } = await fixCiMembers();
    const boundary = traces[0]!.startedAt!; // every session is after the install; none load it
    const { suggestions } = analyze(traces, { installed: new Map([["fix-ci", boundary]]) });
    const s = suggestions.find((x) => x.slug.startsWith("fix-ci"))!;
    expect(s.instances).toBe(total);
    expect(s.usage).toBeUndefined();
  });

  it("when every session in the cluster loaded the skill, the count is zero and the state is named", async () => {
    const { traces, members, total } = await fixCiMembers();
    const boundary = members[0]!.startedAt!;
    for (const m of members) load(m);
    const { suggestions } = analyze(traces, { installed: new Map([["fix-ci", boundary]]) });
    const s = suggestions.find((x) => x.slug.startsWith("fix-ci"))!;
    expect(s.instances).toBe(0);
    expect(s.usage).toBe(total);
    expect(s.notes.some((n) => n.includes("use of your skill, not independent evidence"))).toBe(true);
  });

  it("without installs, the count is every session, as before", async () => {
    const { traces, members, total } = await fixCiMembers();
    load(members[members.length - 1]!);
    const { suggestions } = analyze(traces);
    const s = suggestions.find((x) => x.slug.startsWith("fix-ci"))!;
    expect(s.instances).toBe(total);
    expect(s.usage).toBeUndefined();
    expect(s.evidence.some((e) => e.afterInstall)).toBe(false);
  });
});
