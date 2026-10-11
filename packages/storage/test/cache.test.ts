import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { Store } from "../src/db";
import { paths } from "../src/paths";

const trace = (id: string) => ({ sessionId: id, source: "claude-code", actionSequence: [], intents: [], contextHash: `h-${id}` }) as unknown as WorkflowTrace;
const file = (path: string) => ({ path, source: "claude-code", size: 10, mtimeMs: 1, ctimeMs: 2, ino: "3", codeKey: "c", redactionKey: "r", skippedRecords: 0 });

describe("transcript cache", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-cache-"));
  });

  it("replaces a file's traces atomically and exposes the scan's working set", () => {
    const store = new Store();
    try {
      const a = store.saveFile(file("/h/a.jsonl"), [trace("a1"), trace("a2")]);
      store.saveFile(file("/h/b.jsonl"), [trace("b1")]);
      const a2 = store.saveFile({ ...file("/h/a.jsonl"), size: 20 }, [trace("a3")]);
      expect(store.fileTraces("/h/a.jsonl").map((t) => t.trace.sessionId)).toEqual(["a3"]);
      expect(store.cachedFile("/h/a.jsonl")?.size).toBe(20);
      expect(a.length).toBe(2);
      store.saveScan({ startedAt: "t", days: 7, mode: "local", sources: {}, files: 2, sessions: 1, partial: 0, unreadable: 0, skippedRecords: 0 }, a2.map((t) => t.row));
      expect(store.traces().map((t) => t.sessionId)).toEqual(["a3"]);
      expect(store.contextHashes().sort()).toEqual(["h-a3", "h-b1"]);
    } finally {
      store.close();
    }
  });

  it("marks deleted transcripts without dropping their traces", () => {
    const store = new Store();
    try {
      store.saveFile(file("/h/gone.jsonl"), [trace("g1")]);
      store.markMissing("/h/gone.jsonl");
      expect(store.cachedFile("/h/gone.jsonl")?.missing).toBe(true);
      expect(store.fileTraces("/h/gone.jsonl")).toHaveLength(1);
      store.saveFile(file("/h/gone.jsonl"), [trace("g1")]);
      expect(store.cachedFile("/h/gone.jsonl")?.missing).toBe(false);
    } finally {
      store.close();
    }
  });

  it("drops the old per-scan session table when upgrading", () => {
    const db = new DatabaseSync(paths.db());
    db.exec("CREATE TABLE sessions (row_id INTEGER PRIMARY KEY, trace_json TEXT); PRAGMA user_version = 3;");
    db.close();
    const store = new Store();
    store.close();
    const check = new DatabaseSync(paths.db());
    const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    check.close();
    expect(tables).not.toContain("sessions");
    expect(tables).toEqual(expect.arrayContaining(["transcript_files", "traces", "scan_sessions"]));
  });
});
