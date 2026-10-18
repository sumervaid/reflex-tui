import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db";
import { paths } from "../src/paths";

/** Another process that holds the database's write lock for `ms`, the way a long scan does. */
function holdWriteLock(file: string, ms: number): Promise<{ locked: Promise<void>; done: Promise<number | null> }> {
  const code = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('held', '1')");
    process.stdout.write("locked\\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
    db.exec("COMMIT");
    db.close();`;
  const child = spawn(process.execPath, ["--no-warnings", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const locked = new Promise<void>((resolve) => child.stdout.on("data", (d: Buffer) => d.toString().includes("locked") && resolve()));
  const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return Promise.resolve({ locked, done });
}

describe("several Reflex processes on one database", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-concurrency-"));
  });

  it("reads while another process writes, and waits for it to write", async () => {
    const store = new Store();
    const other = await holdWriteLock(paths.db(), 1500);
    await other.locked;
    try {
      let start = performance.now();
      expect(store.memoryEntries()).toEqual([]);
      expect(performance.now() - start).toBeLessThan(500);

      start = performance.now();
      store.addMemory("use pnpm, not npm");
      expect(performance.now() - start).toBeGreaterThan(500);
      expect(store.memoryEntries().map((e) => e.text)).toEqual(["use pnpm, not npm"]);
    } finally {
      store.close();
    }
    expect(await other.done).toBe(0);
  }, 30_000);

  it("opens while another process writes, waiting for it", async () => {
    new Store().close();
    const other = await holdWriteLock(paths.db(), 1000);
    await other.locked;
    const store = new Store();
    store.close();
    expect(await other.done).toBe(0);
  }, 30_000);

  it("keeps the write-ahead log files private like the database", () => {
    const store = new Store();
    try {
      store.addMemory("keep the changelog short");
      for (const f of [paths.db(), `${paths.db()}-wal`, `${paths.db()}-shm`]) expect(statSync(f).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });
});
