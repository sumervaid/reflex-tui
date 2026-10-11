import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { CursorAdapter } from "../src/cursor";
import { CursorModelIndex } from "../src/cursor-models";

const NOW = new Date("2026-10-11T20:00:00Z");
const opts = { days: 7, now: NOW };
let root: string;
let dbPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cursor-models-"));
  dbPath = join(root, "state.vscdb");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const put = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  const bubble = (chat: string, i: number, model?: string) =>
    put.run(`bubbleId:${chat}:${i}`, JSON.stringify({ text: "secret message text", tokenCount: { inputTokens: 0, outputTokens: 0 }, ...(model ? { modelInfo: { modelName: model } } : {}) }));
  bubble("abc", 1, "claude-opus-5-5");
  bubble("abc", 2, "claude-opus-5-5");
  bubble("abc", 3, "gpt-5.5");
  bubble("abc", 4);
  bubble("abcd", 1, "should-not-leak-into-abc");
  bubble("bad", 1, "rm -rf /; $(evil)");
  put.run("composerData:only-chat", JSON.stringify({ modelConfig: { modelName: "grok-4.7" } }));
  put.run("bubbleId:broken:1", "{not json");
  db.close();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CursorModelIndex", () => {
  it("lists a chat's models by message count, without bleeding into ids that share a prefix", () => {
    const idx = new CursorModelIndex(dbPath);
    expect(idx.modelsFor("abc")).toEqual(["claude-opus-5-5", "gpt-5.5"]);
    expect(idx.modelsFor("only-chat")).toEqual(["grok-4.7"]);
    expect(idx.modelsFor("bad")).toEqual([]);
    expect(idx.modelsFor("broken")).toEqual([]);
    expect(idx.modelsFor("missing")).toEqual([]);
    expect(idx.modelsFor("x' OR 1=1 --")).toBeUndefined();
    idx.close();
  });

  it("returns undefined when the database can't be opened", () => {
    expect(new CursorModelIndex(join(root, "nope.vscdb")).modelsFor("abc")).toBeUndefined();
  });
});

describe("CursorAdapter model names", () => {
  async function transcript(id: string): Promise<void> {
    const dir = join(root, "projects", "ws", "agent-transcripts", id);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>fix ci</user_query>" }] } }) + "\n");
    await utimes(path, NOW, NOW);
  }

  it("asks separately and reads models only with consent", async () => {
    await transcript("abc");
    const asked: string[] = [];
    const denied = new CursorAdapter(join(root, "projects"), dbPath);
    expect(await denied.requestPermission(async (m) => (asked.push(m), asked.length === 1), 7)).toBe(true);
    expect(asked[1]).toContain("only model names are extracted, never messages");
    const [f] = await denied.discover(opts);
    expect((await denied.parse(f!, opts)).sessions[0]!.models).toBeUndefined();

    const allowed = new CursorAdapter(join(root, "projects"), dbPath);
    await allowed.requestPermission(async () => true, 7);
    const s = (await allowed.parse(f!, opts)).sessions[0]!;
    expect(s.models).toEqual(["claude-opus-5-5", "gpt-5.5"]);
    expect(JSON.stringify(s)).not.toContain("secret message text");
    expect(allowed.needsReread({ source: "cursor" } as WorkflowTrace)).toBe(true);
    expect(allowed.needsReread({ source: "cursor", models: [] } as unknown as WorkflowTrace)).toBe(false);
  });

  it("never touches the app database for a custom transcript folder", async () => {
    const custom = new CursorAdapter(join(root, "projects"));
    expect(custom.stateDb).toBeUndefined();
    const asked: string[] = [];
    await custom.requestPermission(async (m) => (asked.push(m), true), 7);
    expect(asked).toHaveLength(1);
  });
});
