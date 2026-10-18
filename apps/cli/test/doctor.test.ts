import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_GAPS, doctor } from "../src/commands/misc";

const KEYS = ["HOME", "REFLEX_HOME", "REFLEX_CLAUDE_DIR", "REFLEX_CODEX_DIR", "REFLEX_CURSOR_DIR", "CODEX_HOME"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("reflex doctor", () => {
  it("lists what Cursor sessions lack, next to the Cursor hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "reflex-doctor-"));
    for (const k of KEYS) process.env[k] = join(root, k.toLowerCase());
    let printed = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed += String(chunk);
      return true;
    });
    await doctor();
    const cursor = printed.slice(printed.indexOf("Cursor token usage"));
    expect(cursor).toContain("Cursor records less than Claude Code and Codex");
    for (const gap of CURSOR_GAPS) expect(cursor).toContain(gap);
  });
});
