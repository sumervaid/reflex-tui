import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SourceId, WorkflowTrace } from "@reflix/core";
import type { Suggestion } from "@reflix/analysis";
import { paths } from "./paths";

export type SuggestionStatus = "pending" | "approved" | "rejected";

export type StoredSuggestion = {
  rank: number;
  slug: string;
  status: SuggestionStatus;
  data: Suggestion;
};

export type ScanRecord = {
  id: number;
  startedAt: string;
  days: number;
  mode: "local" | "demo" | "custom";
  sources: Partial<Record<SourceId, number>>;
  files: number;
  sessions: number;
  partial: number;
  unreadable: number;
  skippedRecords: number;
};

export type SkillRecord = {
  name: string;
  suggestionSlug: string;
  path: string;
  createdAt: string;
  contentHash: string;
};

export type InstallationRecord = {
  skill: string;
  target: string;
  path: string;
  installedAt: string;
  contentHash: string;
};

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  days INTEGER NOT NULL,
  mode TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  files INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  partial INTEGER NOT NULL,
  unreadable INTEGER NOT NULL,
  skipped_records INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  scan_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  started_at TEXT,
  project_name TEXT,
  trace_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  slug TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  rank INTEGER,
  scan_id INTEGER,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  suggestion_slug TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  target TEXT NOT NULL,
  path TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
`;

const TraceShape = z
  .object({ sessionId: z.string(), source: z.enum(["claude-code", "codex"]), actionSequence: z.array(z.string()), intents: z.array(z.string()) })
  .passthrough();
const SuggestionShape = z.object({ slug: z.string(), title: z.string(), steps: z.array(z.unknown()), evidence: z.array(z.unknown()) }).passthrough();

function parseJson<T>(raw: string, shape: z.ZodType, what: string): T {
  const result = shape.safeParse(JSON.parse(raw));
  if (!result.success) throw new Error(`Reflix database has a malformed ${what}. Run \`reflix scan\` again.`);
  return result.data as T;
}

export class Store {
  private db: DatabaseSync;

  constructor(file = paths.db()) {
    const dir = paths.home();
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing to use symlinked Reflix home ${dir}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    // Sessions are derived data and can always be rebuilt by `reflix scan`.
    if (version < SCHEMA_VERSION) this.db.exec("DROP TABLE IF EXISTS sessions");
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  /** Replace the working set of sessions with the result of a new scan. */
  saveScan(scan: Omit<ScanRecord, "id">, traces: WorkflowTrace[]): number {
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare(
          "INSERT INTO scans (started_at, days, mode, sources_json, files, sessions, partial, unreadable, skipped_records) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(scan.startedAt, scan.days, scan.mode, JSON.stringify(scan.sources), scan.files, scan.sessions, scan.partial, scan.unreadable, scan.skippedRecords);
      const scanId = Number(res.lastInsertRowid);
      this.db.exec("DELETE FROM sessions");
      // Duplicate records (e.g. the same session copied to two places) are kept: de-duplication happens in analysis.
      const insert = this.db.prepare("INSERT INTO sessions (id, scan_id, source, started_at, project_name, trace_json) VALUES (?,?,?,?,?,?)");
      for (const t of traces) insert.run(t.sessionId, scanId, t.source, t.startedAt ?? null, t.projectName ?? null, JSON.stringify(t));
      this.db.exec("COMMIT");
      return scanId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  latestScan(): ScanRecord | undefined {
    const row = this.db.prepare("SELECT * FROM scans ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      startedAt: String(row.started_at),
      days: Number(row.days),
      mode: row.mode as ScanRecord["mode"],
      sources: JSON.parse(String(row.sources_json)) as ScanRecord["sources"],
      files: Number(row.files),
      sessions: Number(row.sessions),
      partial: Number(row.partial),
      unreadable: Number(row.unreadable),
      skippedRecords: Number(row.skipped_records),
    };
  }

  traces(): WorkflowTrace[] {
    const rows = this.db.prepare("SELECT trace_json FROM sessions ORDER BY row_id").all() as Array<{ trace_json: string }>;
    return rows.map((r) => parseJson<WorkflowTrace>(r.trace_json, TraceShape, "session"));
  }

  /** Store the current suggestions, keeping any earlier approve/reject decision for the same slug. */
  saveSuggestions(scanId: number, suggestions: Suggestion[]): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE suggestions SET rank = NULL").run();
      const upsert = this.db.prepare(
        `INSERT INTO suggestions (slug, status, rank, scan_id, data_json, updated_at) VALUES (?, 'pending', ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET rank = excluded.rank, scan_id = excluded.scan_id, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      );
      suggestions.forEach((s, i) => upsert.run(s.slug, i + 1, scanId, JSON.stringify(s), now));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Suggestions from the latest analysis, in rank order. */
  suggestions(): StoredSuggestion[] {
    const rows = this.db.prepare("SELECT * FROM suggestions WHERE rank IS NOT NULL ORDER BY rank").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      rank: Number(r.rank),
      slug: String(r.slug),
      status: r.status as SuggestionStatus,
      data: parseJson<Suggestion>(String(r.data_json), SuggestionShape, "suggestion"),
    }));
  }

  /** Look up by rank number ("1", "#1") or slug. */
  findSuggestion(ref: string): StoredSuggestion | undefined {
    const list = this.suggestions();
    const n = Number(ref.replace(/^#/, ""));
    if (Number.isInteger(n) && n > 0) return list.find((s) => s.rank === n);
    return list.find((s) => s.slug === ref);
  }

  setStatus(slug: string, status: SuggestionStatus): void {
    this.db.prepare("UPDATE suggestions SET status = ?, updated_at = ? WHERE slug = ?").run(status, new Date().toISOString(), slug);
  }

  statusCounts(): Record<SuggestionStatus, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM suggestions GROUP BY status").all() as Array<{ status: SuggestionStatus; n: number }>;
    const out: Record<SuggestionStatus, number> = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  saveSkill(skill: SkillRecord): void {
    this.db
      .prepare(
        `INSERT INTO skills (name, suggestion_slug, path, created_at, content_hash) VALUES (?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET suggestion_slug = excluded.suggestion_slug, path = excluded.path, created_at = excluded.created_at, content_hash = excluded.content_hash`,
      )
      .run(skill.name, skill.suggestionSlug, skill.path, skill.createdAt, skill.contentHash);
  }

  skills(): SkillRecord[] {
    const rows = this.db.prepare("SELECT * FROM skills ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: String(r.name),
      suggestionSlug: String(r.suggestion_slug),
      path: String(r.path),
      createdAt: String(r.created_at),
      contentHash: String(r.content_hash),
    }));
  }

  skill(name: string): SkillRecord | undefined {
    return this.skills().find((s) => s.name === name);
  }

  saveInstallation(inst: InstallationRecord): void {
    this.db
      .prepare("INSERT INTO installations (skill, target, path, installed_at, content_hash) VALUES (?,?,?,?,?)")
      .run(inst.skill, inst.target, inst.path, inst.installedAt, inst.contentHash);
  }

  installations(skill?: string): InstallationRecord[] {
    const rows = (
      skill
        ? this.db.prepare("SELECT * FROM installations WHERE skill = ? ORDER BY id").all(skill)
        : this.db.prepare("SELECT * FROM installations ORDER BY id").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      skill: String(r.skill),
      target: String(r.target),
      path: String(r.path),
      installedAt: String(r.installed_at),
      contentHash: String(r.content_hash),
    }));
  }
}
