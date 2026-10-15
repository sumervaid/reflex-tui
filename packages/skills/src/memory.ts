import { lstat, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { recurringMemory } from "@reflex/analysis";
import type { WorkflowTrace } from "@reflex/core";
import { displayPath, ensureDir, findLeaks, pathExists, redactWithReport, replaceOwnedFile } from "@reflex/safety";

export type MemoryTargetId = "claude-code" | "codex";

export type MemoryTarget = {
  id: MemoryTargetId;
  label: string;
  /** The agent's global instructions file, read at the start of every session. */
  file: string;
  /** The agent's home directory exists on this machine. */
  detected: boolean;
};

export const MEMORY_START = "<!-- reflex:memory:start -->";
export const MEMORY_END = "<!-- reflex:memory:end -->";

/** Where each agent reads global instructions. Cursor keeps user rules in its app settings, not a file. */
export async function memoryTargets(): Promise<MemoryTarget[]> {
  const claudeHome = join(homedir(), ".claude");
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      file: process.env.REFLEX_CLAUDE_MEMORY_FILE ?? join(claudeHome, "CLAUDE.md"),
      detected: process.env.REFLEX_CLAUDE_MEMORY_FILE ? true : await pathExists(claudeHome),
    },
    {
      id: "codex",
      label: "Codex",
      file: process.env.REFLEX_CODEX_MEMORY_FILE ?? join(codexHome, "AGENTS.md"),
      detected: process.env.REFLEX_CODEX_MEMORY_FILE ? true : await pathExists(codexHome),
    },
  ];
}

/** One rule per line: no line breaks, no markers, nothing that needed redaction. Returns undefined for text that cannot be used. */
export function cleanMemoryText(text: string): string | undefined {
  const plain = text.replace(/[\r\n\t]+/g, " ").replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  // Text that needed redaction held something sensitive; a memory entry is never worth that risk.
  const { text: t, redactions } = redactWithReport(plain);
  if (!t || redactions > 0 || findLeaks(t).length) return undefined;
  return t;
}

/** The block Reflex owns inside an instructions file. */
export function renderMemoryBlock(rules: Array<{ text: string; sessions?: number }>): string {
  const lines = [
    MEMORY_START,
    "## Remembered by Reflex",
    "",
    "Corrections the developer gave coding agents in more than one past session. Follow them unless the current task says otherwise.",
    "Managed by `reflex memory`: edits inside this block are replaced on the next scan.",
    "To see how work is done in the current repository (commands that work, rules the developer gave), run `reflex handbook --json`, or `reflex handbook ask \"<question>\" --json`. Both are read-only.",
    "",
    ...rules.map((r) => `- ${r.text}${r.sessions ? ` (${r.sessions} sessions)` : ""}`),
    MEMORY_END,
  ];
  return lines.join("\n");
}

/** Put `block` into `existing` (replacing Reflex's block if there is one), or remove the block when `block` is null. Text outside the markers is kept exactly. */
export function applyMemoryBlock(existing: string, block: string | null): string {
  const start = existing.indexOf(MEMORY_START);
  const end = start >= 0 ? existing.indexOf(MEMORY_END, start) : -1;
  if (start >= 0 && end >= 0) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MEMORY_END.length);
    if (block) return before + block + after;
    // Drop the blank line Reflex added before its block, and the line break after it.
    return before.replace(/\n\n$/, "\n") + after.replace(/^\n/, "");
  }
  if (!block) return existing;
  if (!existing) return block + "\n";
  return existing.replace(/\n*$/, "\n\n") + block + "\n";
}

export type MemoryWrite = { target: MemoryTarget; path: string; changed: boolean; skipped?: string };

/** Write (or with `block` null, remove) Reflex's memory block in one agent's instructions file. Never follows a symlinked file. */
export async function writeMemory(target: MemoryTarget, block: string | null): Promise<MemoryWrite> {
  const path = target.file;
  const exists = await pathExists(path);
  if (exists && (await lstat(path)).isSymbolicLink()) {
    return { target, path, changed: false, skipped: `${displayPath(path)} is a symlink; Reflex does not write through it` };
  }
  const current = exists ? await readFile(path, "utf8") : "";
  const next = applyMemoryBlock(current, block);
  if (next === current) return { target, path, changed: false };
  if (!exists) await ensureDir(dirname(path), 0o755);
  const mode = exists ? (await stat(path)).mode & 0o777 : 0o644;
  await replaceOwnedFile(path, next, mode);
  return { target, path, changed: true };
}

/** The parts of Reflex's store that memory touches (`Store` in @reflex/storage implements it). */
export type MemoryStore = {
  traces(): WorkflowTrace[];
  syncMinedMemory(rules: Array<{ text: string; sessions: number }>): void;
  memoryEntries(): Array<{ text: string; status: "active" | "forgotten"; sessions: number; origin: "mined" | "added" }>;
  memoryState(): { enabled: boolean };
};

export type MemorySync = { rules: number; writes: MemoryWrite[] };

/**
 * Re-mine memory from the stored sessions and, when memory is on, rewrite every detected agent's
 * block. With memory off, nothing outside Reflex's database is touched.
 */
export async function syncMemory(store: MemoryStore, opts: { mine?: boolean } = {}): Promise<MemorySync> {
  if (opts.mine !== false) store.syncMinedMemory(recurringMemory(store.traces()).map((r) => ({ text: r.text, sessions: r.sessions })));
  const active = store.memoryEntries().filter((e) => e.status === "active");
  if (!store.memoryState().enabled) return { rules: active.length, writes: [] };
  const block = active.length ? renderMemoryBlock(active) : null;
  const writes: MemoryWrite[] = [];
  for (const t of (await memoryTargets()).filter((x) => x.detected)) writes.push(await writeMemory(t, block));
  return { rules: active.length, writes };
}

/** Remove Reflex's block from every agent's instructions file. */
export async function removeMemory(): Promise<MemoryWrite[]> {
  const writes: MemoryWrite[] = [];
  for (const t of await memoryTargets()) if (await pathExists(t.file)) writes.push(await writeMemory(t, null));
  return writes;
}
