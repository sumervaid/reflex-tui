import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/codex";
import { FIX_CI, toCodexLines } from "@reflex/test-fixtures";

const NOW = new Date("2026-10-11T12:00:00Z");
const opts = { days: 7, now: NOW };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-codex-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRollout(name: string, lines: Array<Record<string, unknown> | string>): Promise<void> {
  const dir = join(root, "2026", "10", "10");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
}

async function parseAll() {
  const adapter = new CodexAdapter(root);
  const files = await adapter.discover(opts);
  return Promise.all(files.map((f) => adapter.parse(f, opts)));
}

const line = (type: string, payload: Record<string, unknown>) => ({ timestamp: "2026-10-10T10:00:00.000Z", type, payload });
const meta = line("session_meta", { id: "sess-1", cwd: "/Users/jordan/code/billing-api", timestamp: "2026-10-10T10:00:00.000Z" });
const userMsg = (text: string) => line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });

describe("CodexAdapter", () => {
  it("parses both shell call shapes, apply_patch edits and exit codes", async () => {
    const sessions = FIX_CI.filter((s) => s.source === "codex");
    const toolNames = new Set<unknown>();
    for (const [i, s] of sessions.entries()) {
      const { lines } = toCodexLines(s, new Date("2026-10-10T09:00:00Z"), `id-${i}`, i % 2 === 0 ? "shell" : "exec_command");
      for (const l of lines) if ((l.payload as { type?: string }).type === "function_call") toolNames.add((l.payload as { name?: string }).name);
      await writeRollout(`rollout-2026-10-10T09-00-0${i}-id-${i}.jsonl`, lines);
    }
    expect(toolNames).toEqual(new Set(["shell", "exec_command"]));
    const results = await parseAll();
    expect(results).toHaveLength(sessions.length);
    for (const r of results) {
      const s = r.sessions[0]!;
      expect(s.source).toBe("codex");
      expect(s.id).toMatch(/^codex:id-\d$/);
      expect(s.requests).toHaveLength(1);
      expect(s.requests[0]!.text).not.toContain("environment_context");
      expect(s.events.some((e) => e.kind === "shell" && e.command.startsWith("git status"))).toBe(true);
      expect(s.events.some((e) => e.kind === "file" && e.op === "edit")).toBe(true);
      expect(s.events.some((e) => e.kind === "shell" && e.isError === true)).toBe(true);
    }
  });

  it("only reads rollout-* files", async () => {
    await writeRollout("rollout-a.jsonl", [meta, userMsg("fix ci")]);
    await writeRollout("history.jsonl", [meta, userMsg("not a session")]);
    const results = await parseAll();
    expect(results).toHaveLength(1);
  });

  it("falls back to event_msg user messages and handles local_shell_call", async () => {
    await writeRollout("rollout-b.jsonl", [
      meta,
      line("event_msg", { type: "user_message", message: "why does lint fail" }),
      line("response_item", { type: "local_shell_call", call_id: "c1", action: { type: "exec", command: ["bash", "-lc", "pnpm lint"] } }),
      line("response_item", { type: "function_call_output", call_id: "c1", output: "Process exited with exit code: 2" }),
    ]);
    const [r] = await parseAll();
    const s = r!.sessions[0]!;
    expect(s.requests.map((q) => q.text)).toEqual(["why does lint fail"]);
    expect(s.events).toContainEqual(expect.objectContaining({ kind: "shell", command: "pnpm lint", isError: true }));
  });

  it("skips malformed lines and bad tool arguments without failing the file", async () => {
    await writeRollout("rollout-c.jsonl", [
      meta,
      userMsg("fix the build"),
      "{oops",
      line("response_item", { type: "function_call", name: "shell", arguments: "{not json", call_id: "c2" }),
    ]);
    const [r] = await parseAll();
    expect(r!.unreadable).toBe(false);
    expect(r!.skippedRecords).toBeGreaterThanOrEqual(1);
    expect(r!.sessions[0]!.requests[0]!.text).toBe("fix the build");
  });

  it("keeps the last cumulative token_count and splits cached input out", async () => {
    const count = (input: number, cached: number, output: number) =>
      line("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } });
    await writeRollout("rollout-e.jsonl", [
      meta,
      userMsg("fix ci"),
      line("event_msg", { type: "token_count", info: null }),
      count(1000, 600, 50),
      count(3000, 2000, 120),
    ]);
    const [r] = await parseAll();
    expect(r!.sessions[0]!.usage).toEqual({ input: 1000, output: 120, cacheRead: 2000, cacheWrite: 0 });
  });

  it("redacts secrets in commands", async () => {
    await writeRollout("rollout-d.jsonl", [
      meta,
      userMsg("deploy"),
      line("response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh run list" }),
        call_id: "c3",
      }),
    ]);
    const [r] = await parseAll();
    const shell = r!.sessions[0]!.events.find((e) => e.kind === "shell");
    expect(shell && shell.kind === "shell" && shell.command).not.toContain("ghp_");
  });
});
