import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type TokenUsage } from "@reflex/core";
import { assertInside, writeNewFile } from "@reflex/safety";

/** The top folder of the git repository `dir` is in, or undefined. */
export function repoRoot(dir: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

/** The repository has changes that are not committed (a bench copy only has commits). */
export function hasUncommitted(root: string): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status !== 0 || r.stdout.trim().length > 0;
}

export function headCommit(root: string): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * A fresh copy of the repository's committed state at `dest`. The original is only read: no
 * worktree, no remote, no config change. The copy's `origin` is removed so nothing can be pushed
 * back to the original.
 */
export function cloneRepo(root: string, dest: string): void {
  const clone = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", root, dest], { stdio: "ignore" });
  if (clone.status !== 0) throw new Error("git clone of the repository failed");
  spawnSync("git", ["remote", "remove", "origin"], { cwd: dest, stdio: "ignore" });
}

/** Delete a bench copy, only inside Reflex's bench folder. */
export async function removeCopy(benchRoot: string, dir: string): Promise<void> {
  await rm(assertInside(benchRoot, dir), { recursive: true, force: true });
}

/** Run a command the user gave on the command line, in a bench copy. True when it exits 0. */
export function runUserCommand(dir: string, command: string, timeoutMs: number): boolean {
  return spawnSync(command, { cwd: dir, shell: true, stdio: "ignore", timeout: timeoutMs }).status === 0;
}

/** Put a skill into a bench copy project-locally (`.claude/skills/<name>/SKILL.md`), so only that copy loads it. */
export async function installInCopy(dir: string, name: string, content: string): Promise<void> {
  const skillDir = assertInside(dir, join(dir, ".claude", "skills", name));
  await mkdir(skillDir, { recursive: true });
  await writeNewFile(join(skillDir, "SKILL.md"), content);
}

/** A check command simple enough to allow as a Bash prefix for the agent (letters, paths, flags). */
const SIMPLE_COMMAND = /^[\w@./:=,+-]+( [\w@./:=,+-]+)*$/;

export function benchTools(check: string): { tools: string[]; agentCanRunCheck: boolean } {
  const tools = ["Skill", "Read", "Edit", "Write", "Glob", "Grep", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)"];
  const simple = SIMPLE_COMMAND.test(check.trim());
  if (simple) tools.push(`Bash(${check.trim()}:*)`);
  return { tools, agentCanRunCheck: simple };
}

export type BenchAgentRun = {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  usage?: TokenUsage;
  /** Claude Code's own cost estimate, used when the model has no known list price. */
  reportedUsd?: number;
  turns?: number;
  isError?: boolean;
  /** The agent's final answer, held in memory only (to compare its shape); never stored. */
  finalText?: string;
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * One non-persistent Claude Code run on `task` with `model` in a bench copy: project settings only,
 * no MCP servers, edits accepted, Bash limited to read-only git, `ls` and the check command. Only
 * the final result event is read (usage, turns, cost); nothing the agent writes is kept.
 */
export function runClaudeBench(dir: string, task: string, model: string | undefined, tools: string[], timeoutMs: number): Promise<BenchAgentRun> {
  const args = [
    "-p",
    task,
    ...(model ? ["--model", model] : []),
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    ...tools,
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    const run: BenchAgentRun = { exitCode: null, timedOut: false, durationMs: 0 };
    let buffer = "";
    const timer = setTimeout(() => {
      run.timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const handle = (line: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type !== "result") return;
      const u = (msg.usage ?? {}) as Record<string, unknown>;
      const input = num(u.input_tokens);
      const output = num(u.output_tokens);
      if (input !== undefined && output !== undefined) {
        run.usage = { input, output, cacheWrite: num(u.cache_creation_input_tokens) ?? 0, cacheRead: num(u.cache_read_input_tokens) ?? 0 };
      }
      run.reportedUsd = num(msg.total_cost_usd);
      if (typeof msg.result === "string") run.finalText = msg.result.slice(0, 50_000);
      run.turns = num(msg.num_turns);
      run.isError = typeof msg.is_error === "boolean" ? msg.is_error : undefined;
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    let finished = false;
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (buffer) handle(buffer);
      resolve({ ...run, exitCode: code, durationMs: Date.now() - started });
    };
    child.on("error", () => done(-1));
    child.on("close", done);
  });
}
