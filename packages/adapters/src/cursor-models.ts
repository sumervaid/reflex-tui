import { homedir, platform } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { debug } from "@reflex/core";

/** Where Cursor keeps its app state (chats, settings) on each platform. */
export function defaultCursorStateDb(): string {
  const rel = ["Cursor", "User", "globalStorage", "state.vscdb"];
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", ...rel);
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), ...rel);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ...rel);
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const MAX_MODELS = 5;

/**
 * Model names per Cursor chat, read from Cursor's app database. Cursor stores each message as
 * `bubbleId:<chatId>:<messageId>` with `modelInfo.modelName`, and the chat as `composerData:<chatId>`
 * with `modelConfig.modelName`. The agent-transcript id is the chat id.
 *
 * Opened read-only. SQLite extracts only the model-name field, so message text never reaches Reflex.
 */
export class CursorModelIndex {
  private db?: DatabaseSync;
  private byMessage?: StatementSync;
  private byChat?: StatementSync;

  constructor(readonly path: string) {}

  private open(): boolean {
    if (this.db) return true;
    try {
      this.db = new DatabaseSync(this.path, { readOnly: true });
      this.byMessage = this.db.prepare(
        `SELECT json_extract(value, '$.modelInfo.modelName') AS model, COUNT(*) AS n FROM cursorDiskKV
         WHERE key >= ? AND key < ? AND json_valid(value) GROUP BY model HAVING model IS NOT NULL ORDER BY n DESC, model`,
      );
      this.byChat = this.db.prepare(`SELECT json_extract(value, '$.modelConfig.modelName') AS model FROM cursorDiskKV WHERE key = ? AND json_valid(value)`);
      return true;
    } catch (err) {
      debug("cursor state db unavailable", { code: (err as { code?: string }).code ?? "error" });
      this.close();
      return false;
    }
  }

  /** Models the chat used, most messages first; `[]` when none is recorded, undefined when the database can't be read. */
  modelsFor(chatId: string): string[] | undefined {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(chatId) || !this.open()) return undefined;
    try {
      // `;` sorts right after `:`, so this range is exactly the chat's message keys.
      const rows = this.byMessage!.all(`bubbleId:${chatId}:`, `bubbleId:${chatId};`) as Array<{ model: unknown }>;
      let models = rows.map((r) => r.model);
      if (!models.length) models = [(this.byChat!.get(`composerData:${chatId}`) as { model?: unknown } | undefined)?.model];
      return models.filter((m): m is string => typeof m === "string" && MODEL_NAME.test(m)).slice(0, MAX_MODELS);
    } catch (err) {
      debug("cursor model lookup failed", { code: (err as { code?: string }).code ?? "error" });
      return undefined;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = undefined;
  }
}

/** One bubble of a database-only chat, as the adapter will consume it. */
export type DbBubble = {
  /** The header's type: 1 is the developer's message, 2 the assistant's. */
  type: number;
  createdAt?: string;
  /** The message text, raw; the adapter redacts it before anything is stored. */
  text?: string;
  tool?: DbTool;
};

/** A tool call in a database-only chat: the outcome fields plus the path a file call named. */
export type DbTool = ToolOutcome & {
  /** The file a read call named (`params.targetFile`). */
  readPath?: string;
  /** The file an edit call named, relative to the workspace (`params.relativeWorkspacePath`). */
  editPath?: string;
};

/** A chat that has no transcript file on disk, as Cursor's database alone describes it. */
export type DbChat = { id: string; bubbles: number; lastUpdatedMs: number };

/**
 * Chats that exist only in the app database (`composerData:<id>` with `fullConversationHeadersOnly`
 * and no transcript file): 13 of 340 in one real history. The headers give the conversation order
 * and each bubble's kind; the bubble rows carry the message text and the same tool data the outcome
 * reader sees. Opened read-only. Reading these chats means reading their message text — the adapter
 * redacts it like transcript text before anything is stored, and tool output is never selected.
 */
export class CursorDbChats {
  private db?: DatabaseSync;
  private listStmt?: StatementSync;
  private subStmt?: StatementSync;
  private bubbleStmt?: StatementSync;

  constructor(readonly path: string) {}

