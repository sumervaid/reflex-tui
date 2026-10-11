import { sha256 } from "@reflex/core";
import type { FixtureSession, FixtureStep } from "./types";

export const FIXTURE_HOME = "/Users/jordan";
const STEP_SECONDS = 37;

export function fixtureUuid(seed: string): string {
  const h = sha256(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function cwdFor(project: string): string {
  return `${FIXTURE_HOME}/code/${project}`;
}

export function startFor(session: FixtureSession, now: Date): Date {
  const hours = session.daysAgo * 24 + (session.hoursAgo ?? 0) + 1;
  return new Date(now.getTime() - hours * 3600 * 1000);
}

function stepOutput(step: FixtureStep): string {
  if ("bash" in step) return step.fail ? `${step.bash.split(" ")[0]}: command failed (exit code 1)` : "ok";
  return "ok";
}

type Line = Record<string, unknown>;

export function toClaudeLines(session: FixtureSession, start: Date, sessionId: string): { lines: Line[]; end: Date } {
  const cwd = cwdFor(session.project);
  let t = start.getTime();
  let parent: string | null = null;
  let n = 0;
  const lines: Line[] = [{ type: "permission-mode", permissionMode: "default", sessionId }];
  const base = () => ({
    parentUuid: parent,
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.296",
    gitBranch: "main",
  });
  const push = (type: "user" | "assistant", message: Line, extra: Line = {}) => {
    const uuid = fixtureUuid(`${session.key}:${n++}`);
    if (type === "assistant") {
      message = {
        ...message,
        id: `msg_${sha256(uuid).slice(0, 20)}`,
        model: "claude-sonnet-5-5",
        usage: { input_tokens: 40, output_tokens: 120, cache_read_input_tokens: 8000 + n * 400, cache_creation_input_tokens: 600 },
      };
    }
    lines.push({ ...base(), type, message, uuid, timestamp: new Date(t).toISOString(), ...extra });
    parent = uuid;
    t += STEP_SECONDS * 1000;
  };

  push("user", { role: "user", content: session.prompt });
  session.steps.forEach((step, i) => {
    if ("say" in step) return push("assistant", { role: "assistant", content: [{ type: "text", text: step.say }] });
    if ("user" in step) return push("user", { role: "user", content: step.user });
    const id = `toolu_${sha256(`${session.key}:${i}`).slice(0, 20)}`;
    const [name, input] = claudeTool(step, cwd);
    push("assistant", { role: "assistant", content: [{ type: "tool_use", id, name, input }] });
    const isError = "bash" in step && step.fail === true;
    push(
      "user",
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: stepOutput(step), is_error: isError }] },
      { toolUseResult: { stdout: stepOutput(step), stderr: "", interrupted: false } },
    );
  });
  push("assistant", { role: "assistant", content: [{ type: "text", text: session.summary }] });
  lines.push({ type: "ai-title", aiTitle: session.prompt.slice(0, 40), sessionId });
  return { lines, end: new Date(t) };
}

function claudeTool(step: FixtureStep, cwd: string): [string, Line] {
  if ("bash" in step) return ["Bash", { command: step.bash, description: "Run command" }];
  if ("read" in step) return ["Read", { file_path: `${cwd}/${step.read}` }];
  if ("edit" in step) return ["Edit", { file_path: `${cwd}/${step.edit}`, old_string: "…", new_string: "…", replace_all: false }];
  if ("write" in step) return ["Write", { file_path: `${cwd}/${step.write}`, content: "…" }];
  if ("grep" in step) return ["Grep", { pattern: step.grep, path: cwd }];
  if ("tool" in step) return [step.tool, {}];
  throw new Error("unreachable");
}

/** Older Codex builds call the shell tool `shell` with an argv array; newer ones use `exec_command`. */
export type CodexShellStyle = "shell" | "exec_command";

export function toCodexLines(
  session: FixtureSession,
  start: Date,
  sessionId: string,
  style: CodexShellStyle = "exec_command",
): { lines: Line[]; end: Date } {
  const cwd = cwdFor(session.project);
  const modernShell = style === "exec_command";
  let t = start.getTime();
  const lines: Line[] = [];
  const at = () => new Date(t).toISOString();
  const push = (type: string, payload: Line) => {
    lines.push({ timestamp: at(), type, payload });
    t += STEP_SECONDS * 1000;
  };
  const userMessage = (text: string) => {
    push("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
    push("event_msg", { type: "user_message", message: text, images: [] });
  };

  push("session_meta", {
    id: sessionId,
    timestamp: at(),
    cwd,
    originator: "codex_cli_rs",
    cli_version: "0.46.0",
    instructions: null,
    git: { branch: "main" },
  });
  push("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>zsh</shell>\n</environment_context>` }],
  });
  push("turn_context", { cwd, approval_policy: "on-request", sandbox_policy: { mode: "workspace-write" }, model: "gpt-5-codex" });
  userMessage(session.prompt);

  session.steps.forEach((step, i) => {
    if ("say" in step) return push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: step.say }] });
    if ("user" in step) return userMessage(step.user);
    const callId = `call_${sha256(`${session.key}:${i}`).slice(0, 24)}`;
    if ("edit" in step || "write" in step) {
      const path = "edit" in step ? step.edit : step.write;
      const header = "edit" in step ? `*** Update File: ${path}\n@@\n-…\n+…` : `*** Add File: ${path}\n+…`;
      push("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: callId, input: `*** Begin Patch\n${header}\n*** End Patch` });
      push("response_item", { type: "custom_tool_call_output", call_id: callId, output: "Success. Updated the following files" });
      return;
    }
    const command = codexCommand(step);
    const args = modernShell ? { cmd: command, workdir: cwd } : { command: ["bash", "-lc", command], workdir: cwd };
    push("response_item", {
      type: "function_call",
      name: modernShell ? "exec_command" : "shell",
      arguments: JSON.stringify(args),
      call_id: callId,
    });
    const failed = "bash" in step && step.fail === true;
    push("response_item", {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify({ output: stepOutput(step), metadata: { exit_code: failed ? 1 : 0, duration_seconds: 1.4 } }),
    });
  });
  push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: session.summary }] });
  const input = 9000 * (session.steps.length + 1);
  push("event_msg", {
    type: "token_count",
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: Math.round(input * 0.8), output_tokens: 150 * session.steps.length, reasoning_output_tokens: 0 } },
  });
  return { lines, end: new Date(t) };
}

function codexCommand(step: FixtureStep): string {
  if ("bash" in step) return step.bash;
  if ("read" in step) return `sed -n '1,160p' ${step.read}`;
  if ("grep" in step) return `rg -n "${step.grep}"`;
  if ("tool" in step) return step.tool;
  throw new Error("unreachable");
}
