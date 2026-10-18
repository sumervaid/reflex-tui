import { mkdir, mkdtemp, rm, utimes, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CursorAdapter } from "../src/cursor";
import { CursorUsageLog } from "../src/cursor-usage";

const NOW = new Date("2026-10-17T20:00:00Z");
const opts = { days: 7, now: NOW };
let root: string;
let log: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cursor-usage-"));
  log = join(root, "cursor-usage.jsonl");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const turn = (conv: string, gen: string, event: string, input: number, output: number, cacheRead: number, cacheWrite: number, model = "claude-opus-4-7", at = "2026-10-17T19:00:00.000Z") =>
  JSON.stringify({ v: 1, at, event, conversation_id: conv, generation_id: gen, model, input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite });

describe("CursorUsageLog", () => {
  it("counts each turn once, prefers stop, and keeps cached tokens out of input", async () => {
    await writeFile(
      log,
      [
        turn("c1", "g1", "afterAgentResponse", 1000, 50, 600, 300),
        turn("c1", "g1", "stop", 1180, 80, 700, 400),
        turn("c1", "g1", "afterAgentResponse", 1, 1, 0, 0),
        turn("c1", "g2", "afterAgentResponse", 500, 20, 0, 100, "gpt-5.5"),
        turn("c2", "g3", "stop", 100, 10, 0, 0),
        "{broken",
        JSON.stringify({ conversation_id: "../etc", generation_id: "g", input_tokens: 5 }),
      ].join("\n") + "\n",
    );
    const u = new CursorUsageLog(log);
    expect(u.usageFor(["c1"])).toEqual({
      usage: { input: 80 + 400, output: 80 + 20, cacheRead: 700, cacheWrite: 400 + 100 },
      byModel: { "claude-opus-4-7": { input: 80, output: 80, cacheRead: 700, cacheWrite: 400 }, "gpt-5.5": { input: 400, output: 20, cacheRead: 0, cacheWrite: 100 } },
    });
    expect(u.usageFor(["c1", "c2"])!.usage.output).toBe(110);
    expect(u.usageFor(["nope"])).toBeUndefined();
    expect(u.signature(["c1"])).toEqual({ turns: 2, latest: Date.parse("2026-10-17T19:00:00.000Z") });
    expect(new CursorUsageLog(join(root, "missing.jsonl")).usageFor(["c1"])).toBeUndefined();
  });
});

describe("CursorAdapter with recorded usage", () => {
  async function chat(id: string, agents: string[] = []): Promise<void> {
    const dir = join(root, "projects", "ws", "agent-transcripts", id);
    await mkdir(join(dir, "subagents"), { recursive: true });
    const user = { role: "user", message: { content: [{ type: "text", text: "<user_query>fix the flaky test</user_query>" }] } };
    await writeFile(join(dir, `${id}.jsonl`), JSON.stringify(user) + "\n");
    await utimes(join(dir, `${id}.jsonl`), NOW, NOW);
    for (const a of agents) {
      await writeFile(join(dir, "subagents", `${a}.jsonl`), JSON.stringify({ role: "assistant", message: { content: [] } }) + "\n");
      await utimes(join(dir, "subagents", `${a}.jsonl`), NOW, NOW);
    }
  }

  it("attaches the chat's and its agents' token counts, and re-reads a chat when new turns arrive", async () => {
    await chat("chat-1", ["agent-1"]);
    await writeFile(log, [turn("chat-1", "g1", "stop", 1000, 100, 800, 0), turn("agent-1", "g9", "stop", 200, 20, 0, 0, "composer-2")].join("\n") + "\n");
    const adapter = new CursorAdapter(join(root, "projects"), undefined, { usageLog: log });
    const [file] = await adapter.discover(opts);
    const s = (await adapter.parse(file!, opts)).sessions[0]!;
    expect(s.usage).toEqual({ input: 400, output: 120, cacheRead: 800, cacheWrite: 0 });
    expect(Object.keys(s.usageByModel!).sort()).toEqual(["claude-opus-4-7", "composer-2"]);

    await appendFile(log, turn("chat-1", "g2", "stop", 50, 5, 0, 0, "claude-opus-4-7", "2026-10-17T19:30:00.000Z") + "\n");
    const [again] = await new CursorAdapter(join(root, "projects"), undefined, { usageLog: log }).discover(opts);
    expect(again!.sizeBytes).toBe(file!.sizeBytes + 1);
    expect(again!.identity!.ctimeMs).toBeGreaterThanOrEqual(Date.parse("2026-10-17T19:30:00.000Z"));
  });

  it("leaves chats without recorded turns unpriced, and reads no log unless given one", async () => {
    await chat("chat-2");
    await writeFile(log, turn("other", "g1", "stop", 10, 1, 0, 0) + "\n");
    for (const adapter of [new CursorAdapter(join(root, "projects"), undefined, { usageLog: log }), new CursorAdapter(join(root, "projects"))]) {
      const [file] = await adapter.discover(opts);
      expect((await adapter.parse(file!, opts)).sessions[0]!.usage).toBeUndefined();
    }
  });
});