  private open(): boolean {
    if (this.db) return true;
    try {
      this.db = new DatabaseSync(this.path, { readOnly: true });
      this.listStmt = this.db.prepare(
        `SELECT substr(key, 14, 36) AS id,
                json_array_length(value, '$.fullConversationHeadersOnly') AS bubbles,
                json_extract(value, '$.lastUpdatedAt') AS updated
         FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND json_array_length(value, '$.fullConversationHeadersOnly') > 0`,
      );
      this.subStmt = this.db.prepare(
        `SELECT DISTINCT json_tree.value AS id FROM cursorDiskKV, json_tree(cursorDiskKV.value) AS json_tree
         WHERE cursorDiskKV.key LIKE 'composerData:%' AND json_tree.fullkey LIKE '$.subagentComposerIds%'`,
      );
      this.bubbleStmt = this.db.prepare(
        `SELECT key,
                json_extract(value, '$.type') AS type,
                json_extract(value, '$.text') AS text,
                json_extract(value, '$.createdAt') AS createdAt,
                json_extract(value, '$.toolFormerData.name') AS toolName,
                json_extract(value, '$.toolFormerData.status') AS toolStatus,
                json_extract(value, '$.toolFormerData.userDecision') AS toolDecision,
                json_extract(json_extract(value, '$.toolFormerData.params'), '$.command') AS toolCommand,
                json_extract(json_extract(value, '$.toolFormerData.params'), '$.targetFile') AS toolReadPath,
                json_extract(json_extract(value, '$.toolFormerData.params'), '$.relativeWorkspacePath') AS toolEditPath,
                json_extract(json_extract(value, '$.toolFormerData.result'), '$.exitCode') AS toolExitCode,
                json_extract(json_extract(value, '$.toolFormerData.result'), '$.rejected') AS toolRejected
         FROM cursorDiskKV WHERE key >= ? AND key < ?`,
      );
      return true;
    } catch (err) {
      debug("cursor state db unavailable", { code: (err as { code?: string }).code ?? "error" });
      this.close();
      return false;
    }
  }

  /** Composer ids some chat launched as sub-agents: those are skipped, not counted twice. */
  subagentIds(): Set<string> | undefined {
    if (!this.open()) return undefined;
    try {
      const rows = this.subStmt!.all() as Array<{ id: unknown }>;
      return new Set(rows.map((r) => r.id).filter((id): id is string => typeof id === "string"));
    } catch (err) {
      debug("cursor subagent lookup failed", { code: (err as { code?: string }).code ?? "error" });
      return undefined;
    }
  }

  /** Chats with conversation content that no transcript file on disk covers. */
  chats(onDisk: ReadonlySet<string>, subagents: ReadonlySet<string>): DbChat[] | undefined {
    if (!this.open()) return undefined;
    try {
      const rows = this.listStmt!.all() as Array<{ id: unknown; bubbles: unknown; updated: unknown }>;
      return rows
        .filter(
          (r): r is { id: string; bubbles: number; updated: number } =>
            typeof r.id === "string" &&
            CHAT_ID.test(r.id) &&
            !onDisk.has(r.id) &&
            !subagents.has(r.id) &&
            typeof r.bubbles === "number" &&
            r.bubbles > 0 &&
            typeof r.updated === "number",
        )
        .map((r) => ({ id: r.id, bubbles: r.bubbles, lastUpdatedMs: r.updated }));
    } catch (err) {
      debug("cursor chat listing failed", { code: (err as { code?: string }).code ?? "error" });
      return undefined;
    }
  }

