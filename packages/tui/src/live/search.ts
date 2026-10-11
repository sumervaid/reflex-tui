import { closeSync, constants, existsSync, lstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { ClaudeCodeAdapter, CursorAdapter, decodeWorkspace } from "@reflex/adapters";
import type { SourceId } from "@reflex/core";
import type { SearchIndex, SessionContext, Turn } from "../model";
import { toCells } from "../render/text";
import type { ActionResult, ResumeCommand, ToolFilter } from "../types";
import type { Priced } from "./costs";
import { dayLabel } from "./labels";

/** Native session ids are passed to another CLI as one argument, so they must look like ids. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** How much of a Claude transcript is read to find the folder the session ran in. */
const MAX_CWD_SCAN_BYTES = 256 * 1024;

type Entry = Turn & { at: number; lower: string };
type SessionRef = { source: SourceId; nativeId: string };

export type LiveSearch = { index: SearchIndex; sessions: Map<string, SessionRef> };

/**
 * Search over what Reflex stored for each scanned session: the redacted opening request ("you",
 * turn 1) and the normalized steps the agent took ("ai", turns 2..). Raw transcripts are not stored,
 * so later prompts and replies are not searchable. Sessions are keyed by the first 8 characters of
 * their native id, or the whole id when two share a prefix.
 */
export function buildSearch(priced: Priced[]): LiveSearch {
  const sessions = new Map<string, SessionRef>();
  const bySession = new Map<string, Entry[]>();
  const meta = new Map<string, Omit<SessionContext, "turns">>();
  const all: Entry[] = [];
  for (const { t, at, tool, cost } of priced) {
    const nativeId = t.sessionId.slice(t.source.length + 1);
    const key = sessions.has(nativeId.slice(0, 8)) ? nativeId : nativeId.slice(0, 8);
    sessions.set(key, { source: t.source, nativeId });
    meta.set(key, { usd: cost?.usd, turnCount: t.requests });
    const base = { date: at ? dayLabel(new Date(at)) : "—", tool, project: toCells(t.projectName ?? "—"), session: toCells(key), at };
    const texts: Array<[Turn["role"], string]> = [["you", t.excerpt], ...t.displaySteps.map((s): [Turn["role"], string] => ["ai", s])];
    const entries: Entry[] = [];
    texts.forEach(([role, raw], i) => {
      const text = toCells(raw).trim();
      if (text) entries.push({ ...base, turn: i + 1, role, text, lower: text.toLowerCase() });
    });
    bySession.set(key, entries);
    all.push(...entries);
  }
  all.sort((a, b) => b.at - a.at || b.turn - a.turn);
  const index: SearchIndex = {
    indexed: all.length,
    query(q: string, tool: ToolFilter): Turn[] {
      const needle = q.toLowerCase();
      return all.filter((e) => (tool === "all" || e.tool === tool) && (!needle || e.lower.includes(needle)));
    },
    session(id: string): SessionContext {
      return { turns: bySession.get(id) ?? [], ...meta.get(id) };
    },
  };
  return { index, sessions };
}

/** The folder a Claude Code session ran in, from its own transcript. Claude resumes sessions per folder. */
function claudeCwd(nativeId: string): string | undefined {
  const root = new ClaudeCodeAdapter().root;
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const file = join(root, dir, `${nativeId}.jsonl`);
    try {
      if (!lstatSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = Buffer.alloc(MAX_CWD_SCAN_BYTES);
    let n: number;
    try {
      n = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && statSync(cwd).isDirectory()) return cwd;
      } catch {
        continue;
      }
    }
    return undefined;
  }
  return undefined;
}

/** The workspace folder a Cursor chat belongs to: its transcript sits under the encoded folder name. */
function cursorWorkspace(nativeId: string): string | undefined {
  const root = new CursorAdapter().root;
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  const dir = dirs.find((d) => existsSync(join(root, d, "agent-transcripts", nativeId)));
  return dir ? decodeWorkspace(dir) : undefined;
}

const onPath = (cmd: string): boolean => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, cmd)));

/** How to reopen a search hit in the tool that recorded it, or why that is not possible. */
export function resumeCommand(ref: SessionRef | undefined): ResumeCommand | ActionResult {
  if (!ref || !SESSION_ID.test(ref.nativeId)) return { ok: false, message: "this session cannot be resumed", tone: "dim" };
  const id = ref.nativeId;
  if (ref.source === "codex") return { cmd: "codex", args: ["resume", id] };
  if (ref.source === "claude-code") {
    const cwd = claudeCwd(id);
    if (cwd) return { cmd: "claude", args: ["--resume", id], cwd };
    return { ok: false, message: `run \`claude --resume ${toCells(id)}\` in the session's project folder`, tone: "dim" };
  }
  // Cursor's editor chats cannot be reopened from a terminal, so open the workspace they belong to.
  const dir = cursorWorkspace(id);
  if (!dir) return { ok: false, message: "this Cursor chat has no workspace folder on this machine", tone: "dim" };
  const done = `opened ${toCells(basename(dir))} in Cursor · the chat is in its agent history`;
  if (onPath("cursor")) return { cmd: "cursor", args: [dir], done };
  if (process.platform === "darwin") return { cmd: "open", args: ["-a", "Cursor", dir], done };
  return { ok: false, message: `open ${toCells(dir)} in Cursor; the chat is in its agent history`, tone: "dim" };
}
