import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../src/cursor";
import { CursorDbChats } from "../src/cursor-models";

const NOW = new Date("2026-10-11T20:00:00Z");
const opts = { days: 3650, now: NOW };
let root: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cursor-db-"));
  dbPath = join(root, "state.vscdb");
  db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

let bubble = 0;
function bubbleRow(chatId: string, type: number, value: Record<string, unknown>): void {
  bubble++;
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(`bubbleId:${chatId}:${String(bubble).padStart(4, "0")}`, JSON.stringify(value));
}

function composer(chatId: string, opts: { bubbles: Array<{ bubbleId: string; type: number }>; subagents?: string[]; updatedMs?: number }): void {
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `composerData:${chatId}`,
    JSON.stringify({
      composerId: chatId,
      isAgentic: 1,
      lastUpdatedAt: opts.updatedMs ?? Date.UTC(2026, 9, 10),
      fullConversationHeadersOnly: opts.bubbles,
      ...(opts.subagents ? { subagentComposerIds: opts.subagents } : {}),
    }),
  );
}

const user = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } });

async function transcriptOnDisk(chatId: string): Promise<void> {
  const dir = join(root, "ws", "agent-transcripts", chatId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${chatId}.jsonl`);
  await writeFile(path, JSON.stringify(user("<user_query>fix ci</user_query>")) + "\n");
  await utimes(path, NOW, NOW);
}

async function seedDb(): Promise<void> {
  // chat1: exists only in the database. Its bubbles: request, failing shell, refused shell, a read, a broken edit, an answer.
  const headers: Array<{ bubbleId: string; type: number }> = [];
  const add = (type: number, value: Record<string, unknown>): void => {
    bubbleRow("chat1", type, value);
    headers.push({ bubbleId: String(bubble).padStart(4, "0"), type });
  };
  add(1, { text: "NPM_TOKEN=npm_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 publish the package", createdAt: "2026-10-09T10:00:00.000Z" });
  add(2, { toolFormerData: { name: "run_terminal_command_v2", status: "completed", params: JSON.stringify({ command: "pnpm publish --access public" }), result: JSON.stringify({ output: "error", exitCode: 1 }) }, createdAt: "2026-10-09T10:01:00.000Z" });
  add(2, { toolFormerData: { name: "run_terminal_command_v2", status: "completed", params: JSON.stringify({ command: "rm -rf /" }), result: JSON.stringify({ rejected: true }) }, createdAt: "2026-10-09T10:02:00.000Z" });
  add(2, { toolFormerData: { name: "read_file_v2", status: "completed", params: JSON.stringify({ targetFile: "/repo/package.json" }) }, createdAt: "2026-10-09T10:03:00.000Z" });
  add(2, { toolFormerData: { name: "edit_file_v2", status: "error", params: JSON.stringify({ relativeWorkspacePath: "src/a.ts" }) }, createdAt: "2026-10-09T10:04:00.000Z" });
  add(2, { text: "done", createdAt: "2026-10-09T10:05:00.000Z" });
  composer("chat1", { bubbles: headers, subagents: ["subchat1"], updatedMs: Date.UTC(2026, 9, 9, 10, 5) });
  // subchat1: a sub-agent of chat1 — skipped, never counted twice.
  const subHeaders = [{ bubbleId: "9001", type: 1 }];
  bubbleRow("subchat1", 1, { text: "sub-agent work" });
  composer("subchat1", { bubbles: subHeaders, updatedMs: Date.UTC(2026, 9, 9, 11) });
  // chat3: has a transcript file on disk — the database copy is skipped.
  const diskHeaders = [{ bubbleId: "8001", type: 1 }];
  bubbleRow("chat3", 1, { text: "already on disk" });
  composer("chat3", { bubbles: diskHeaders, updatedMs: Date.UTC(2026, 9, 10, 12) });
  await transcriptOnDisk("chat3");
}

function adapter(): CursorAdapter {
  return new CursorAdapter(root, dbPath);
}

describe("chats that only Cursor's database holds", () => {
  it("parse with consent: requests redacted, tool outcomes attached, subagents and on-disk chats skipped", async () => {
    await seedDb();
    const a = adapter();
    const answers = [true, true, true, true];
    await a.requestPermission(async () => answers.shift()!, 3650);
    expect(a.readsDbChats).toBe(true);
    const files = await a.discover(opts);
    const paths = files.map((f) => f.path);
    
    
    expect(paths.some((p) => p.includes("_app-database") && p.includes("chat1"))).toBe(true);
    expect(paths.some((p) => p.includes("subchat1"))).toBe(false);
    expect(paths.some((p) => p.includes("chat3") && p.includes("_app-database"))).toBe(false);
    expect(paths.some((p) => p.endsWith("chat3.jsonl") && !p.includes("_app-database"))).toBe(true);

    const file = files.find((f) => f.path.includes("chat1"))!;
    const result = await a.parse(file, opts);
    const session = result.sessions[0]!;
    expect(session.requests.map((r) => r.text)).toEqual(["NPM_TOKEN=[REDACTED] publish the package"]);
    expect(session.project).toBeUndefined(); // no workspace is recorded for database-only chats
    expect(session.outcomesRead).toBe(true);
    const shells = session.events.filter((e) => e.kind === "shell");
    expect(shells.map((e) => (e.kind === "shell" ? `${e.command}${e.isError ? " (failed)" : e.rejected ? " (refused)" : ""}` : ""))).toEqual([
      "pnpm publish --access public (failed)",
      "rm -rf / (refused)",
    ]);
    const reads = session.events.filter((e) => e.kind === "file");
    expect(reads[0]).toMatchObject({ op: "read", path: "/repo/package.json" });
    expect(reads[1]).toMatchObject({ op: "edit", path: "src/a.ts", isError: true });
    expect(session.models).toEqual([]); // the model index was constructed; the chat records no models
  });

  it("declining the fourth ask changes nothing", async () => {
    await seedDb();
    const a = adapter();
    const answers = [true, true, true, false];
    await a.requestPermission(async () => answers.shift()!, 3650);
    expect(a.readsDbChats).toBe(false);
    const files = await a.discover(opts);
    expect(files.every((f) => !f.path.includes("_app-database"))).toBe(true);
  });

  it("the reader lists only chats with content that no transcript covers", async () => {
    await seedDb();
    const reader = new CursorDbChats(dbPath);
    const subs = reader.subagentIds()!;
    expect(subs.has("subchat1")).toBe(true);
    const chats = reader.chats(new Set(["chat3"]), subs)!;
    expect(chats.map((c) => c.id)).toEqual(["chat1"]);
    expect(chats[0]!.bubbles).toBe(6);
    const bubbles = reader.bubbles("chat1")!;
    expect(bubbles).toHaveLength(6);
    expect(bubbles[0]).toMatchObject({ type: 1, createdAt: "2026-10-09T10:00:00.000Z" });
    expect(bubbles[1]!.tool).toMatchObject({ name: "run_terminal_command_v2", status: "completed", exitCode: 1, rejected: false });
    expect(bubbles[2]!.tool).toMatchObject({ rejected: true });
    expect(bubbles[3]!.tool).toMatchObject({ readPath: "/repo/package.json" });
    expect(bubbles[4]!.tool).toMatchObject({ editPath: "src/a.ts", status: "error" });
    reader.close();
  });
});
