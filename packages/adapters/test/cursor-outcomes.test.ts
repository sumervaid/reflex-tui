import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedSession, SessionEvent } from "@reflex/core";
import { CursorAdapter } from "../src/cursor";
import { CursorToolOutcomes } from "../src/cursor-models";

const NOW = new Date("2026-10-11T20:00:00Z");
const opts = { days: 7, now: NOW };
let root: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cursor-out-"));
  dbPath = join(root, "state.vscdb");
  db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

const CHAT = "chat1";
let bubble = 0;
/** One tool call in Cursor's database. `params` and `result` are JSON-encoded strings, as Cursor stores them. */
function call(name: string, opts: { status: string; command?: string; result?: Record<string, unknown> }): void {
  bubble++;
  const toolFormerData: Record<string, unknown> = { name, status: opts.status };
  if (opts.command !== undefined) toolFormerData.params = JSON.stringify({ command: opts.command });
  if (opts.result) toolFormerData.result = JSON.stringify(opts.result);
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `bubbleId:${CHAT}:${String(bubble).padStart(4, "0")}`,
    JSON.stringify({ toolFormerData }),
  );
}

const user = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } });
const tool = (name: string, input: Record<string, unknown>) => ({ role: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

async function writeTranscript(lines: Array<Record<string, unknown>>): Promise<void> {
  const { mkdir, writeFile, utimes } = await import("node:fs/promises");
  const dir = join(root, "ws", "agent-transcripts", CHAT);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${CHAT}.jsonl`);
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await utimes(path, NOW, NOW);
}

function adapter(): CursorAdapter {
  return new CursorAdapter(root, dbPath);
}

async function parseWith(adapter: CursorAdapter): Promise<NormalizedSession[]> {
  const files = await adapter.discover(opts);
  const results = await Promise.all(files.map((f) => adapter.parse(f, opts)));
  return results.flatMap((r) => r.sessions);
}

describe("Cursor tool outcomes from the app database", () => {
  it("marks the events the database calls errors, and only those", async () => {
    call("run_terminal_command_v2", { status: "completed", command: "pnpm test", result: { output: "9 passed", exitCode: 1 } });
    call("run_terminal_command_v2", { status: "completed", command: "pnpm build", result: { output: "built" } });
    call("run_terminal_command_v2", { status: "completed", command: "rm -rf /", result: { rejected: true } });
    call("run_terminal_command_v2", { status: "cancelled", command: "git push" });
    call("run_terminal_command_v2", { status: "error", command: "npm ci" });
    // A row the transcript never had: it stays unconsumed and never marks anything.
    call("run_terminal_command_v2", { status: "error", command: "echo only-in-database" });
    call("read_file_v2", { status: "completed", result: { output: "..." } });
    call("edit_file_v2", { status: "error", result: { output: "conflict" } });
    call("ripgrep_raw_search", { status: "completed", result: { output: "[]" } });

    await writeTranscript([
      user("<timestamp>Sunday, Oct 11, 2026, 12:56 PM (UTC-7)</timestamp>\n<user_query>fix the build</user_query>"),
      tool("Shell", { command: "pnpm test" }),
      tool("Shell", { command: "pnpm  build" }), // different whitespace on purpose
      tool("Shell", { command: "rm -rf /" }),
      tool("Shell", { command: "git push" }),
      tool("Shell", { command: "npm ci" }),
      tool("ReadFile", { path: "/repo/a.ts" }),
      tool("StrReplace", { path: "package.json", old_string: "a", new_string: "b" }),
      tool("Grep", { pattern: "x" }),
    ]);

    const a = adapter();
    const allowed = await a.requestPermission(async () => true, 7);
    expect(allowed).toBe(true);
    expect(a.readsOutcomes).toBe(true);
    const [session] = await parseWith(a);
    const shells = session!.events.filter((e): e is Extract<SessionEvent, { kind: "shell" }> => e.kind === "shell");
    const byCommand = new Map(shells.map((e) => [e.command, e.isError]));
    expect(byCommand.get("pnpm test")).toBe(true); // non-zero exit code
    expect(byCommand.get("pnpm build")).toBeUndefined(); // completed cleanly
    expect(byCommand.get("rm -rf /")).toBeUndefined(); // rejected: never ran
    expect(byCommand.get("git push")).toBeUndefined(); // cancelled: never finished
    expect(byCommand.get("npm ci")).toBe(true); // error status
    // The refusal itself is recorded for the corrections pipeline (#72).
    const refused = shells.find((e) => e.command === "rm -rf /");
    expect(refused?.rejected).toBe(true);
    expect(shells.find((e) => e.command === "pnpm test")?.rejected).toBeUndefined();
    const files = session!.events.filter((e) => e.kind === "file");
    expect(files[0]!.isError).toBeUndefined(); // read completed
    expect(files[1]!.isError).toBe(true); // edit failed
    expect(session!.outcomesRead).toBe(true);
  });

  it("without consent, nothing is read and nothing is marked", async () => {
    call("run_terminal_command_v2", { status: "error", command: "pnpm test" });
    await writeTranscript([user("<user_query>fix it</user_query>"), tool("Shell", { command: "pnpm test" })]);
    const a = adapter();
    // First ask (sessions): yes; model names: yes; outcomes: no.
    const answers = [true, true, false];
    await a.requestPermission(async () => answers.shift()!, 7);
    expect(a.readsOutcomes).toBe(false);
    const [session] = await parseWith(a);
    expect(session!.outcomesRead).toBeUndefined();
    expect(session!.events.some((e) => "isError" in e && e.isError)).toBe(false);
  });

  it("requests a re-read of traces that have no outcomes yet", async () => {
    call("run_terminal_command_v2", { status: "error", command: "pnpm test" });
    await writeTranscript([user("<user_query>fix it</user_query>"), tool("Shell", { command: "pnpm test" })]);
    const a = adapter();
    await a.requestPermission(async () => true, 7);
    const [session] = await parseWith(a);
    const trace = session as unknown as Parameters<CursorAdapter["needsReread"]>[0];
    expect(a.needsReread(trace)).toBe(false);
    expect(a.needsReread({ ...trace, outcomesRead: undefined })).toBe(true);
  });

  it("reads nothing when the database is missing", async () => {
    const outcomes = new CursorToolOutcomes(join(root, "missing.vscdb"));
    expect(outcomes.forChat(CHAT)).toBeUndefined();
    outcomes.close();
  });

  it("the reader hands back only the five fields, never output text", async () => {
    call("run_terminal_command_v2", { status: "completed", command: "pnpm test", result: { output: "SECRET-OUTPUT", exitCode: 3 } });
    const outcomes = new CursorToolOutcomes(dbPath);
    const rows = outcomes.forChat(CHAT)!;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("SECRET-OUTPUT");
    expect(rows[0]).toEqual({ name: "run_terminal_command_v2", status: "completed", command: "pnpm test", exitCode: 3, rejected: false });
    outcomes.close();
  });
});
