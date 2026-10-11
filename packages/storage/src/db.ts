import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SourceId, WorkflowTrace } from "@reflex/core";
import type { Suggestion, WorkflowCost } from "@reflex/analysis";
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
  mode: "local" | "custom";
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
  /** The workflow's cost when the skill was approved, the "before" side of `reflex impact`. */
  baseline?: WorkflowCost;
};

export type InstallationRecord = {
  skill: string;
  target: string;
  path: string;
  installedAt: string;
  contentHash: string;
};

export type MemoryEntry = {
  text: string;
  /** Mined from recurring corrections, or added by the user. */
  origin: "mined" | "added";
  /** Forgotten entries stay so a later scan does not bring them back. */
  status: "active" | "forgotten";
  /** Independent sessions behind a mined entry. */
  sessions: number;
  updatedAt: string;
};

export type MemoryState = { enabled: boolean };

const SCHEMA_VERSION = 3;

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
  content_hash TEXT NOT NULL,
  baseline_json TEXT
);
CREATE TABLE IF NOT EXISTS embeddings (
  key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  vector BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_entries (
  text TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('mined','added')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','forgotten')),
  sessions INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  .object({ sessionId: z.string(), source: z.enum(["claude-code", "codex", "cursor"]), actionSequence: z.array(z.string()), intents: z.array(z.string()) })
  .passthrough();
const BaselineShape = z.object({ runs: z.number(), runsWithTokens: z.number() }).passthrough();
const SuggestionShape = z.object({ slug: z.string(), title: z.string(), steps: z.array(z.unknown()), evidence: z.array(z.unknown()) }).passthrough();

function parseJson<T>(raw: string, shape: z.ZodType, what: string): T {
  const result = shape.safeParse(JSON.parse(raw));
  if (!result.success) throw new Error(`Reflex database has a malformed ${what}. Run \`reflex scan\` again.`);
  return result.data as T;
}

export class Store {
  private db: DatabaseSync;

  constructor(file = paths.db()) {
    const dir = paths.home();
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing to use symlinked Reflex home ${dir}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    const version = Number((this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    // Sessions are derived data and can always be rebuilt by `reflex scan`.
    if (version < 1) this.db.exec("DROP TABLE IF EXISTS sessions");
    this.db.exec(SCHEMA);
    const skillColumns = this.db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
    if (!skillColumns.some((c) => c.name === "baseline_json")) this.db.exec("ALTER TABLE skills ADD COLUMN baseline_json TEXT");
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
        `INSERT INTO skills (name, suggestion_slug, path, created_at, content_hash, baseline_json) VALUES (?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET suggestion_slug = excluded.suggestion_slug, path = excluded.path, created_at = excluded.created_at,
           content_hash = excluded.content_hash, baseline_json = COALESCE(skills.baseline_json, excluded.baseline_json)`,
      )
      .run(skill.name, skill.suggestionSlug, skill.path, skill.createdAt, skill.contentHash, skill.baseline ? JSON.stringify(skill.baseline) : null);
  }

  skills(): SkillRecord[] {
    const rows = this.db.prepare("SELECT * FROM skills ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: String(r.name),
      suggestionSlug: String(r.suggestion_slug),
      path: String(r.path),
      createdAt: String(r.created_at),
      contentHash: String(r.content_hash),
      baseline: r.baseline_json ? parseJson<WorkflowCost>(String(r.baseline_json), BaselineShape, "skill baseline") : undefined,
    }));
  }

  /** A suggestion by slug, including ones the latest scan no longer found. */
  suggestionBySlug(slug: string): Suggestion | undefined {
    const row = this.db.prepare("SELECT data_json FROM suggestions WHERE slug = ?").get(slug) as { data_json: string } | undefined;
    return row ? parseJson<Suggestion>(row.data_json, SuggestionShape, "suggestion") : undefined;
  }

  skill(name: string): SkillRecord | undefined {
    return this.skills().find((s) => s.name === name);
  }

  saveInstallation(inst: InstallationRecord): void {
    this.db
      .prepare("INSERT INTO installations (skill, target, path, installed_at, content_hash) VALUES (?,?,?,?,?)")
      .run(inst.skill, inst.target, inst.path, inst.installedAt, inst.contentHash);
  }

  /** Forget installations of `skill` into `target`; with `path`, only the one at that path. */
  removeInstallation(skill: string, target: string, path?: string): void {
    if (path === undefined) this.db.prepare("DELETE FROM installations WHERE skill = ? AND target = ?").run(skill, target);
    else this.db.prepare("DELETE FROM installations WHERE skill = ? AND target = ? AND path = ?").run(skill, target, path);
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

  /** Cached sentence vectors by content key (model + context document hash). */
  embeddings(keys: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const get = this.db.prepare("SELECT vector FROM embeddings WHERE key = ?");
    for (const key of keys) {
      const row = get.get(key) as { vector: Uint8Array } | undefined;
      if (row && row.vector.byteLength % 4 === 0) out.set(key, new Float32Array(new Uint8Array(row.vector).buffer));
    }
    return out;
  }

  saveEmbeddings(model: string, entries: Iterable<[string, Float32Array]>): void {
    const put = this.db.prepare("INSERT OR REPLACE INTO embeddings (key, model, vector) VALUES (?,?,?)");
    this.db.exec("BEGIN");
    try {
      for (const [key, v] of entries) put.run(key, model, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Drop cached vectors for sessions that are no longer in the working set. */
  pruneEmbeddings(keep: string[]): void {
    this.db.prepare("DELETE FROM embeddings WHERE key NOT IN (SELECT value FROM json_each(?))").run(JSON.stringify(keep));
  }

  /** Replace the mined memory with the latest result. User decisions (forgotten, added) are kept. */
  syncMinedMemory(rules: Array<{ text: string; sessions: number }>): void {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      const keep = new Set(rules.map((r) => r.text));
      for (const row of this.db.prepare("SELECT text FROM memory_entries WHERE origin = 'mined' AND status = 'active'").all() as Array<{ text: string }>) {
        if (!keep.has(row.text)) this.db.prepare("DELETE FROM memory_entries WHERE text = ?").run(row.text);
      }
      const upsert = this.db.prepare(
        `INSERT INTO memory_entries (text, origin, status, sessions, updated_at) VALUES (?, 'mined', 'active', ?, ?)
         ON CONFLICT(text) DO UPDATE SET sessions = excluded.sessions, updated_at = excluded.updated_at`,
      );
      for (const r of rules) upsert.run(r.text, r.sessions, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Every memory entry: active first, most-supported first. */
  memoryEntries(): MemoryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_entries ORDER BY status = 'forgotten', origin = 'mined', sessions DESC, text")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      text: String(r.text),
      origin: r.origin as MemoryEntry["origin"],
      status: r.status as MemoryEntry["status"],
      sessions: Number(r.sessions),
      updatedAt: String(r.updated_at),
    }));
  }

  addMemory(text: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_entries (text, origin, status, sessions, updated_at) VALUES (?, 'added', 'active', 0, ?)
         ON CONFLICT(text) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
      )
      .run(text, new Date().toISOString());
  }

  setMemoryStatus(text: string, status: MemoryEntry["status"]): void {
    this.db.prepare("UPDATE memory_entries SET status = ?, updated_at = ? WHERE text = ?").run(status, new Date().toISOString(), text);
  }

  /** Remove an entry entirely (user-added entries; mined ones are forgotten instead). */
  deleteMemory(text: string): void {
    this.db.prepare("DELETE FROM memory_entries WHERE text = ?").run(text);
  }

  memoryState(): MemoryState {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'memory'").get() as { value: string } | undefined;
    try {
      return { enabled: row ? Boolean((JSON.parse(row.value) as MemoryState).enabled) : false };
    } catch {
      return { enabled: false };
    }
  }

  setMemoryState(state: MemoryState): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('memory', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(state));
  }
}
