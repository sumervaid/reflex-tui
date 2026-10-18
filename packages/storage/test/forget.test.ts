import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import type { Suggestion } from "@reflex/analysis";
import { Store } from "../src/db";

const trace = (id: string, endedAt?: string, source = "claude-code") =>
  ({ sessionId: id, source, endedAt, actionSequence: [], intents: [], contextHash: `h-${id}` }) as unknown as WorkflowTrace;
const file = (path: string) => ({ path, source: "claude-code", size: 10, mtimeMs: 1, ctimeMs: 2, ino: "3", codeKey: "c", redactionKey: "r", skippedRecords: 0 });
const evidence = (id: string) => ({ sessionId: id, source: "claude-code", excerpt: `request ${id}`, actions: [], verified: false, duplicates: 0, sourceFile: "f" });
const suggestion = (ids: string[]) => ({ slug: "fix-ci", title: "Fix CI", steps: [], evidence: ids.map(evidence), sourceSessions: ids }) as unknown as Suggestion;

describe("forgetting kept sessions", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-forget-"));
  });

  it("plans by deleted transcript and by age, never by age for a session without an end time", () => {
    const store = new Store();
    try {
      store.saveFile(file("/h/gone.jsonl"), [trace("gone", "2026-10-15T00:00:00Z")]);
      store.markMissing("/h/gone.jsonl");
      store.saveFile(file("/h/old.jsonl"), [trace("old", "2026-01-01T00:00:00Z", "codex")]);
      store.saveFile(file("/h/new.jsonl"), [trace("new", "2026-10-16T00:00:00Z")]);
      store.saveFile(file("/h/undated.jsonl"), [trace("undated")]);
      expect(store.forgetPlan({ missing: true })).toMatchObject({ paths: ["/h/gone.jsonl"], sessionIds: ["gone"], missingFiles: 1 });
      expect(store.forgetPlan({ before: "2026-06-01T00:00:00Z" })).toMatchObject({ paths: ["/h/old.jsonl"], sessionIds: ["old"], bySource: { codex: 1 } });
      expect(store.forgetPlan({ before: "2026-12-01T00:00:00Z", missing: true }).sessionIds.sort()).toEqual(["gone", "new", "old"]);
    } finally {
      store.close();
    }
  });

  it("removes the sessions, their cache entries and their evidence, and marks the analysis stale", () => {
    const store = new Store();
    try {
      const a = store.saveFile(file("/h/a.jsonl"), [trace("a", "2026-10-15T00:00:00Z")]);
      const b = store.saveFile(file("/h/b.jsonl"), [trace("b", "2026-10-15T00:00:00Z")]);
      const scanId = store.saveScan({ startedAt: "t", days: 7, mode: "local", sources: {}, files: 2, sessions: 2, partial: 0, unreadable: 0, skippedRecords: 0 }, [...a, ...b].map((t) => t.row));
      store.saveAnalysis(scanId, "key", { stats: {} as never, repositories: 1 });
      store.saveSuggestions(scanId, [suggestion(["a", "b"])]);

      store.forget({ paths: ["/h/a.jsonl"], sessionIds: ["a"] });

      expect(store.traces().map((t) => t.sessionId)).toEqual(["b"]);
      expect(store.cachedFile("/h/a.jsonl")).toBeUndefined();
      expect(store.contextHashes()).toEqual(["h-b"]);
      const [s] = store.suggestions();
      expect(s!.data.evidence.map((e) => e.sessionId)).toEqual(["b"]);
      expect(s!.data.sourceSessions).toEqual(["b"]);
      expect(store.latestScan()).toMatchObject({ sessions: 1, analysisKey: undefined });
    } finally {
      store.close();
    }
  });

  it("keeps everything unless a retention is set", () => {
    const store = new Store();
    try {
      expect(store.retentionDays()).toBeUndefined();
      store.setRetentionDays(180);
      expect(store.retentionDays()).toBe(180);
      store.setRetentionDays(undefined);
      expect(store.retentionDays()).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
