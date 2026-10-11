import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { NormalizedSession, SessionEvent, SourceId, TranscriptFile } from "@reflex/core";
import { shortHash } from "@reflex/core";
import { displayPath, redact } from "@reflex/safety";

export const MAX_EVENTS_PER_SESSION = 3000;
export const MAX_REQUESTS_PER_SESSION = 40;
const MAX_REQUEST_CHARS = 2000;
const MAX_COMMAND_CHARS = 600;
const MAX_ASSISTANT_CHARS = 400;

export const clean = {
  request: (text: string) => redact(text.slice(0, MAX_REQUEST_CHARS)).trim(),
  command: (text: string) => redact(text.slice(0, MAX_COMMAND_CHARS)).trim(),
  assistant: (text: string) => redact(text.slice(0, MAX_ASSISTANT_CHARS)).trim(),
  path: (text: string) => redact(text.slice(0, 400)),
};

/** Text injected by the harness rather than typed by the developer. */
export function isHarnessText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-") ||
    t.startsWith("<local-command") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("<user_instructions>") ||
    t.startsWith("<environment_context>") ||
    t.startsWith("Caveat:") ||
    t.startsWith("[Request interrupted")
  );
}

export function stripHarnessBlocks(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** Files touched by an apply_patch-style patch (`*** Update File: <path>`). */
export function patchedFiles(patch: string): Array<{ op: "edit" | "write"; path: string }> {
  const out: Array<{ op: "edit" | "write"; path: string }> = [];
  for (const m of patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)) {
    out.push({ op: m[1] === "Add" ? "write" : "edit", path: m[2]!.trim() });
  }
  return out.slice(0, 50);
}

/** Files directly at `dir/**depth**` matching `ext`. Never follows symlinks, never recurses deeper. */
export async function listFiles(dir: string, ext: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, level: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (level < depth) {
        if (entry.isDirectory()) await walk(full, level + 1);
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        out.push(full);
      }
    }
  }
  await walk(dir, 0);
  return out.sort();
}

export async function toTranscriptFiles(paths: string[], cutoff: Date): Promise<TranscriptFile[]> {
  const files: TranscriptFile[] = [];
  for (const path of paths) {
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.mtime < cutoff) continue;
      files.push({ path, displayPath: displayPath(path), modifiedAt: st.mtime, sizeBytes: st.size });
    } catch {
      continue;
    }
  }
  return files;
}

export function cutoffFor(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isDirectory() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Mutable builder used while streaming one session. */
export class SessionBuilder {
  requests: NormalizedSession["requests"] = [];
  events: SessionEvent[] = [];
  skipped = 0;
  startedAt?: string;
  endedAt?: string;
  cwd?: string;
  private pendingTools = new Map<string, SessionEvent>();

  constructor(
    readonly source: SourceId,
    public nativeId: string,
    readonly file: TranscriptFile,
  ) {}

  touch(at?: string): void {
    const t = at ? Date.parse(at) : NaN;
    if (Number.isNaN(t)) return;
    const iso = new Date(t).toISOString();
    if (!this.startedAt || iso < this.startedAt) this.startedAt = iso;
    if (!this.endedAt || iso > this.endedAt) this.endedAt = iso;
  }

  addRequest(text: string, at?: string): void {
    const cleaned = clean.request(stripHarnessBlocks(text));
    if (!cleaned || isHarnessText(cleaned)) return;
    if (this.requests.length < MAX_REQUESTS_PER_SESSION) this.requests.push({ at, text: cleaned });
    this.push({ kind: "user", at, text: cleaned });
  }

  push(event: SessionEvent, toolId?: string): void {
    if (this.events.length >= MAX_EVENTS_PER_SESSION) return;
    this.events.push(event);
    if (toolId) this.pendingTools.set(toolId, event);
  }

  markResult(toolId: string, isError: boolean): void {
    const ev = this.pendingTools.get(toolId);
    if (ev && (ev.kind === "shell" || ev.kind === "file" || ev.kind === "tool")) ev.isError = isError;
    this.pendingTools.delete(toolId);
  }

  build(): NormalizedSession {
    const project = this.cwd
      ? { name: clean.path(basename(this.cwd)) || undefined, pathHash: shortHash(this.cwd) }
      : undefined;
    return {
      id: `${this.source}:${this.nativeId}`,
      source: this.source,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      project,
      requests: this.requests,
      events: this.events,
      sourceRef: { file: this.file.displayPath, nativeId: this.nativeId },
      skippedRecords: this.skipped,
    };
  }
}
