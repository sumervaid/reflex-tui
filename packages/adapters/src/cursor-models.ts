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

/** One tool call's outcome, as Cursor's database records it. Never carries output text. */
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
