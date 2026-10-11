import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SourceId, WorkflowTrace } from "@reflex/core";
import type { AnalysisStats, Suggestion, WorkflowCost } from "@reflex/analysis";
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
  /** Key of the saved analysis (see `saveAnalysis`), when one was saved. */
  analysisKey?: string;
  analysis?: SavedAnalysis;
};

/** What `scan` concluded, saved so `suggest` and `stats` need not recompute it. */
export type SavedAnalysis = { stats: AnalysisStats; repositories: number };

export type CachedFile = {
  path: string;
  source: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: string;
  /** Hash of the Reflex build that produced the traces. */
  codeKey: string;
  /** `redactionFingerprint()` when the traces were produced. */
  redactionKey: string;
  skippedRecords: number;
  missing: boolean;
  checkedAt: string;
};

export type CachedTrace = { row: number; trace: WorkflowTrace };

function toCachedFile(r: Record<string, unknown>): CachedFile {
  return {
    path: String(r.path),
    source: String(r.source),
    size: Number(r.size),
    mtimeMs: Number(r.mtime_ms),
    ctimeMs: Number(r.ctime_ms),
    ino: String(r.ino),
    codeKey: String(r.code_key),
    redactionKey: String(r.redaction_key),
    skippedRecords: Number(r.skipped_records),
    missing: Number(r.missing) === 1,
    checkedAt: String(r.checked_at),
  };
}

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

