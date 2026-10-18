import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  // Shaped after Codex's own types (openai/codex, codex-rs/protocol and core, October 2026):
  // paginated history, context Codex adds in the user role, `exec_command` output, `apply_patch`
  // as a custom tool, and token counts with rate limits.
  const current = (...rest: Array<Record<string, unknown>>) => [
    {
      timestamp: "2026-10-10T10:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: {
        session_id: "019a0000-0000-7000-8000-000000000001",
        id: "019a0000-0000-7000-8000-000000000001",
        timestamp: "2026-10-10T10:00:00.000Z",
        cwd: "/Users/jordan/code/billing-api",
        originator: "codex_cli_rs",
        cli_version: "0.130.0",
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
        history_mode: "paginated",
        base_instructions: { text: "You are Codex." },
      },
    },
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>sandbox</permissions instructions>" }] }),
    line("response_item", {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "# AGENTS.md instructions for /Users/jordan/code/billing-api\n\n<INSTRUCTIONS>\nRun pnpm test.\n</INSTRUCTIONS>" },
        { type: "input_text", text: "<environment_context>\n  <cwd>/Users/jordan/code/billing-api</cwd>\n</environment_context>" },
      ],
    }),
    line("turn_context", { cwd: "/Users/jordan/code/billing-api", model: "gpt-5.6-terra" }),
    ...rest,
  ];
  const exec = (id: string, cmd: string, exit: number) => [
    line("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd, workdir: "/Users/jordan/code/billing-api" }), call_id: id }),
    line("response_item", { type: "function_call_output", call_id: id, output: `Chunk ID: ${id}\nWall time: 2.1000 seconds\nProcess exited with code ${exit}\nOriginal token count: 30\nOutput:\nok` }),
  ];

  it("reads the format current Codex writes", async () => {
    await writeRollout(
      "rollout-2026-10-10T10-00-00-019a.jsonl",
      current(
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "fix the failing payments test" }] }),
        line("event_msg", {
          type: "item_completed",
          thread_id: "019a0000-0000-7000-8000-000000000001",
          turn_id: "t1",
          item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "fix the failing payments test", text_elements: [] }] },
        }),
        ...exec("c1", "pnpm test payments", 1),
        line("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "c2", input: "*** Begin Patch\n*** Update File: src/payments.ts\n@@\n-a\n+b\n*** End Patch" }),
        line("response_item", { type: "custom_tool_call_output", call_id: "c2", output: "Success. Updated the following files:\nM src/payments.ts" }),
        ...exec("c3", "pnpm test payments", 0),
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<user_shell_command>\n<command>\ngit status\n</command>\n</user_shell_command>" }] }),
        line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed the rounding in payments." }] }),
        line("event_msg", {
          type: "token_count",
          info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 400, reasoning_output_tokens: 250, total_tokens: 5400 } },
          rate_limits: { primary: { used_percent: 12.5, window_minutes: 300 } },
        }),
      ),
    );
    const [r] = await parseAll();
    expect(r!.skippedRecords).toBe(0);
    const s = r!.sessions[0]!;
    expect(s.sourceRef.nativeId).toBe("019a0000-0000-7000-8000-000000000001");
    expect(s.project?.name).toBe("billing-api");
    expect(s.requests.map((q) => q.text)).toEqual(["fix the failing payments test"]);
    const steps = s.events.filter((e) => e.kind !== "assistant").map((e) => (e.kind === "shell" ? `shell ${e.command} ${e.isError ? "failed" : "ok"}` : e.kind === "file" ? `${e.op} ${e.path}` : e.kind));
    expect(steps).toEqual(["user", "shell pnpm test payments failed", "edit src/payments.ts", "shell pnpm test payments ok"]);
    expect(s.usageByModel).toEqual({ "gpt-5.6-terra": { input: 2000, output: 400, cacheRead: 3000, cacheWrite: 0 } });
  });

  it("takes the request from the completed user message when that is all there is", async () => {
    await writeRollout(
      "rollout-f.jsonl",
      current(
        line("event_msg", { type: "item_completed", thread_id: "x", turn_id: "t1", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "add retries to the webhook client" }] } }),
        line("event_msg", { type: "user_message", message: "## My request for Codex:\nand log each retry" }),
      ),
    );
    const [r] = await parseAll();
    expect(r!.sessions[0]!.requests.map((q) => q.text)).toEqual(["add retries to the webhook client", "and log each retry"]);
  });

  it.each([
    ["an agent a session launched", { source: { subagent: { thread_spawn: { parent_thread_id: "019a", depth: 1 } } } }],
    ["a review", { source: { subagent: "review" } }],
    ["memory consolidation", { source: { internal: "memory_consolidation" } }],
    ["a guardian check", { source: "cli", thread_source: "guardian_review" }],
  ])("leaves out threads Codex started itself: %s", async (_, fields) => {
    await writeRollout("rollout-g.jsonl", [line("session_meta", { id: "sub-1", cwd: "/repo", ...fields }), userMsg("review the diff for bugs")]);
    const [r] = await parseAll();
    expect(r!.sessions).toEqual([]);
  });

  it("counts skipped lines by record type with REFLEX_DEBUG=1", async () => {
    await writeRollout("rollout-h.jsonl", [meta, userMsg("fix ci"), "{oops", line("event_msg", { message: "no type" })]);
    const logged: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (logged.push(String(chunk)), true));
    process.env.REFLEX_DEBUG = "1";
    try {
      await parseAll();
    } finally {
      delete process.env.REFLEX_DEBUG;
      vi.restoreAllMocks();
    }
    expect(logged.join("")).toContain("skippedByType=invalid JSON:1,event_msg without a type:1");
  });
});
