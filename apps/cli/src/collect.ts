import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceId, TranscriptAdapter, TranscriptFile, WorkflowTrace } from "@reflex/core";
import { sha256 } from "@reflex/core";
import { buildTrace, sessionContext } from "@reflex/analysis";
import { redactDeep, redactionFingerprint } from "@reflex/safety";
import type { CachedFile, CachedTrace, Store } from "@reflex/storage";

/** Bounds the clustering step on very large histories (and, without the cache, parse time). */
export const MAX_FILES_PER_SOURCE = 2000;

/** Files are parsed without a window and the window is applied to their traces, so one cached read serves any --days. */
const ALL_HISTORY_DAYS = 100 * 365;

export type CacheKeys = {
  /** Hash of the Reflex build: any change to parsing or tracing makes cached traces stale. */
  codeKey: string;
  redactionKey: string;
};

/** Keys for this process: the running bundle's own bytes, and the user identity redaction depends on. */
export function currentKeys(): CacheKeys {
  let codeKey = "unknown";
  try {
    codeKey = sha256(readFileSync(fileURLToPath(import.meta.url)).toString("base64")).slice(0, 16);
  } catch {
    // Unreadable build: "unknown" still invalidates nothing wrongly, it just never matches a real key.
  }
  return { codeKey, redactionKey: redactionFingerprint() };
}

export type CollectOptions = {
  days: number;
  now: Date;
  /** Ignore the cache and read every file again (`scan --full`). */
  full?: boolean;
  keys: CacheKeys;
  /** A cached trace that still needs its context document (for an embedding) forces a re-read of its file. */
  needsDocument?: (t: WorkflowTrace) => boolean;
  onSource?: (adapter: TranscriptAdapter, files: number) => void;
};

export type Collected = {
  /** Cached trace rows that make up the scan's working set, in scan order. */
  rows: number[];
  traces: WorkflowTrace[];
  /** Context documents of sessions read in this scan, by session id. Never stored. */
  documents: Map<string, string>;
  perSource: Partial<Record<SourceId, number>>;
  files: number;
  read: number;
  reused: number;
  /** Sessions included from transcripts that no longer exist. */
  kept: number;
  partial: number;
  unreadable: number;
  skippedRecords: number;
  capped: number;
};

function unchanged(c: CachedFile | undefined, f: TranscriptFile, keys: CacheKeys): c is CachedFile {
  const id = f.identity;
  return (
    !!c &&
    !!id &&
    !c.missing &&
    c.size === f.sizeBytes &&
    c.mtimeMs === id.mtimeMs &&
    c.ctimeMs === id.ctimeMs &&
    c.ino === id.ino &&
    c.codeKey === keys.codeKey &&
    c.redactionKey === keys.redactionKey
  );
}

async function exists(path: string): Promise<boolean | undefined> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
  }
}

/**
 * Gather the traces for a scan window, reading only what changed since the last scan.
 *
 * - Unchanged files (same size, mtime, ctime, inode, build and redaction identity) reuse their
 *   cached traces without being opened.
 * - New or changed files are parsed one at a time; each session becomes a trace right away and only
 *   the trace and its context document are kept, so memory does not grow with transcript size.
 * - Files that disappeared keep their (already redacted) traces, re-redacted if the rules or the
 *   user identity changed; they count when they fall inside the window.
 */
