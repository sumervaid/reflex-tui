import { existsSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { DetectionResult, DiscoveryOptions, ParseResult, SessionEvent, SpawnedAgent, TranscriptAdapter, TranscriptFile, WorkflowTrace } from "@reflex/core";
import { debug, historyWindow } from "@reflex/core";
import { displayPath, excerpt } from "@reflex/safety";
import { CursorDbChats, CursorModelIndex, CursorToolOutcomes, SHELL_DB_TOOLS, type DbBubble, type ToolOutcome, defaultCursorStateDb } from "./cursor-models";
import { CursorUsageLog } from "./cursor-usage";
import { readJsonl } from "./jsonl";

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
import { MAX_EVENTS_PER_SESSION, SessionBuilder, clean, cutoffFor, errorExcerpt, isDirectory, listFiles, modelName, patchedFiles, toTranscriptFiles } from "./common";

/**
 * Cursor agent transcripts: `<root>/<encoded-workspace>/agent-transcripts/<id>/<id>.jsonl`, one
 * `{ role, message: { content: [text | tool_use] } }` record per line plus `{ type: "turn_ended" }`
 * markers. There are no per-record timestamps, working directory or tool results in the transcript;
 * time comes from the `<timestamp>` tag Cursor adds to user messages, falling back to the file's
 * mtime, and tool outcomes (when the app-database read is allowed) come from `state.vscdb`.
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

/**
 * What Cursor puts in the prompt when a plan is built. The developer didn't type it, and its
 * "Do not ..." sentences would be mined as their corrections, so only its meaning is kept.
 */
const CURSOR_PLAN_BUILD =
  /Implement the plan as specified,? it is attached for your reference\.?\s*(?:Do NOT edit the plan file itself\.?\s*)?(?:To-do['’]?s from the plan have already been created\.?\s*)?(?:Do not create them again\.?\s*)?(?:Mark them as in_progress as you work,? starting with the first one\.?\s*)?(?:Don['’]?t stop until you have completed all the to-?dos\.?\s*)?/gi;

export function stripCursorInserts(text: string): string {
  return text.replace(CURSOR_PLAN_BUILD, "Implement the plan.\n").trim();
}

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
  /** Cursor's app database, for model names and tool outcomes. Undefined for a custom transcript folder, which reads only that folder. */
  readonly stateDb?: string;
  private models?: CursorModelIndex;
  private outcomes?: CursorToolOutcomes;
  private dbChats?: CursorDbChats;
  /** Token counts recorded by Reflex's Cursor hook, when it was turned on. */
  private usage?: CursorUsageLog;

  constructor(root?: string, stateDb?: string, opts: { usageLog?: string } = {}) {
    this.root = root ?? process.env.REFLEX_CURSOR_DIR ?? join(homedir(), ".cursor", "projects");
    const custom = root ?? process.env.REFLEX_CURSOR_DIR;
    this.stateDb = stateDb ?? process.env.REFLEX_CURSOR_STATE_DB ?? (custom ? undefined : defaultCursorStateDb());
    if (opts.usageLog) this.usage = new CursorUsageLog(opts.usageLog);
  }

  /**
   * The conversation ids whose recorded turns belong to this chat: the chat's own. Agents it
   * launched may report their own turns too, and whether the chat's totals already include them
   * is not known yet, so they are left out rather than possibly counted twice.
   */
  private conversationIds(chatFile: string): string[] {
    return [basename(chatFile, ".jsonl")];
  }

  /** Whether the user allowed reading model names from Cursor's app database in this scan. */
  get readsModels(): boolean {
    return this.models !== undefined;
  }

  /** Whether the user allowed reading tool outcomes from Cursor's app database in this scan. */
  get readsOutcomes(): boolean {
    return this.outcomes !== undefined;
  }

  /** Whether the user allowed reading chats that have no transcript file from the app database. */
  get readsDbChats(): boolean {
    return this.dbChats !== undefined;
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
    if (!(await ask(`Read Cursor agent sessions from ${historyWindow(days)} at ${displayPath(this.root)}?`))) return false;
    if (this.stateDb && (await isFile(this.stateDb))) {
      const allowed = await ask(
        `Also read which model each Cursor chat used, from Cursor's app database at ${displayPath(this.stateDb)}? Read-only; only model names are extracted, never messages.`,
      );
      if (allowed) this.models = new CursorModelIndex(this.stateDb);
      const outcomes = await ask(
        `Also read whether each tool call succeeded or failed, from the same database? Read-only; only tool names, statuses, shell commands, exit codes and rejected flags are extracted, and for failed calls the first 200 characters of the error output, redacted — never messages, and never the output of a call that succeeded.`,
      );
      if (outcomes) this.outcomes = new CursorToolOutcomes(this.stateDb);
      const dbChats = await ask(
        `Some chats exist only in Cursor's app database, with no transcript file. Read those too? Their message text is redacted like transcripts before anything is stored, and tool output is never read.`,
      );
      if (dbChats) this.dbChats = new CursorDbChats(this.stateDb);
    }
    return true;
  }

  needsReread(trace: WorkflowTrace): boolean {
    if (this.readsModels && trace.source === "cursor" && trace.models === undefined) return true;
    return this.readsOutcomes && trace.source === "cursor" && trace.outcomesRead !== true;
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
      // Turns recorded since the last scan change the chat too: its usage is read with it.
      if (this.usage) {
        const sig = this.usage.signature(this.conversationIds(f.path));
        f.sizeBytes += sig.turns;
        if (f.identity && sig.latest) f.identity.ctimeMs = Math.max(f.identity.ctimeMs, sig.latest);
      }
      if (f.modifiedAt >= cutoff) out.push(f);
    }
    // Chats that exist only in the database: no transcript file, not a sub-agent, still in the window.
    if (this.dbChats) {
      const disk = new Set(files.map((f) => basename(f.path, ".jsonl")));
      const subagents = this.dbChats.subagentIds() ?? new Set<string>();
      for (const chat of this.dbChats.chats(disk, subagents) ?? []) {
        const modifiedAt = new Date(chat.lastUpdatedMs);
        if (modifiedAt < cutoff) continue;
        const path = join(this.root, "_app-database", `${chat.id}.jsonl`);
        out.push({
          path,
          displayPath: displayPath(path),
          modifiedAt,
          sizeBytes: chat.bubbles,
          identity: { mtimeMs: chat.lastUpdatedMs, ctimeMs: chat.lastUpdatedMs, ino: `db:${chat.id}` },
        });
      }
    }
    return out;
  }

  async parse(file: TranscriptFile, options: DiscoveryOptions): Promise<ParseResult> {
    // Chats read from the app database have a synthetic path under `_app-database`.
    if (this.dbChats && basename(dirname(file.path)) === "_app-database") return this.parseDbChat(file, options);
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

    if (this.outcomes) this.applyOutcomes(b);

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
    const recorded = this.usage?.usageFor(this.conversationIds(file.path));
    if (recorded) {
      b.usage = recorded.usage;
      if (Object.keys(recorded.byModel).length) b.usageByModel = recorded.byModel;
    }
    const session = b.build();
    if (spawned.length || transcripts) session.agents = { spawned, transcripts };
    if (this.models) session.models = this.models.modelsFor(b.nativeId);
    if (this.outcomes) session.outcomesRead = true;
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
    for (const q of queries.length ? queries : [text.replace(/<timestamp>[^<]*<\/timestamp>/g, "")]) b.addRequest(stripCursorInserts(q), at);
    return at;
  }

  private pushTool(b: SessionBuilder, name: string, input: Record<string, unknown> | string, at: string | undefined, spawned?: SpawnedAgent[]): void {    const args = typeof input === "string" ? {} : input;
    if (spawned && SPAWN_TOOLS.has(name) && spawned.length < MAX_AGENT_TRANSCRIPTS) {
      const type = str(args.subagent_type);
      spawned.push({
        type: type && AGENT_TYPE.test(type) ? type : "agent",
        model: modelName(args.model),
        background: args.run_in_background === true,
        // The parent agent writes this; strip control characters so `reflex agents` never prints escape sequences.
        description: excerpt((str(args.description) ?? "").replace(CONTROL, " "), 80),
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

  /**
   * Marks the transcript's tool calls with what Cursor's database recorded about them. The match is
   * strict, so a wrong call never gets marked: shell calls must agree on the command text, and the
   * rest must be the next unconsumed row of the same class; anything that cannot be matched is left
   * alone. A rejected call never ran, and a cancelled one did not finish, so neither is an error.
   */
  private applyOutcomes(b: SessionBuilder): void {
    const rows = this.outcomes!.forChat(b.nativeId);
    if (!rows?.length) return;
    const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
    const classOf = (row: { name: string }): "shell" | "read" | "edit" | "tool" =>
      SHELL_DB_TOOLS.has(row.name)
        ? "shell"
        : /^(read_file_v2|Read|ReadFile)$/.test(row.name)
          ? "read"
          : /^(edit_file_v2|delete_file|Write|EditFile|StrReplace|EditNotebook)$/.test(row.name)
            ? "edit"
            : "tool";
    const errorOf = (row: { status: string; exitCode?: number }): boolean =>
      row.status === "error" || (row.status === "completed" && row.exitCode !== undefined && row.exitCode !== 0);
    // The database holds rows the transcript export never had, so a row that matches nothing stays
    // unconsumed: each event claims the first free row of its class, and a shell event only the one
    // that ran the same command. A wrong call never gets marked; an unmatched one is left alone.
    const used = new Array<boolean>(rows.length).fill(false);
    const claim = (kind: "shell" | "read" | "edit" | "tool", command?: string): ToolOutcome | undefined => {
      const want = command !== undefined ? flat(command) : undefined;
      for (let j = 0; j < rows.length; j++) {
        if (used[j]) continue;
        const row = rows[j]!;
        if (classOf(row) !== kind) continue;
        if (want !== undefined && flat(row.command ?? "") !== want) continue;
        used[j] = true;
        return row;
      }
      return undefined;
    };
    const failed = (row: ToolOutcome): boolean => !row.rejected && row.status !== "cancelled" && row.status !== "loading" && errorOf(row);
    type Toolish = Extract<SessionEvent, { kind: "shell" }> | Extract<SessionEvent, { kind: "file" }> | Extract<SessionEvent, { kind: "tool" }>;
    const mark = (ev: Toolish, row: ToolOutcome): void => {
      // A refusal is the developer's clearest correction (#72), but it is not a failure.
      if (row.rejected) {
        if (ev.kind === "shell") ev.rejected = true;
        return;
      }
      if (!failed(row)) return;
      ev.isError = true;
      if (row.exitCode !== undefined && ev.kind === "shell") ev.exitCode = row.exitCode;
      const excerpt = errorExcerpt(row.errorOutput);
      if (excerpt) ev.errorExcerpt = excerpt;
    };
    for (const ev of b.events) {
      if (ev.kind === "shell") {
        const row = claim("shell", ev.command);
        if (row) mark(ev, row);
      } else if (ev.kind === "file") {
        const row = claim(ev.op === "read" ? "read" : "edit");
        if (row) mark(ev, row);
      } else if (ev.kind === "tool") {
        const row = claim("tool");
        if (row) mark(ev, row);
      }
    }
  }

  /**
   * Parses a chat that only Cursor's database holds: its bubbles in the order the composer's
   * headers give. The message text is raw here and is redacted by the session builder before
   * anything is stored; the tool data is the same six fields the outcome reader extracts.
   */
  private parseDbChat(file: TranscriptFile, options: DiscoveryOptions): ParseResult {
    const cutoff = cutoffFor(options.days, options.now).toISOString();
    const b = new SessionBuilder(this.id, basename(file.path, ".jsonl").slice(0, 80), file);
    const counts = { total: 0, skipped: 0 };
    const bubbles = this.dbChats!.bubbles(b.nativeId);
    if (!bubbles) {
      debug("db chat unreadable", { adapter: this.id, chat: b.nativeId.slice(0, 12) });
      return { sessions: [], skippedRecords: 0, totalRecords: 0, unreadable: true, error: "database unavailable" };
    }
    for (const bubble of bubbles) {
      counts.total++;
      b.touch(bubble.createdAt);
      if (bubble.tool) {
        this.pushDbTool(b, bubble);
        continue;
      }
      if (!bubble.text) {
        counts.skipped++;
        continue;
      }
      if (bubble.type === 1) b.addRequest(bubble.text, bubble.createdAt);
      else b.push({ kind: "assistant", at: bubble.createdAt, text: clean.assistant(bubble.text) });
    }
    b.touch(file.modifiedAt.toISOString());
    const session = b.build();
    // The tool data came with the chat itself; there is no second read to consent to.
    session.outcomesRead = true;
    if (this.models) session.models = this.models.modelsFor(b.nativeId);
    const sessions = session.requests.length > 0 && (!session.endedAt || session.endedAt >= cutoff) ? [session] : [];
    debug("db chat parsed", { adapter: this.id, records: counts.total, skipped: counts.skipped, sessions: sessions.length });
    return { sessions, skippedRecords: counts.skipped, totalRecords: counts.total, unreadable: false };
  }

  /** Maps a database tool call onto the events the analysis understands, with its outcome. */
  private pushDbTool(b: SessionBuilder, bubble: DbBubble): void {
    const tool = bubble.tool!;
    const failed = tool.status === "error" || (tool.status === "completed" && tool.exitCode !== undefined && tool.exitCode !== 0);
    const excerpt = failed ? errorExcerpt(tool.errorOutput) : undefined;
    const outcome = tool.rejected
      ? { rejected: true as const }
      : { ...(failed ? { isError: true as const } : {}), ...(excerpt ? { errorExcerpt: excerpt } : {}) };
    const code = failed && tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {};
    if (SHELL_DB_TOOLS.has(tool.name)) {
      if (tool.command) b.push({ kind: "shell", at: bubble.createdAt, command: clean.command(tool.command), ...code, ...outcome });
      else b.push({ kind: "tool", at: bubble.createdAt, tool: "Shell", ...outcome });
      return;
    }
    if (/^(read_file_v2|Read|ReadFile)$/.test(tool.name)) {
      b.push(tool.readPath ? { kind: "file", at: bubble.createdAt, op: "read", path: clean.path(tool.readPath), ...outcome } : { kind: "tool", at: bubble.createdAt, tool: "Read", ...outcome });
      return;
    }
    if (/^(edit_file_v2|delete_file|Write|EditFile|StrReplace|EditNotebook)$/.test(tool.name)) {
      b.push(tool.editPath ? { kind: "file", at: bubble.createdAt, op: "edit", path: clean.path(tool.editPath), ...outcome } : { kind: "tool", at: bubble.createdAt, tool: "Edit", ...outcome });
      return;
    }
    const name = (DB_TOOL_ALIASES[tool.name] ?? tool.name.replace(/_v2$/, "")).slice(0, 64);
    b.push({ kind: "tool", at: bubble.createdAt, tool: name, ...outcome });
  }
}

/** Database tool names mapped onto the names the analysis understands. */
const DB_TOOL_ALIASES: Record<string, string> = { ripgrep_raw_search: "Grep", run_terminal_command: "Shell" };