  /** The chat's bubbles in conversation order, from the composer's own header list. */
  bubbles(chatId: string): DbBubble[] | undefined {
    if (!CHAT_ID.test(chatId) || !this.open()) return undefined;
    try {
      const composer = this.db!.prepare("SELECT json_extract(value, '$.fullConversationHeadersOnly') AS h FROM cursorDiskKV WHERE key = ?").get(`composerData:${chatId}`) as
        | { h: unknown }
        | undefined;
      if (!composer?.h || typeof composer.h !== "string") return undefined;
      const headers = JSON.parse(composer.h) as Array<{ bubbleId?: unknown; type?: unknown }>;
      const byId = new Map<string, Record<string, unknown>>();
      for (const row of this.bubbleStmt!.all(`bubbleId:${chatId}:`, `bubbleId:${chatId};`) as Array<Record<string, unknown>>) {
        const key = typeof row.key === "string" ? row.key.split(":")[2] : undefined;
        if (key) byId.set(key, row);
      }
      const out: DbBubble[] = [];
      for (const h of headers) {
        if (typeof h.bubbleId !== "string" || typeof h.type !== "number") continue;
        const row = byId.get(h.bubbleId);
        if (!row) continue;
        const bubble: DbBubble = { type: h.type, createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined };
        if (typeof row.text === "string" && row.text) bubble.text = row.text;
        if (typeof row.toolName === "string" && typeof row.toolStatus === "string") {
          bubble.tool = {
            name: row.toolName,
            status: row.toolStatus,
            command: typeof row.toolCommand === "string" ? row.toolCommand : undefined,
            exitCode: typeof row.toolExitCode === "number" ? row.toolExitCode : undefined,
            rejected: row.toolRejected === true || row.toolRejected === 1 || row.toolDecision === "rejected",
            readPath: typeof row.toolReadPath === "string" ? row.toolReadPath : undefined,
            editPath: typeof row.toolEditPath === "string" ? row.toolEditPath : undefined,
          };
        }
        out.push(bubble);
      }
      return out;
    } catch (err) {
      debug("cursor chat read failed", { code: (err as { code?: string }).code ?? "error" });
      return undefined;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = undefined;
  }
}

const CHAT_ID = /^[A-Za-z0-9-]{1,80}$/;

export type ToolOutcome = {
  name: string;
  status: string;
  /** The shell command, when the call ran one; used to match the transcript's own copy. */
  command?: string;
  /** Non-zero exit code; Cursor writes it only when it is non-zero. */
  exitCode?: number;
  /** The user declined to let the command run. */
  rejected: boolean;
};

/** Shell tool names across Cursor versions: the transcript says Shell or run_terminal_cmd. */
export const SHELL_DB_TOOLS = new Set(["run_terminal_command_v2", "run_terminal_cmd", "Shell"]);

/**
 * Tool outcomes per Cursor chat, read from the same app database as the model names. Each tool
 * bubble carries `toolFormerData` with `name` and `status`; `params` and `result` are JSON-encoded
 * strings, and SQLite parses them inline (`json_extract` over `json_extract`), so only the name,
 * status, the shell command and the result's exit code and rejected flag ever reach Reflex —
 * the output text is not even selected. Opened read-only, like the model index.
 */
export class CursorToolOutcomes {
  private db?: DatabaseSync;
  private stmt?: StatementSync;

  constructor(readonly path: string) {}

  private open(): boolean {
    if (this.db) return true;
    try {
      this.db = new DatabaseSync(this.path, { readOnly: true });
      this.stmt = this.db.prepare(
        `SELECT json_extract(value, '$.toolFormerData.name') AS name,
                json_extract(value, '$.toolFormerData.status') AS status,
                json_extract(value, '$.toolFormerData.userDecision') AS decision,
                json_extract(json_extract(value, '$.toolFormerData.params'), '$.command') AS command,
                json_extract(json_extract(value, '$.toolFormerData.result'), '$.exitCode') AS exitCode,
                json_extract(json_extract(value, '$.toolFormerData.result'), '$.rejected') AS rejected
         FROM cursorDiskKV WHERE key >= ? AND key < ? AND json_type(value, '$.toolFormerData') IS NOT NULL`,
      );
      return true;
    } catch (err) {
      debug("cursor state db unavailable", { code: (err as { code?: string }).code ?? "error" });
      this.close();
      return false;
    }
  }

  /** The chat's tool outcomes in stored order; `undefined` when the database can't be read. */
  forChat(chatId: string): ToolOutcome[] | undefined {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(chatId) || !this.open()) return undefined;
    try {
      // `;` sorts right after `:`, so this range is exactly the chat's message keys.
      const rows = this.stmt!.all(`bubbleId:${chatId}:`, `bubbleId:${chatId};`) as Array<{
        name: unknown;
        status: unknown;
        decision: unknown;
        command: unknown;
        exitCode: unknown;
        rejected: unknown;
      }>;
      return rows
        .filter((r) => typeof r.name === "string" && typeof r.status === "string")
        .map((r) => ({
          name: r.name as string,
          status: r.status as string,
          command: typeof r.command === "string" ? r.command : undefined,
          exitCode: typeof r.exitCode === "number" ? r.exitCode : undefined,
          rejected: r.rejected === true || r.rejected === 1 || r.decision === "rejected",
        }));
    } catch (err) {
      debug("cursor outcome lookup failed", { code: (err as { code?: string }).code ?? "error" });
      return undefined;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = undefined;
  }
}