export async function collect(adapters: TranscriptAdapter[], store: Store, opts: CollectOptions): Promise<Collected> {
  // Same cutoff the adapters compute (common.ts cutoffFor).
  const cutoff = new Date(opts.now.getTime() - opts.days * 24 * 60 * 60 * 1000).toISOString();
  const result: Collected = {
    rows: [],
    traces: [],
    documents: new Map(),
    perSource: {},
    files: 0,
    read: 0,
    reused: 0,
    kept: 0,
    partial: 0,
    unreadable: 0,
    skippedRecords: 0,
    capped: 0,
  };
  const take = (source: SourceId, cached: CachedTrace[], include: (t: WorkflowTrace) => boolean): number => {
    let n = 0;
    for (const c of cached) {
      if (!include(c.trace)) continue;
      result.rows.push(c.row);
      result.traces.push(c.trace);
      n++;
    }
    result.perSource[source] = (result.perSource[source] ?? 0) + n;
    return n;
  };
  // Same rule the adapters apply after parsing.
  const inWindow = (t: WorkflowTrace) => !t.endedAt || t.endedAt >= cutoff;
  // A kept trace has no file mtime to vouch for it, so it needs its own date inside the window.
  const keptInWindow = (t: WorkflowTrace) => (t.endedAt ?? t.startedAt ?? "") >= cutoff;

  for (const a of adapters) {
    // Recorded even when no file is in the window: the scan record lists every source the user let Reflex read.
    result.perSource[a.id] = 0;
    const all = await a.discover({ days: opts.days, now: opts.now });
    const list = all.sort((x, y) => y.modifiedAt.getTime() - x.modifiedAt.getTime()).slice(0, MAX_FILES_PER_SOURCE);
    result.capped += all.length - list.length;
    opts.onSource?.(a, list.length);

    for (const file of list) {
      result.files++;
      const cached = store.cachedFile(file.path);
      if (!opts.full && unchanged(cached, file, opts.keys)) {
        const traces = store.fileTraces(file.path);
        const stale = (t: WorkflowTrace) => opts.needsDocument?.(t) || a.needsReread?.(t);
        if (!traces.some((t) => inWindow(t.trace) && stale(t.trace))) {
          result.reused++;
          result.skippedRecords += cached.skippedRecords;
          const n = take(a.id, traces, inWindow);
          if (cached.skippedRecords > 0) result.partial += n;
          continue;
        }
      }
      const parsed = await a.parse(file, { days: ALL_HISTORY_DAYS, now: opts.now });
      if (parsed.unreadable) {
        result.unreadable++;
        continue;
      }
      result.read++;
      result.skippedRecords += parsed.skippedRecords;
      const traces = parsed.sessions.map(buildTrace);
      parsed.sessions.forEach((s, i) => result.documents.set(traces[i]!.sessionId, sessionContext(s, traces[i]!)));
      const saved = store.saveFile(
        {
          path: file.path,
          source: a.id,
          size: file.sizeBytes,
          mtimeMs: file.identity?.mtimeMs ?? file.modifiedAt.getTime(),
          ctimeMs: file.identity?.ctimeMs ?? -1,
          ino: file.identity?.ino ?? "",
          codeKey: opts.keys.codeKey,
          redactionKey: opts.keys.redactionKey,
          skippedRecords: parsed.skippedRecords,
        },
        traces,
      );
      const n = take(a.id, saved, inWindow);
      if (parsed.skippedRecords > 0) result.partial += n;
    }

    // Transcripts read before and gone now. Only under this adapter's folder, so a custom-folder
    // scan never pulls in sessions from somewhere the user did not point it at.
    if (!a.root) continue;
    const root = a.root.endsWith(sep) ? a.root : a.root + sep;
    const listed = new Set(all.map((f) => f.path));
    for (const c of store.cachedFiles(a.id)) {
      if (!c.path.startsWith(root) || listed.has(c.path)) continue;
      // Still on disk means older than the window (or past the file cap): not part of this scan.
      if (!c.missing && (await exists(c.path)) !== false) continue;
      if (!c.missing) store.markMissing(c.path);
      let traces = store.fileTraces(c.path);
      if (c.codeKey !== opts.keys.codeKey || c.redactionKey !== opts.keys.redactionKey) {
        // The source cannot be re-read, so apply the current redaction to what was kept.
        traces = traces.map((t) => ({ row: t.row, trace: redactDeep(t.trace) }));
        store.updateKeptTraces(c.path, traces, opts.keys);
      }
      result.kept += take(a.id, traces, keptInWindow);
    }
  }
  return result;
}
