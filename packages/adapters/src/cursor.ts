import { existsSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { DetectionResult, DiscoveryOptions, ParseResult, SessionEvent, SpawnedAgent, TranscriptAdapter, TranscriptFile, WorkflowTrace } from "@reflex/core";
import { debug } from "@reflex/core";
import { displayPath, excerpt } from "@reflex/safety";
import { CursorModelIndex, defaultCursorStateDb } from "./cursor-models";
import { readJsonl } from "./jsonl";
import { MAX_EVENTS_PER_SESSION, SessionBuilder, clean, cutoffFor, isDirectory, listFiles, modelName, patchedFiles, toTranscriptFiles } from "./common";

/**
 * Cursor agent transcripts: `<root>/<encoded-workspace>/agent-transcripts/<id>/<id>.jsonl`, one
 * `{ role, message: { content: [text | tool_use] } }` record per line plus `{ type: "turn_ended" }`
 * markers. There are no per-record timestamps, working directory or tool results; time comes from
 * the `<timestamp>` tag Cursor adds to user messages, falling back to the file's mtime.
 */
const Block = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    name: z.string().optional(),
    input: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  })
  .passthrough();

const CursorRecord = z
  .object({
    role: z.string().optional(),
    type: z.string().optional(),
    message: z.object({ content: z.union([z.string(), z.array(z.unknown())]).optional() }).passthrough().optional(),
  })
  .passthrough();

const FILE_TOOLS: Record<string, "read" | "write" | "edit"> = {
  Read: "read",
  ReadFile: "read",
  Write: "write",
  StrReplace: "edit",
  EditNotebook: "edit",
};

/** Cursor tool names mapped onto the names the analysis already understands. */
const TOOL_ALIASES: Record<string, string> = { rg: "Grep", SemanticSearch: "Grep", codebase_search: "Grep" };

const SHELL_TOOLS = new Set(["Shell", "run_terminal_cmd"]);
/** Tools a Cursor agent uses to launch another agent. */
const SPAWN_TOOLS = new Set(["Task", "Subagent"]);
const AGENT_TYPE = /^[A-Za-z0-9_-]{1,40}$/;
/** Agent transcripts read per chat (one real chat launched 126). */
const MAX_AGENT_TRANSCRIPTS = 300;

