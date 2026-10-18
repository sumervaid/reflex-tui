import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cursorUsageOff, cursorUsageOn, cursorUsageStatus } from "../src/commands/cursor-usage";
import { hookCommand, hookScript, installHook } from "../src/cursor-hook";

let root: string;
let hooksFile: string;
let output = "";
const capture = async (fn: () => Promise<void>) => {
  output = "";
  await fn();
  return output;
};
const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8")) as { version: number; hooks: Record<string, Array<{ command: string }>> };
const MINE = { version: 1, hooks: { afterFileEdit: [{ command: ".cursor/hooks/format.sh" }], stop: [{ command: "./hooks/notify.sh", timeout: 3 }] } };

/** Run the installed hook script the way Cursor does: payload on stdin, JSON expected on stdout. */
function fire(payload: Record<string, unknown>): string {
  const r = spawnSync(process.execPath, [hookScript()], { input: JSON.stringify(payload), encoding: "utf8" });
  return r.stdout;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-cursor-hook-"));
  process.env.REFLEX_HOME = join(root, "home");
  hooksFile = join(root, "cursor", "hooks.json");
  process.env.REFLEX_CURSOR_HOOKS_FILE = hooksFile;
  await mkdir(join(root, "cursor"), { recursive: true });
  await writeFile(hooksFile, JSON.stringify(MINE, null, 2));
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
});

afterAll(async () => {
  vi.restoreAllMocks();
  delete process.env.REFLEX_CURSOR_HOOKS_FILE;
  await rm(root, { recursive: true, force: true });
});

describe("reflex cursor-usage", () => {
  it("asks first and changes nothing without consent", async () => {
    const text = await capture(() => cursorUsageOn({}));
    expect(text).toContain("no (not interactive; pass --yes to consent)");
    expect(await readJson(hooksFile)).toEqual(MINE);
  });

  it("on: adds its hook next to yours and backs the file up", async () => {
    const text = await capture(() => cursorUsageOn({ yes: true }));
    expect(text).toContain("Hook on (stop, afterAgentResponse)");
    const after = await readJson(hooksFile);
    expect(after.hooks.afterFileEdit).toEqual(MINE.hooks.afterFileEdit);
    expect(after.hooks.stop![0]).toEqual(MINE.hooks.stop[0]);
    expect(after.hooks.stop![1]!.command).toBe(hookCommand());
    expect(after.hooks.afterAgentResponse![0]!.command).toBe(hookCommand());
    const backups = await readdir(join(root, "home", "backups"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, "home", "backups", backups[0]!), "utf8"))).toEqual(MINE);

    await capture(() => cursorUsageOn({ yes: true }));
    expect((await readJson(hooksFile)).hooks.stop).toHaveLength(2);
  });

  it("the hook records ids, model and token counts, never text, and never blocks the agent", async () => {
    const base = { conversation_id: "c0ffee00-1111-4222-8333-444455556666", generation_id: "f0e1d2c3-7777-4888-8999-aaaabbbbcccc", model: "claude-4.7-opus", model_id: "claude-opus-4-7" };
    expect(fire({ ...base, hook_event_name: "stop", status: "completed", input_tokens: 1180993, output_tokens: 8146, cache_read_tokens: 1007022, cache_write_tokens: 173957 })).toBe("{}");
    expect(fire({ ...base, hook_event_name: "afterAgentResponse", text: "SECRET ANSWER sk-ant-abcdefghijklmnopqrstuvwxyz", input_tokens: 10, output_tokens: 1 })).toBe("{}");
    expect(fire({ ...base, hook_event_name: "stop", status: "aborted" })).toBe("{}");
    expect(fire({ ...base, conversation_id: "../../etc", hook_event_name: "stop", input_tokens: 5 })).toBe("{}");
    expect(fire({ hook_event_name: "beforeSubmitPrompt", prompt: "hello", ...base, input_tokens: 5 })).toBe("{}");
    expect(spawnSync(process.execPath, [hookScript()], { input: "not json", encoding: "utf8" }).stdout).toBe("{}");

    const raw = await readFile(join(root, "home", "cursor-usage.jsonl"), "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ event: "stop", conversation_id: base.conversation_id, model: "claude-opus-4-7", input_tokens: 1180993, cache_write_tokens: 173957 });
    expect(raw).not.toMatch(/SECRET|sk-ant|hello|text|prompt/);

    const status = await capture(() => cursorUsageStatus());
    expect(status).toMatch(/Hook\s+on/);
    expect(status).toMatch(/Recorded\s+1 turn in 1 chat/);
  });

  it("off: removes only its entries and keeps what was recorded", async () => {
    await capture(() => cursorUsageOff());
    expect(await readJson(hooksFile)).toEqual(MINE);
    expect(await readFile(join(root, "home", "cursor-usage.jsonl"), "utf8")).toContain("claude-opus-4-7");
    expect(await capture(() => cursorUsageOff())).toContain("The hook was not on.");
  });

  it("refuses to overwrite invalid JSON or write through a symlink", async () => {
    await writeFile(hooksFile, "{ not json");
    await expect(installHook(hooksFile)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(hooksFile, "utf8")).toBe("{ not json");
    const real = join(root, "real-hooks.json");
    await writeFile(real, JSON.stringify(MINE));
    const link = join(root, "linked-hooks.json");
    await symlink(real, link);
    await expect(installHook(link)).rejects.toThrow(/symlink/);
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual(MINE);
  });

  it("creates the hooks file when Cursor has none", async () => {
    const fresh = join(root, "fresh", "hooks.json");
    await installHook(fresh);
    expect((await readJson(fresh)).hooks.stop![0]!.command).toBe(hookCommand());
  });
});
