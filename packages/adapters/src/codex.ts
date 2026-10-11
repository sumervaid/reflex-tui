import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { DetectionResult, DiscoveryOptions, ParseResult, TranscriptAdapter, TranscriptFile } from "@reflex/core";
import { debug } from "@reflex/core";
import { displayPath } from "@reflex/safety";
import { readJsonl } from "./jsonl";
import { SessionBuilder, clean, cutoffFor, isDirectory, listFiles, patchedFiles, toTranscriptFiles, tokens } from "./common";

/**
 * Codex CLI rollout files: one JSON object per line, `{ timestamp, type, payload }`, where type is
 * session_meta | response_item | event_msg | turn_context | compacted. Older builds wrote items
 * unwrapped; both shapes are accepted.
 */
const RolloutLine = z
  .object({
    timestamp: z.string().optional(),
    type: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ContentItem = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

const Item = z
  .object({
    type: z.string(),
    role: z.string().optional(),
    content: z.array(z.unknown()).optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
    input: z.string().optional(),
    call_id: z.string().optional(),
    output: z.unknown().optional(),
    action: z.object({ type: z.string().optional(), command: z.array(z.string()).optional() }).passthrough().optional(),
    message: z.string().optional(),
    id: z.string().optional(),
    cwd: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

/** `event_msg` payload `{ type: "token_count", info: { total_token_usage } }`; totals are cumulative per session. */
const TokenCount = z
  .object({
    type: z.literal("token_count"),
    info: z
      .object({ total_token_usage: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const SHELL_TOOLS = new Set(["shell", "container.exec", "local_shell", "exec_command", "shell_command", "unified_exec"]);

function shellText(command: unknown): string | undefined {
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string")) {
    const argv = command as string[];
    // ["bash", "-lc", "<script>"] -> "<script>"
    if (argv.length >= 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv.slice(2).join(" ");
    return argv.join(" ");
  }
  return undefined;
}

function exitFailed(output: unknown): boolean {
  if (typeof output !== "string") return false;
  try {
    const parsed = JSON.parse(output) as { metadata?: { exit_code?: number } };
    const code = parsed?.metadata?.exit_code;
    return typeof code === "number" && code !== 0;
  } catch {
    return /exit code:?\s*[1-9]/i.test(output.slice(0, 400));
  }
}

export class CodexAdapter implements TranscriptAdapter {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly root: string;

  constructor(root?: string) {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    this.root = root ?? process.env.REFLEX_CODEX_DIR ?? join(codexHome, "sessions");
  }

  async detect(): Promise<DetectionResult> {
    const location = displayPath(this.root);
    if (!(await isDirectory(this.root))) return { found: false, location };
    const files = await listFiles(this.root, ".jsonl", 3);
    debug("adapter detected", { adapter: this.id, files: files.length });
    return { found: files.length > 0, location, candidateFiles: files.length };
  }

  async requestPermission(ask: (message: string) => Promise<boolean>, days: number): Promise<boolean> {
    return ask(`Read Codex sessions from the last ${days} day${days === 1 ? "" : "s"} at ${displayPath(this.root)}?`);
  }

  async discover(options: DiscoveryOptions): Promise<TranscriptFile[]> {
    // Layout: <root>/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl
    const paths = (await listFiles(this.root, ".jsonl", 3)).filter((p) => basename(p).startsWith("rollout-"));
    return toTranscriptFiles(paths, cutoffFor(options.days, options.now));
  }

  async parse(file: TranscriptFile, options: DiscoveryOptions): Promise<ParseResult> {
    const cutoff = cutoffFor(options.days, options.now).toISOString();
    const b = new SessionBuilder(this.id, basename(file.path, ".jsonl").replace(/^rollout-/, "").slice(0, 80), file);
    let totalRecords = 0;
    let skippedRecords = 0;
    let sawResponseUserMessage = false;
    const eventUserMessages: Array<{ text: string; at?: string }> = [];

    try {
      for await (const line of readJsonl(file.path)) {
        totalRecords++;
        if (line.error) {
          skippedRecords++;
          continue;
        }
        const wrapped = RolloutLine.safeParse(line.value);
        if (!wrapped.success) {
          skippedRecords++;
          continue;
        }
        const at = wrapped.data.timestamp;
        const kind = wrapped.data.type;
        const body = wrapped.data.payload ?? (line.value as Record<string, unknown>);
        b.touch(at);

        if (kind === "session_meta") {
          const meta = Item.safeParse({ type: "session_meta", ...body });
          if (meta.success) {
            if (meta.data.id) b.nativeId = meta.data.id.slice(0, 80);
            if (meta.data.cwd) b.cwd = meta.data.cwd;
            b.touch(meta.data.timestamp);
          }
          continue;
        }
        if (kind === "turn_context") {
          const cwd = (body as { cwd?: unknown }).cwd;
          if (!b.cwd && typeof cwd === "string") b.cwd = cwd;
          continue;
        }

        const parsed = Item.safeParse(body);
        if (!parsed.success) {
          if (kind === "response_item" || kind === "event_msg") skippedRecords++;
          continue;
        }
        const item = parsed.data;

        if (kind === "event_msg") {
          if (item.type === "user_message" && item.message) eventUserMessages.push({ text: item.message, at });
          const total = item.type === "token_count" ? TokenCount.safeParse(body).data?.info?.total_token_usage : undefined;
          if (total) {
            // OpenAI-style counts: input_tokens includes cached input, output_tokens includes reasoning.
            const cached = tokens(total.cached_input_tokens);
            b.usage = { input: Math.max(0, tokens(total.input_tokens) - cached), output: tokens(total.output_tokens), cacheRead: cached, cacheWrite: 0 };
          }
          continue;
        }

        switch (item.type) {
          case "message": {
            for (const raw of item.content ?? []) {
              const c = ContentItem.safeParse(raw);
              if (!c.success || !c.data.text) continue;
              if (item.role === "user" && c.data.type === "input_text") {
                const before = b.requests.length;
                b.addRequest(c.data.text, at);
                if (b.requests.length > before) sawResponseUserMessage = true;
              } else if (item.role === "assistant" && c.data.type === "output_text") {
                b.push({ kind: "assistant", at, text: clean.assistant(c.data.text) });
              }
            }
            break;
          }
          case "function_call": {
            const name = item.name ?? "";
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(item.arguments ?? "{}") as Record<string, unknown>;
            } catch {
              b.skipped++;
            }
            if (SHELL_TOOLS.has(name)) {
              const cmd = shellText(args.cmd ?? args.command);
              if (cmd) b.push({ kind: "shell", at, command: clean.command(cmd) }, item.call_id);
            } else if (name === "apply_patch") {
              const patch = typeof args.input === "string" ? args.input : "";
              for (const f of patchedFiles(patch)) b.push({ kind: "file", at, op: f.op, path: clean.path(f.path) });
            } else if (name) {
              b.push({ kind: "tool", at, tool: name.slice(0, 64) }, item.call_id);
            }
            break;
          }
          case "local_shell_call": {
            const cmd = shellText(item.action?.command);
            if (cmd) b.push({ kind: "shell", at, command: clean.command(cmd) }, item.call_id);
            break;
          }
          case "custom_tool_call": {
            if (item.name === "apply_patch" && item.input) {
              for (const f of patchedFiles(item.input)) b.push({ kind: "file", at, op: f.op, path: clean.path(f.path) }, item.call_id);
            } else if (item.name) {
              b.push({ kind: "tool", at, tool: item.name.slice(0, 64) }, item.call_id);
            }
            break;
          }
          case "function_call_output":
          case "local_shell_call_output":
          case "custom_tool_call_output":
            if (item.call_id) b.markResult(item.call_id, exitFailed(item.output));
            break;
          default:
            break;
        }
      }
    } catch (err) {
      debug("file unreadable", { adapter: this.id, code: (err as NodeJS.ErrnoException).code });
      return { sessions: [], skippedRecords, totalRecords, unreadable: true, error: "unreadable" };
    }

    // Some Codex versions only record the typed prompt as an event message.
    if (!sawResponseUserMessage) for (const m of eventUserMessages) b.addRequest(m.text, m.at);
    if (!b.endedAt) b.touch(file.modifiedAt.toISOString());
    const session = b.build();
    const sessions = session.requests.length > 0 && (!session.endedAt || session.endedAt >= cutoff) ? [session] : [];
    debug("file parsed", { adapter: this.id, records: totalRecords, skipped: skippedRecords, sessions: sessions.length });
    return { sessions, skippedRecords, totalRecords, unreadable: false };
  }
}
