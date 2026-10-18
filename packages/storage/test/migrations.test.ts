import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, Store } from "../src/db";
import { paths } from "../src/paths";

const version = (db: DatabaseSync) => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
const columns = (db: DatabaseSync, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

/** A database as the current Reflex writes it, with one scan, one skill and one setting, then changed by `edit`. */
function writtenThen(edit: (db: DatabaseSync) => void): void {
  const store = new Store();
  store.saveScan({ startedAt: "2026-10-01T00:00:00Z", days: 7, mode: "local", sources: {}, files: 1, sessions: 0, partial: 0, unreadable: 0, skippedRecords: 0 }, []);
  store.setRetentionDays(90);
  store.close();
  const db = new DatabaseSync(paths.db());
  db.exec("INSERT INTO skills (name, suggestion_slug, path, created_at, content_hash) VALUES ('fix-ci', 'fix-ci', '/s', 't', 'h')");
  edit(db);
  db.close();
}

describe("database upgrades", () => {
  beforeEach(async () => {
    process.env.REFLEX_HOME = await mkdtemp(join(tmpdir(), "reflex-migrate-"));
  });

  it("creates a new database at the current version", () => {
    new Store().close();
    const db = new DatabaseSync(paths.db());
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(columns(db, "scans")).toEqual(expect.arrayContaining(["analysis_key", "analysis_json"]));
    db.close();
  });

  it("upgrades an early 0.5 database that says version 4 but lacks later columns, keeping its data", () => {
    writtenThen((db) => {
      db.exec("ALTER TABLE skills DROP COLUMN baseline_json; ALTER TABLE scans DROP COLUMN analysis_key; ALTER TABLE scans DROP COLUMN analysis_json; PRAGMA user_version = 4");
    });
    const store = new Store();
    try {
      expect(store.latestScan()).toMatchObject({ startedAt: "2026-10-01T00:00:00Z", analysisKey: undefined });
      expect(store.skill("fix-ci")).toMatchObject({ name: "fix-ci", path: "/s" });
      expect(store.retentionDays()).toBe(90);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(paths.db());
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(columns(db, "skills")).toContain("baseline_json");
    expect(columns(db, "scans")).toEqual(expect.arrayContaining(["analysis_key", "analysis_json"]));
    db.close();
  });

  it("upgrades a complete version 4 database without touching its data", () => {
    writtenThen((db) => db.exec("PRAGMA user_version = 4"));
    const store = new Store();
    try {
      expect(store.skill("fix-ci")?.path).toBe("/s");
      expect(store.retentionDays()).toBe(90);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(paths.db());
    expect(version(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("refuses a database a newer Reflex wrote, and leaves it as it was", () => {
    writtenThen((db) => db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`));
    expect(() => new Store()).toThrow(/written by a newer Reflex \(database version \d+, this one knows \d+\)\. Upgrade Reflex .* or run `reflex reset`/);
    const db = new DatabaseSync(paths.db());
    expect(version(db)).toBe(SCHEMA_VERSION + 1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM skills").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
