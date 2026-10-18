import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { DetectionResult, DiscoveryOptions, ParseResult, TranscriptAdapter, TranscriptFile } from "@reflex/core";
import { debug } from "@reflex/core";
import { displayPath } from "@reflex/safety";
import { readJsonl } from "./jsonl";
import { SessionBuilder, clean, cutoffFor, isDirectory, listFiles, modelName, patchedFiles, toTranscriptFiles, tokens } from "./common";

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

/**
 * Text Codex sends in the user role itself: instructions, environment, notifications, hook output.
 * Mirrors Codex's own `is_contextual_user_fragment` (codex-rs/core/src/context); a user message
 * with any of these parts is not something you typed.
 */
const CODEX_CONTEXT = [
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<environment_context>",
  "<user_shell_command>",
  "<turn_aborted>",
  "<subagent_notification>",
  "<agent_message_board_notification>",
  "<recommended_plugins>",
  "<codex_internal_context",
  "<goal_context>",
  "<hook_prompt",
  "<skill",
  "Warning: apply_patch was requested via ",
  "Warning: The maximum number of unified exec processes",
  "Warning: Your account was flagged",
];
const isCodexContext = (text: string): boolean => {
  const t = text.trimStart();
  return CODEX_CONTEXT.some((p) => t.startsWith(p));
};

/** Older Codex builds prefixed the typed request in `user_message` events. */
const USER_MESSAGE_BEGIN = "## My request for Codex:";
const typedText = (text: string): string => {
  const i = text.indexOf(USER_MESSAGE_BEGIN);
  return i < 0 ? text : text.slice(i + USER_MESSAGE_BEGIN.length).trim();
};

/**
 * Threads Codex started on its own rather than for something you typed: agents a session launched,
 * reviews and compaction (`source: { subagent: … }`), guardian checks and memory consolidation
 * (`source: { internal: … }`). Their first message is written by Codex or the parent agent.
 */
export function startedByCodex(meta: Record<string, unknown>): boolean {
  const source = meta.source;
  if (source && typeof source === "object" && ("subagent" in source || "internal" in source)) return true;
  return ["subagent", "guardian_review", "memory_consolidation"].includes(String(meta.thread_source));
}

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

/** Tool output as text: a string, or (newer builds) a list of content items. */
function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return undefined;
  return output.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n");
}

/**
 * Whether a command failed. The old `shell` tool returned JSON with `metadata.exit_code`; later
 * builds write "Exit code: 1", and `exec_command` (unified exec) "Process exited with code 1".
 */
function exitFailed(output: unknown): boolean {
  const text = outputText(output);
  if (text === undefined) return false;
  try {
    const parsed = JSON.parse(text) as { metadata?: { exit_code?: number } };
    const code = parsed?.metadata?.exit_code;
    return typeof code === "number" && code !== 0;
  } catch {
    return /(exit code:?|exited with code)\s*[1-9]/i.test(text.slice(0, 400));
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
    // REFLEX_DEBUG=1 shows these per file, so a change in Codex's format is visible.
    const skippedByType: Record<string, number> = {};
    const skip = (type: string) => {
      skippedRecords++;
      skippedByType[type] = (skippedByType[type] ?? 0) + 1;
    };
    let codexThread = false;
    let sawResponseUserMessage = false;
    const eventUserMessages: Array<{ text: string; at?: string }> = [];
    let model: string | undefined;

    try {
      for await (const line of readJsonl(file.path)) {
        totalRecords++;
        if (line.error) {
          skip("invalid JSON");
          continue;
        }
        const wrapped = RolloutLine.safeParse(line.value);
        if (!wrapped.success) {
          skip("unknown shape");
          continue;
        }
        const at = wrapped.data.timestamp;
        const kind = wrapped.data.type;
        const body = wrapped.data.payload ?? (line.value as Record<string, unknown>);
        b.touch(at);

        if (kind === "session_meta") {
          if (startedByCodex(body)) {
            codexThread = true;
            break;
          }
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
          model = modelName((body as { model?: unknown }).model) ?? model;
          continue;
        }

        const parsed = Item.safeParse(body);
        if (!parsed.success) {
          if (kind === "response_item" || kind === "event_msg") skip(`${kind} without a type`);
          continue;
        }
        const item = parsed.data;

        if (kind === "event_msg") {
          if (item.type === "user_message" && item.message) eventUserMessages.push({ text: typedText(item.message), at });
          // Paginated rollouts record what you typed as a completed `UserMessage` item instead.
          if (item.type === "item_completed") {
            const done = (body as { item?: { type?: unknown; content?: unknown } }).item;
            if (done?.type === "UserMessage" && Array.isArray(done.content)) {
              const text = done.content.map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n").trim();
              if (text) eventUserMessages.push({ text, at });
            }
          }
          const total = item.type === "token_count" ? TokenCount.safeParse(body).data?.info?.total_token_usage : undefined;
          if (total) {
            // OpenAI-style counts: input_tokens includes cached input, output_tokens includes reasoning.
            const cached = tokens(total.cached_input_tokens);
            b.usage = { input: Math.max(0, tokens(total.input_tokens) - cached), output: tokens(total.output_tokens), cacheRead: cached, cacheWrite: 0 };
            // Totals are cumulative, so the whole session is attributed to the latest model it ran on.
            if (model) b.usageByModel = { [model]: b.usage };
          }
          continue;
        }

        switch (item.type) {
          case "message": {
            const texts = (item.content ?? []).map((raw) => ContentItem.safeParse(raw).data?.text ?? "");
            if (item.role === "user" && texts.some(isCodexContext)) break;
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

    if (codexThread) {
      debug("file parsed", { adapter: this.id, records: totalRecords, sessions: 0, startedByCodex: true });
      return { sessions: [], skippedRecords, totalRecords, unreadable: false };
    }
    // Some Codex versions only record the typed prompt as an event message.
    if (!sawResponseUserMessage) for (const m of eventUserMessages) b.addRequest(m.text, m.at);
    if (!b.endedAt) b.touch(file.modifiedAt.toISOString());
    const session = b.build();
    const sessions = session.requests.length > 0 && (!session.endedAt || session.endedAt >= cutoff) ? [session] : [];
    debug("file parsed", { adapter: this.id, records: totalRecords, skipped: skippedRecords, skippedByType: Object.entries(skippedByType).map(([t, n]) => `${t}:${n}`).join(",") || undefined, sessions: sessions.length });
    return { sessions, skippedRecords, totalRecords, unreadable: false };
  }
}