const SCHEMA_VERSION = 4;

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
CREATE TABLE IF NOT EXISTS transcript_files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  ctime_ms REAL NOT NULL,
  ino TEXT NOT NULL,
  code_key TEXT NOT NULL,
  redaction_key TEXT NOT NULL,
  skipped_records INTEGER NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS traces (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  ended_at TEXT,
  context_hash TEXT,
  trace_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_by_path ON traces (path);
CREATE TABLE IF NOT EXISTS scan_sessions (
  scan_id INTEGER NOT NULL,
  trace_row INTEGER NOT NULL
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
    // The old per-scan session copies are derived data; `reflex scan` rebuilds them into the cache.
    if (version < 4) this.db.exec("DROP TABLE IF EXISTS sessions");
    this.db.exec(SCHEMA);
    const skillColumns = this.db.prepare("PRAGMA table_info(skills)").all() as Array<{ name: string }>;
    if (!skillColumns.some((c) => c.name === "baseline_json")) this.db.exec("ALTER TABLE skills ADD COLUMN baseline_json TEXT");
    const scanColumns = this.db.prepare("PRAGMA table_info(scans)").all() as Array<{ name: string }>;
    if (!scanColumns.some((c) => c.name === "analysis_key")) this.db.exec("ALTER TABLE scans ADD COLUMN analysis_key TEXT; ALTER TABLE scans ADD COLUMN analysis_json TEXT");
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  /** Record a scan and make the given cached traces its working set (what suggest, stats and the TUI see). */
  saveScan(scan: Omit<ScanRecord, "id">, traceRows: number[]): number {
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare(
          "INSERT INTO scans (started_at, days, mode, sources_json, files, sessions, partial, unreadable, skipped_records) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(scan.startedAt, scan.days, scan.mode, JSON.stringify(scan.sources), scan.files, scan.sessions, scan.partial, scan.unreadable, scan.skippedRecords);
      const scanId = Number(res.lastInsertRowid);
      this.db.exec("DELETE FROM scan_sessions");
      // Duplicate records (e.g. the same session copied to two places) are kept: de-duplication happens in analysis.
      const insert = this.db.prepare("INSERT INTO scan_sessions (scan_id, trace_row) VALUES (?,?)");
      for (const row of traceRows) insert.run(scanId, row);
      this.db.exec("COMMIT");
      return scanId;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Save the analysis of a scan under a key naming everything it depends on beyond the stored
   * traces (Reflex's build and whether meaning was compared). The suggestions themselves are saved
   * by `saveSuggestions`.
   */
  saveAnalysis(scanId: number, key: string, analysis: SavedAnalysis): void {
    this.db.prepare("UPDATE scans SET analysis_key = ?, analysis_json = ? WHERE id = ?").run(key, JSON.stringify(analysis), scanId);
  }

  /** What the cache knows about a transcript file, if it was read before. */
  cachedFile(path: string): CachedFile | undefined {
    const r = this.db.prepare("SELECT * FROM transcript_files WHERE path = ?").get(path) as Record<string, unknown> | undefined;
    return r && toCachedFile(r);
  }

  /** Cached files of one source, for finding ones that have since been deleted. */
  cachedFiles(source: string): CachedFile[] {
    return (this.db.prepare("SELECT * FROM transcript_files WHERE source = ? ORDER BY path").all(source) as Array<Record<string, unknown>>).map(toCachedFile);
  }

  /** Every trace read from one file, with its row id, oldest first. */
  fileTraces(path: string): CachedTrace[] {
    const rows = this.db.prepare("SELECT row_id, trace_json FROM traces WHERE path = ? ORDER BY row_id").all(path) as Array<{ row_id: number; trace_json: string }>;
    return rows.map((r) => ({ row: Number(r.row_id), trace: parseJson<WorkflowTrace>(r.trace_json, TraceShape, "session") }));
  }

  /** Replace what is cached for one file (its identity and its traces) atomically. */
  saveFile(file: Omit<CachedFile, "missing" | "checkedAt">, traces: WorkflowTrace[]): CachedTrace[] {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM traces WHERE path = ?").run(file.path);
      this.db
        .prepare(
          `INSERT INTO transcript_files (path, source, size, mtime_ms, ctime_ms, ino, code_key, redaction_key, skipped_records, missing, checked_at)
           VALUES (?,?,?,?,?,?,?,?,?,0,?)
           ON CONFLICT(path) DO UPDATE SET source = excluded.source, size = excluded.size, mtime_ms = excluded.mtime_ms, ctime_ms = excluded.ctime_ms,
             ino = excluded.ino, code_key = excluded.code_key, redaction_key = excluded.redaction_key, skipped_records = excluded.skipped_records,
             missing = 0, checked_at = excluded.checked_at`,
        )
        .run(file.path, file.source, file.size, file.mtimeMs, file.ctimeMs, file.ino, file.codeKey, file.redactionKey, file.skippedRecords, new Date().toISOString());
      const insert = this.db.prepare("INSERT INTO traces (path, session_id, source, ended_at, context_hash, trace_json) VALUES (?,?,?,?,?,?)");
      const out = traces.map((t) => ({
        row: Number(insert.run(file.path, t.sessionId, t.source, t.endedAt ?? null, t.contextHash ?? null, JSON.stringify(t)).lastInsertRowid),
        trace: t,
      }));
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * The transcript is gone (deleted by the user or by the agent's own cleanup). Its traces are kept,
   * already redacted, so history outlives the agent's retention; `reflex reset` removes them.
   */
  markMissing(path: string): void {
    this.db.prepare("UPDATE transcript_files SET missing = 1, checked_at = ? WHERE path = ?").run(new Date().toISOString(), path);
  }

  /** Rewrite a kept trace in place (re-redaction after the rules or the user's identity changed). */
  updateKeptTraces(path: string, traces: CachedTrace[], keys: { codeKey: string; redactionKey: string }): void {
    this.db.exec("BEGIN");
    try {
      const update = this.db.prepare("UPDATE traces SET trace_json = ? WHERE row_id = ?");
      for (const t of traces) update.run(JSON.stringify(t.trace), t.row);
      this.db.prepare("UPDATE transcript_files SET code_key = ?, redaction_key = ? WHERE path = ?").run(keys.codeKey, keys.redactionKey, path);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Context hashes of every cached trace: embeddings for anything else can be dropped. */
  contextHashes(): string[] {
    return (this.db.prepare("SELECT DISTINCT context_hash FROM traces WHERE context_hash IS NOT NULL").all() as Array<{ context_hash: string }>).map((r) => r.context_hash);
  }

  /** Keys of every cached embedding, to decide without loading vectors which sessions still need one. */
  embeddingKeys(): Set<string> {
    return new Set((this.db.prepare("SELECT key FROM embeddings").all() as Array<{ key: string }>).map((r) => r.key));
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
      analysisKey: row.analysis_key == null ? undefined : String(row.analysis_key),
      analysis: row.analysis_json == null ? undefined : (JSON.parse(String(row.analysis_json)) as SavedAnalysis),
    };
  }

  /** The latest scan's working set. */
  traces(): WorkflowTrace[] {
    const rows = this.db
      .prepare("SELECT t.trace_json FROM scan_sessions s JOIN traces t ON t.row_id = s.trace_row ORDER BY s.rowid")
      .all() as Array<{ trace_json: string }>;
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
}
