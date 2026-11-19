import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, paths } from "@reflex/storage";
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
  async function printedFor(setup: () => Promise<void> | void = () => {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "reflex-doctor-"));
    for (const k of KEYS) process.env[k] = join(root, k.toLowerCase());
    await setup();
    let printed = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed += String(chunk);
      return true;
    });
    await doctor();
    return printed;
  }

  it("shows what the last scan's file limit left out", async () => {
    const printed = await printedFor(async () => {
      await mkdir(paths.home(), { recursive: true });
      const store = new Store();
      const capped = { codex: { skipped: 12, oldestRead: "2026-03-03T00:00:00.000Z" } };
      store.saveScan({ startedAt: "2026-11-04T00:00:00.000Z", days: 30, mode: "local", sources: { codex: 2000 }, files: 2000, sessions: 0, partial: 0, unreadable: 0, skippedRecords: 0, capped }, []);
      store.close();
    });
    expect(printed).toContain("Last scan · Codex: 12 older files not read");
    expect(printed).toContain("go back to 2026-03-03");
  });

  it("says nothing about the limit, and creates no database, before the first scan", async () => {
    const printed = await printedFor();
    expect(printed).not.toContain("Last scan");
    expect(existsSync(paths.db())).toBe(false);
  });

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
