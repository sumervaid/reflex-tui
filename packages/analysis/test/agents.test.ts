import { describe, expect, it } from "vitest";
import type { NormalizedSession } from "@reflex/core";
import { buildTrace } from "../src/trace";

const session: NormalizedSession = {
  id: "cursor:p1",
  source: "cursor",
  startedAt: "2026-10-12T10:00:00.000Z",
  requests: [{ text: "why is checkout slow" }],
  events: [
    { kind: "user", text: "why is checkout slow" },
    { kind: "tool", tool: "Task" },
    { kind: "shell", command: "pnpm test", byAgent: true },
    { kind: "file", op: "read", path: "config/retry.json", byAgent: true },
    { kind: "file", op: "edit", path: "src/checkout.ts" },
  ],
  sourceRef: { file: "~/x/p1.jsonl", nativeId: "p1" },
  skippedRecords: 0,
  agents: {
    transcripts: 3,
    spawned: [
      { type: "explore", model: "gpt-5.5", background: true, description: "Find the retry config" },
      { type: "explore", background: false, description: "" },
      { type: "generalPurpose", model: "gpt-5.5", background: false, description: "Profile the API" },
    ],
  },
};

describe("agents in a trace", () => {
  it("summarizes launched agents and counts their work in the session's actions", () => {
    const t = buildTrace(session);
    expect(t.agents).toEqual({
      spawned: 3,
      types: { explore: 2, generalPurpose: 1 },
      background: 1,
      models: ["gpt-5.5"],
      descriptions: ["Find the retry config", "Profile the API"],
      transcripts: 3,
      toolCalls: 2,
    });
    expect(t.toolCalls).toBe(4);
    expect(t.actionSequence).toContain("run-tests");
    expect(t.intents).not.toContain("retry");
    expect(buildTrace({ ...session, agents: undefined }).agents).toBeUndefined();
  });
});