/** A chat's agent transcripts: `<id>/subagents/*.jsonl`, regular files only. */
async function agentTranscripts(chatFile: string): Promise<string[]> {
  return listFiles(join(dirname(chatFile), "subagents"), ".jsonl", 0);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** "Sunday, Oct 11, 2026, 12:56 PM (UTC-7)" -> ISO string. */
export function parseCursorTimestamp(text: string): string | undefined {
  const m = text.trim().match(/^(?:[A-Za-z]+,\s*)?(.+?)\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)$/);
  if (!m) return undefined;
  const hours = Number(m[2]);
  const offset = `${hours < 0 ? "-" : "+"}${String(Math.abs(hours)).padStart(2, "0")}${m[3] ?? "00"}`;
  const t = Date.parse(`${m[1]!.replace(/,(?=\s*\d{1,2}:)/, "")} GMT${offset}`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Cursor encodes the workspace path by replacing `/` with `-`, which is ambiguous for names that
 * contain hyphens. Resolve it by checking which candidate directories exist (metadata only).
 */
export function decodeWorkspace(encoded: string, root = "/"): string | undefined {
  const tokens = encoded.split("-").filter(Boolean);
  if (!tokens.length || /^\d+$/.test(encoded)) return undefined;
  let budget = 200;
  const walk = (dir: string, i: number): string | undefined => {
    if (i === tokens.length) return dir;
    for (let j = tokens.length; j > i && budget > 0; j--) {
      budget--;
      const candidate = join(dir, tokens.slice(i, j).join("-"));
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          const found = walk(candidate, j);
          if (found) return found;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  };
  return walk(root, 0);
}

export class CursorAdapter implements TranscriptAdapter {
  readonly id = "cursor" as const;
  readonly label = "Cursor";
  readonly root: string;
  /** Cursor's app database, for model names. Undefined for a custom transcript folder, which reads only that folder. */
  readonly stateDb?: string;
  private models?: CursorModelIndex;

  constructor(root?: string, stateDb?: string) {
    this.root = root ?? process.env.REFLEX_CURSOR_DIR ?? join(homedir(), ".cursor", "projects");
    const custom = root ?? process.env.REFLEX_CURSOR_DIR;
    this.stateDb = stateDb ?? process.env.REFLEX_CURSOR_STATE_DB ?? (custom ? undefined : defaultCursorStateDb());
  }

  /** Whether the user allowed reading model names from Cursor's app database in this scan. */
  get readsModels(): boolean {
    return this.models !== undefined;
  }

  private async transcriptPaths(): Promise<string[]> {
    let workspaces;
    try {
      workspaces = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const w of workspaces) {
      if (!w.isDirectory()) continue;
      // <id>/<id>.jsonl only; subagent transcripts live one level deeper and are skipped.
      const files = await listFiles(join(this.root, w.name, "agent-transcripts"), ".jsonl", 1);
      out.push(...files.filter((p) => basename(p, ".jsonl") === basename(join(p, ".."))));
    }
    return out.sort();
  }

  async detect(): Promise<DetectionResult> {
    const location = displayPath(this.root);
    if (!(await isDirectory(this.root))) return { found: false, location };
    const files = await this.transcriptPaths();
    debug("adapter detected", { adapter: this.id, files: files.length });
    return { found: files.length > 0, location, candidateFiles: files.length };
  }

  async requestPermission(ask: (message: string) => Promise<boolean>, days: number): Promise<boolean> {
    if (!(await ask(`Read Cursor agent sessions from the last ${days} day${days === 1 ? "" : "s"} at ${displayPath(this.root)}?`))) return false;
    if (this.stateDb && (await isFile(this.stateDb))) {
      const allowed = await ask(
        `Also read which model each Cursor chat used, from Cursor's app database at ${displayPath(this.stateDb)}? Read-only; only model names are extracted, never messages.`,
      );
      if (allowed) this.models = new CursorModelIndex(this.stateDb);
    }
    return true;
  }

  needsReread(trace: WorkflowTrace): boolean {
    return this.readsModels && trace.source === "cursor" && trace.models === undefined;
  }

  /**
   * A chat's identity includes its agent transcripts (`<id>/subagents/*.jsonl`): background agents
   * keep writing after the chat file stops, so a change there must count as a change to the chat.
   */
  async discover(options: DiscoveryOptions): Promise<TranscriptFile[]> {
    const files = await toTranscriptFiles(await this.transcriptPaths(), new Date(0));
    const cutoff = cutoffFor(options.days, options.now);
    const out: TranscriptFile[] = [];
    for (const f of files) {
      for (const agent of await toTranscriptFiles(await agentTranscripts(f.path), new Date(0))) {
        f.sizeBytes += agent.sizeBytes;
        if (agent.modifiedAt > f.modifiedAt) f.modifiedAt = agent.modifiedAt;
        if (f.identity && agent.identity) {
          f.identity.mtimeMs = Math.max(f.identity.mtimeMs, agent.identity.mtimeMs);
          f.identity.ctimeMs = Math.max(f.identity.ctimeMs, agent.identity.ctimeMs);
        }
      }
      if (f.modifiedAt >= cutoff) out.push(f);
    }
    return out;
  }

  async parse(file: TranscriptFile, options: DiscoveryOptions): Promise<ParseResult> {
    const cutoff = cutoffFor(options.days, options.now).toISOString();
    const b = new SessionBuilder(this.id, basename(file.path, ".jsonl").slice(0, 80), file);
    const workspaceDir = basename(join(file.path, "..", "..", ".."));
    b.cwd = decodeWorkspace(workspaceDir);
    const counts = { total: 0, skipped: 0 };
    const spawned: SpawnedAgent[] = [];
    let at: string | undefined;
    let firstSpawn: number | undefined;

    try {
      await this.readBlocks(file.path, b, counts, (role, blk) => {
        if (role === "user") {
          if (blk.type === "text" && blk.text) at = this.addUserText(b, blk.text) ?? at;
        } else if (blk.type === "text" && blk.text) {
          b.push({ kind: "assistant", at, text: clean.assistant(blk.text) });
        } else if (blk.type === "tool_use" && blk.name) {
          this.pushTool(b, blk.name, blk.input ?? {}, at, spawned);
          if (SPAWN_TOOLS.has(blk.name) && firstSpawn === undefined) firstSpawn = b.events.length;
        }
      });
    } catch (err) {
      debug("file unreadable", { adapter: this.id, code: (err as NodeJS.ErrnoException).code });
      return { sessions: [], skippedRecords: counts.skipped, totalRecords: counts.total, unreadable: true, error: "unreadable" };
    }

    // Agents' work joins the chat where the first agent was launched. Their opening message was
    // written by the parent agent, not the developer, so it is never read as a request.
    const delegated: SessionEvent[] = [];
    let transcripts = 0;
    for (const path of (await agentTranscripts(file.path)).slice(0, MAX_AGENT_TRANSCRIPTS)) {
      const child = new SessionBuilder(this.id, b.nativeId, file);
      try {
        await this.readBlocks(path, child, counts, (role, blk) => {
          if (role === "assistant" && blk.type === "tool_use" && blk.name) this.pushTool(child, blk.name, blk.input ?? {}, at);
        });
        transcripts++;
      } catch {
        continue;
      }
      for (const ev of child.events) if (ev.kind === "shell" || ev.kind === "file" || ev.kind === "tool") delegated.push({ ...ev, byAgent: true });
    }
    if (delegated.length) b.events.splice(firstSpawn ?? b.events.length, 0, ...delegated.slice(0, Math.max(0, MAX_EVENTS_PER_SESSION - b.events.length)));

    b.touch(file.modifiedAt.toISOString());
    const session = b.build();
    if (spawned.length || transcripts) session.agents = { spawned, transcripts };
    if (this.models) session.models = this.models.modelsFor(b.nativeId);
    const totalRecords = counts.total;
    const skippedRecords = counts.skipped;
    const sessions = session.requests.length > 0 && (!session.endedAt || session.endedAt >= cutoff) ? [session] : [];
    debug("file parsed", { adapter: this.id, records: totalRecords, skipped: skippedRecords, sessions: sessions.length });
    return { sessions, skippedRecords, totalRecords, unreadable: false };
  }

  /** Streams a transcript's user and assistant content blocks; malformed lines and blocks are counted and skipped. */
  private async readBlocks(
    path: string,
    b: SessionBuilder,
    counts: { total: number; skipped: number },
    onBlock: (role: "user" | "assistant", blk: z.infer<typeof Block>) => void,
  ): Promise<void> {
    for await (const line of readJsonl(path)) {
      counts.total++;
      if (line.error) {
        counts.skipped++;
        continue;
      }
      const parsed = CursorRecord.safeParse(line.value);
      if (!parsed.success) {
        counts.skipped++;
        continue;
      }
      const rec = parsed.data;
      if (rec.role !== "user" && rec.role !== "assistant") continue;
      const content = rec.message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
      for (const raw of blocks) {
        const block = Block.safeParse(raw);
        if (!block.success) {
          b.skipped++;
          continue;
        }
        onBlock(rec.role, block.data);
      }
    }
  }

  /** Adds the typed request(s) from one user message; returns its timestamp if Cursor recorded one. */
  private addUserText(b: SessionBuilder, text: string): string | undefined {
    const stamp = text.match(/<timestamp>([^<]{1,80})<\/timestamp>/);
    const at = stamp ? parseCursorTimestamp(stamp[1]!) : undefined;
    b.touch(at);
    // Background-task notifications are generated by Cursor, not typed by the developer.
    if (text.includes("<system_notification>")) return at;
    const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1]!.trim());
    for (const q of queries.length ? queries : [text.replace(/<timestamp>[^<]*<\/timestamp>/g, "")]) b.addRequest(q, at);
    return at;
  }

  private pushTool(b: SessionBuilder, name: string, input: Record<string, unknown> | string, at: string | undefined, spawned?: SpawnedAgent[]): void {
    const args = typeof input === "string" ? {} : input;
    if (spawned && SPAWN_TOOLS.has(name) && spawned.length < MAX_AGENT_TRANSCRIPTS) {
      const type = str(args.subagent_type);
      spawned.push({
        type: type && AGENT_TYPE.test(type) ? type : "agent",
        model: modelName(args.model),
        background: args.run_in_background === true,
        description: excerpt(str(args.description) ?? "", 80),
      });
    }
    if (SHELL_TOOLS.has(name)) {
      const command = str(args.command);
      if (command) b.push({ kind: "shell", at, command: clean.command(command) });
      return;
    }
    if (name === "ApplyPatch") {
      const patch = typeof input === "string" ? input : (str(args.patch) ?? str(args.input) ?? "");
      for (const f of patchedFiles(patch)) b.push({ kind: "file", at, op: f.op, path: clean.path(f.path) });
      return;
    }
    const op = FILE_TOOLS[name];
    if (op) {
      const path = str(args.path) ?? str(args.file_path) ?? str(args.target_notebook) ?? str(args.target_file);
      if (path) b.push({ kind: "file", at, op, path: clean.path(path) });
      return;
    }
    b.push({ kind: "tool", at, tool: (TOOL_ALIASES[name] ?? name).slice(0, 64) });
  }
}
