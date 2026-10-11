import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { assertSlug, displayPath, ensureDir, redact, writeNewFile } from "@reflix/safety";

/**
 * A brand-new repository with a realistic CI failure that none of the historical sessions saw:
 * a config value is a string, so `retries + 1` becomes "31" and the retry test fails.
 */
const FIX_CI_REPO: Record<string, string> = {
  "package.json": JSON.stringify({ name: "checkout-service", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  ".github/workflows/ci.yml": [
    "name: ci",
    "on: [push, pull_request]",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "      - run: npm test",
    "",
  ].join("\n"),
  "config/default.json": JSON.stringify({ retries: "3", timeoutMs: 5000 }, null, 2) + "\n",
  "src/config.js": [
    'import { readFileSync } from "node:fs";',
    "",
    "export function loadConfig() {",
    '  return JSON.parse(readFileSync(new URL("../config/default.json", import.meta.url), "utf8"));',
    "}",
    "",
  ].join("\n"),
  "src/retry.js": [
    "export async function withRetry(fn, { retries }) {",
    "  const attempts = retries + 1;",
    "  let lastError;",
    "  for (let i = 0; i < attempts; i++) {",
    "    try {",
    "      return await fn();",
    "    } catch (err) {",
    "      lastError = err;",
    "    }",
    "  }",
    "  throw lastError;",
    "}",
    "",
  ].join("\n"),
  "test/retry.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { loadConfig } from "../src/config.js";',
    'import { withRetry } from "../src/retry.js";',
    "",
    'test("gives up after the configured number of retries", async () => {',
    "  const { retries } = loadConfig();",
    "  let calls = 0;",
    "  await assert.rejects(",
    "    withRetry(async () => {",
    "      calls++;",
    '      throw new Error("upstream unavailable");',
    "    }, { retries }),",
    "  );",
    "  assert.equal(calls, 4);",
    "});",
    "",
  ].join("\n"),
  "README.md": "# checkout-service\n\nRetries calls to the payments provider.\n",
};

export const FIX_CI_TASK =
  "CI is failing on this branch: the `test` job in GitHub Actions fails with `AssertionError: 31 !== 4`. Figure out why and fix it before I merge.";

export type Sandbox = { dir: string; prompt: string; skillPath: string };

function git(dir: string, args: string[]): void {
  const res = spawnSync("git", args, {
    cwd: dir,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "Reflix", GIT_AUTHOR_EMAIL: "noreply@reflix.local", GIT_COMMITTER_NAME: "Reflix", GIT_COMMITTER_EMAIL: "noreply@reflix.local" },
  });
  if (res.status !== 0) throw new Error(`git ${args[0]} failed in sandbox`);
}

/** Create the fresh-task repository and install the skill project-locally (.claude/skills). */
export async function createFixCiSandbox(root: string, skillName: string, skillContent: string): Promise<Sandbox> {
  assertSlug(skillName);
  await ensureDir(root, 0o700);
  const dir = join(root, `${skillName}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(dir, { mode: 0o700 });
  for (const [rel, content] of Object.entries(FIX_CI_REPO)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: retry payment calls"]);
  const skillDir = join(dir, ".claude", "skills", skillName);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeNewFile(skillPath, skillContent);
  return { dir, prompt: FIX_CI_TASK, skillPath };
}

export type AgentRun = {
  exitCode: number | null;
  skillUsed: boolean;
  commands: string[];
  editedFiles: string[];
  finalMessage?: string;
  testsPass: boolean;
  timedOut: boolean;
};

const ALLOWED_TOOLS = [
  "Skill",
  "Read",
  "Edit",
  "Glob",
  "Grep",
  "Bash(npm test:*)",
  "Bash(node --test:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
];

/**
 * Run a fresh, non-persistent Claude Code session in the sandbox with a fixed Reflix prompt and a
 * restricted tool allowlist, then check whether the skill was invoked and the tests now pass.
 */
export function runClaudeInSandbox(sandbox: Sandbox, skillName: string, timeoutMs = 6 * 60 * 1000): Promise<AgentRun> {
  const args = [
    "-p",
    sandbox.prompt,
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
    ...ALLOWED_TOOLS,
  ];
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: sandbox.dir, stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "";
    let timedOut = false;
    const run: AgentRun = { exitCode: null, skillUsed: false, commands: [], editedFiles: [], testsPass: false, timedOut: false };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    // Agents report resolved paths (macOS /tmp is /private/tmp).
    const bases = [...new Set([sandbox.dir, realpathSync(sandbox.dir)])].map((b) => b + sep);
    const sandboxRelative = (p: string) => {
      const base = bases.find((b) => p.startsWith(b));
      return base ? p.slice(base.length) : displayPath(p);
    };
    const handle = (line: string) => {
      let msg: { type?: string; message?: { content?: unknown }; result?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "result" && typeof msg.result === "string") run.finalMessage = redact(msg.result.slice(0, 2000));
      if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) return;
      for (const block of msg.message.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type !== "tool_use") continue;
        if (block.name === "Skill" && String(block.input?.skill ?? "").replace(/^.*:/, "") === skillName) run.skillUsed = true;
        if (block.name === "Bash" && typeof block.input?.command === "string") run.commands.push(redact(block.input.command.slice(0, 200)));
        if ((block.name === "Edit" || block.name === "Write") && typeof block.input?.file_path === "string")
          run.editedFiles.push(sandboxRelative(block.input.file_path));
      }
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
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ...run, exitCode: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer) handle(buffer);
      const test = spawnSync("node", ["--test"], { cwd: sandbox.dir, stdio: "ignore", timeout: 60_000 });
      resolve({ ...run, exitCode: code, testsPass: test.status === 0, timedOut });
    });
  });
}

export function sandboxTestsPass(dir: string): boolean {
  return spawnSync("node", ["--test"], { cwd: dir, stdio: "ignore", timeout: 60_000 }).status === 0;
}
