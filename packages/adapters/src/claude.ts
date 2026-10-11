import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { DetectionResult, DiscoveryOptions, ParseResult, TranscriptAdapter, TranscriptFile } from "@reflex/core";
import { addUsage, debug } from "@reflex/core";
import { displayPath } from "@reflex/safety";
import { readJsonl } from "./jsonl";
import { SessionBuilder, clean, cutoffFor, isDirectory, listFiles, skillName, toTranscriptFiles, tokens } from "./common";

const ContentBlock = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    tool_use_id: z.string().optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

const ClaudeRecord = z
  .object({
    type: z.string(),
    uuid: z.string().optional(),
    sessionId: z.string().optional(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    isSidechain: z.boolean().optional(),
    isMeta: z.boolean().optional(),
    message: z
      .object({
        role: z.string().optional(),
        id: z.string().optional(),
        content: z.union([z.string(), z.array(z.unknown())]).optional(),
        usage: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Record types Claude Code writes that carry no workflow signal. */
const METADATA_TYPES = new Set([
  "summary",
  "system",
  "attachment",
  "file-history-snapshot",
  "permission-mode",
  "mode",
  "last-prompt",
  "ai-title",
  "cost-state",
  "atis-latch",
  "queue-operation",
]);

const FILE_TOOLS: Record<string, "read" | "write" | "edit"> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
};

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class ClaudeCodeAdapter implements TranscriptAdapter {
  readonly id = "claude-code" as const;
  readonly label = "Claude Code";
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? process.env.REFLEX_CLAUDE_DIR ?? join(homedir(), ".claude", "projects");
  }

  async detect(): Promise<DetectionResult> {
    const location = displayPath(this.root);
    if (!(await isDirectory(this.root))) return { found: false, location };
    const files = await listFiles(this.root, ".jsonl", 1);
    debug("adapter detected", { adapter: this.id, files: files.length });
    return { found: files.length > 0, location, candidateFiles: files.length };
  }

  async requestPermission(ask: (message: string) => Promise<boolean>, days: number): Promise<boolean> {
    return ask(`Read Claude Code sessions from the last ${days} day${days === 1 ? "" : "s"} at ${displayPath(this.root)}?`);
  }

  async discover(options: DiscoveryOptions): Promise<TranscriptFile[]> {
    // Layout: <root>/<encoded-project-dir>/<session-id>.jsonl. Subagent and tool-result folders are deeper and ignored.
    const paths = await listFiles(this.root, ".jsonl", 1);
    return toTranscriptFiles(paths, cutoffFor(options.days, options.now));
  }

  async parse(file: TranscriptFile, options: DiscoveryOptions): Promise<ParseResult> {
    const cutoff = cutoffFor(options.days, options.now).toISOString();
    const builders = new Map<string, SessionBuilder>();
    const seenUuids = new Set<string>();
    // Claude Code writes one record per content block and repeats the message's usage on each.
    const countedMessages = new Set<string>();
    let totalRecords = 0;
    let skippedRecords = 0;
    const fallbackId = basename(file.path, ".jsonl");

    try {
      for await (const line of readJsonl(file.path)) {
        totalRecords++;
        if (line.error) {
          skippedRecords++;
          continue;
        }
        const parsed = ClaudeRecord.safeParse(line.value);
        if (!parsed.success) {
          skippedRecords++;
          continue;
        }
        const rec = parsed.data;
        if (rec.type !== "user" && rec.type !== "assistant") {
          if (!METADATA_TYPES.has(rec.type)) debug("unknown record type", { adapter: this.id, type: rec.type.slice(0, 32) });
          continue;
        }
        if (rec.isSidechain) continue;
        if (rec.uuid) {
          if (seenUuids.has(rec.uuid)) continue;
          seenUuids.add(rec.uuid);
        }

        const sessionId = (rec.sessionId ?? fallbackId).slice(0, 80);
        let b = builders.get(sessionId);
        if (!b) {
          b = new SessionBuilder(this.id, sessionId, file);
          builders.set(sessionId, b);
        }
        b.touch(rec.timestamp);
        if (!b.cwd && rec.cwd) b.cwd = rec.cwd;
        const at = rec.timestamp;
        const content = rec.message?.content;

        if (rec.type === "user") {
          if (rec.isMeta) continue;
          if (typeof content === "string") {
            b.addRequest(content, at);
            continue;
          }
          for (const raw of content ?? []) {
            const block = ContentBlock.safeParse(raw);
            if (!block.success) {
              b.skipped++;
              continue;
            }
            const blk = block.data;
            if (blk.type === "text" && blk.text) b.addRequest(blk.text, at);
            else if (blk.type === "tool_result" && blk.tool_use_id) b.markResult(blk.tool_use_id, blk.is_error === true);
          }
          continue;
        }

        const usage = rec.message?.usage;
        const messageId = rec.message?.id;
        if (usage && messageId && !countedMessages.has(messageId)) {
          countedMessages.add(messageId);
          b.usage = addUsage(b.usage, {
            input: tokens(usage.input_tokens),
            output: tokens(usage.output_tokens),
            cacheRead: tokens(usage.cache_read_input_tokens),
            cacheWrite: tokens(usage.cache_creation_input_tokens),
          });
        }

        if (!Array.isArray(content)) continue;
        for (const raw of content) {
          const block = ContentBlock.safeParse(raw);
          if (!block.success) {
            b.skipped++;
            continue;
          }
          const blk = block.data;
          if (blk.type === "text" && blk.text) {
            b.push({ kind: "assistant", at, text: clean.assistant(blk.text) });
          } else if (blk.type === "tool_use" && blk.name) {
            this.pushTool(b, blk.name, blk.input ?? {}, at, blk.id);
          }
        }
      }
    } catch (err) {
      debug("file unreadable", { adapter: this.id, code: (err as NodeJS.ErrnoException).code });
      return { sessions: [], skippedRecords, totalRecords, unreadable: true, error: "unreadable" };
    }

    const sessions = [...builders.values()]
      .filter((b) => b.requests.length > 0)
      .map((b) => {
        if (!b.endedAt) b.touch(file.modifiedAt.toISOString());
        return b.build();
      })
      .filter((s) => !s.endedAt || s.endedAt >= cutoff);

    debug("file parsed", { adapter: this.id, records: totalRecords, skipped: skippedRecords, sessions: sessions.length });
    return { sessions, skippedRecords, totalRecords, unreadable: false };
  }

  private pushTool(b: SessionBuilder, name: string, input: Record<string, unknown>, at: string | undefined, id?: string): void {
    if (name === "Bash") {
      const command = str(input.command);
      if (command) b.push({ kind: "shell", at, command: clean.command(command) }, id);
      return;
    }
    const op = FILE_TOOLS[name];
    if (op) {
      const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
      if (path) b.push({ kind: "file", at, op, path: clean.path(path) }, id);
      return;
    }
    if (name === "Skill") {
      b.push({ kind: "tool", at, tool: name, skill: skillName(input.skill) }, id);
      return;
    }
    b.push({ kind: "tool", at, tool: name.slice(0, 64) }, id);
  }
}
