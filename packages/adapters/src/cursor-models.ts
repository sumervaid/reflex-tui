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
