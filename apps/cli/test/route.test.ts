import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { Store } from "@reflex/storage";
import { scan } from "../src/commands/scan";
import { bench, routeAutopilot, routeExplore, routeStatus, runRouted } from "../src/commands/route";

let root: string;
let bin: string;
let output = "";
const capture = async (fn: () => Promise<void>) => {
  output = "";
  await fn();
  return output;
};
const argsLog = () => join(root, "args.log");
const PATH = process.env.PATH;

/** Stand-ins for the agent CLIs: record their arguments; in bench (-p) mode, finish the task and report usage. */
const FAKE_AGENT = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done > "${"$"}REFLEX_TEST_ARGS"
case " $* " in *" -p "*)
  echo done > done.txt
  echo '{"type":"result","is_error":false,"num_turns":3,"total_cost_usd":9,"usage":{"input_tokens":1000000,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
;; esac
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-route-"));
  process.env.REFLEX_HOME = join(root, "home");
  process.env.REFLEX_TEST_ARGS = argsLog();
  bin = join(root, "bin");
  await mkdir(bin);
  for (const cmd of ["claude", "codex"]) {
    await writeFile(join(bin, cmd), FAKE_AGENT);
    await chmod(join(bin, cmd), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${PATH}`;
  const h = await writeFixtureHistory(join(root, "history"));
  vi.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => ((output += String(c)), true));
  await scan({ days: 7, claudeDir: h.claudeRoot, codexDir: h.codexRoot, yes: true });
});

afterAll(async () => {
  vi.restoreAllMocks();
  process.env.PATH = PATH;
  delete process.env.REFLEX_TEST_ARGS;
  await rm(root, { recursive: true, force: true });
});

const store = <T>(fn: (s: Store) => T): T => {
  const s = new Store();
  try {
    return fn(s);
  } finally {
    s.close();
  }
};

describe("reflex run", () => {
  it("dry run: classifies the request from history and explains the pick, starting nothing", async () => {
    const text = await capture(() => runRouted(["CI", "is", "failing,", "fix", "the", "workflow"], { dryRun: true }));
    expect(text).toContain("Reflex run");
    expect(text).toMatch(/Task\s+CI and builds \(\d+ similar past sessions?/);
    expect(text).toMatch(/Start\s+(Claude Code|Codex) on /);
    expect(existsSync(argsLog())).toBe(false);
    expect(store((s) => s.routeRuns())).toEqual([]);
  });

  it("starts the agent on the pick with a session id Reflex can link, and records the run without the request", async () => {
    await capture(() => runRouted(["fix", "the", "failing", "CI", "job"], { tool: "claude-code", yes: true }));
    const args = (await readFile(argsLog(), "utf8")).trim().split("\n");
    const [run] = store((s) => s.routeRuns());
    expect(run).toMatchObject({ source: "claude-code", kind: "ci", randomized: false });
    expect(args.at(-1)).toBe("fix the failing CI job");
    expect(run!.outcome).toBeUndefined();
    const id = store((s) => s.saveRouteRun({ ...run! }));
    store((s) => s.setRouteRunOutcome(id, "done"));
    expect(store((s) => s.routeRuns()).at(-1)!.outcome).toBe("done");
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(run!.nativeId);
    if (run!.model) expect(args.slice(0, 2)).toEqual(["--model", run!.model]);
    expect(JSON.stringify(run)).not.toContain("failing");
  });

  it("names the model on request, refuses odd model names and unroutable tools", async () => {
    await capture(() => runRouted(["fix", "it"], { model: "gpt-5.5", yes: true }));
    expect((await readFile(argsLog(), "utf8")).trim().split("\n")).toEqual(["--model", "gpt-5.5", "fix it"]);
    expect(store((s) => s.routeRuns()).at(-1)).toMatchObject({ source: "codex", mode: "manual" });
    await expect(runRouted(["x"], { model: "opus; rm -rf ~" })).rejects.toThrow(/model name/);
    await expect(runRouted(["x"], { tool: "cursor" })).rejects.toThrow(/can't be routed/);
  });
});

describe("reflex route", () => {
  it("shows picks per kind of task and the settings", async () => {
    const text = await capture(() => routeStatus());
    expect(text).toContain("Router");
    expect(text).toMatch(/Autopilot\s+off/);
    expect(text).toMatch(/Exploration\s+off/);
    expect(text).toContain("CI and builds");
    expect(text).toContain("Randomized trials");
  });

  it("autopilot and exploration are Reflex settings, validated and clamped", async () => {
    await capture(() => routeAutopilot("on"));
    await capture(() => routeExplore("10", { protect: ["review"] }));
    expect(store((s) => s.routerSettings())).toEqual({ autopilot: true, explore: 0.1, protect: ["review"] });
    await expect(routeExplore("80", {})).rejects.toThrow(/1 to 50/);
    await expect(routeExplore("10", { protect: ["nope"] })).rejects.toThrow(/Unknown kind/);
    await expect(routeAutopilot("maybe")).rejects.toThrow(/on\|off/);
    expect(await capture(() => routeStatus())).toMatch(/Exploration\s+10% of runs · never on review/);
    await capture(() => routeExplore("off", {}));
    await capture(() => routeAutopilot("off"));
    expect(store((s) => s.routerSettings())).toEqual({ autopilot: false, explore: 0, protect: ["review"] });
  });
});

describe("reflex bench", () => {
  let repo: string;
  beforeAll(async () => {
    repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "README.md"), "# app\n");
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });

  it("runs each model in a fresh copy, scores it with the check and leaves the repository alone", async () => {
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      const text = await capture(() => bench(["fix", "the", "ci", "job"], { models: ["claude-sonnet-5-5", "claude-opus-5-5"], check: "test -f done.txt", runs: "1", timeout: "1", yes: true }));
      expect(text).toContain("committed state only");
      expect(text).toMatch(/Estimated cost\s+about \$[\d.]+ \(your average session/);
      expect(text).toContain("No history for claude-opus-5-5");
      expect(text).toMatch(/claude-sonnet-5-5 · run 1: passed · \$2\.00/);
    } finally {
      process.chdir(cwd);
    }
    const results = store((s) => s.benchResults());
    expect(results.map((r) => [r.model, r.pass, r.usd])).toEqual([
      ["claude-sonnet-5-5", true, 2],
      ["claude-opus-5-5", true, 4],
    ]);
    expect(new Set(results.map((r) => r.batch)).size).toBe(1);
    const args = (await readFile(argsLog(), "utf8")).trim().split("\n");
    expect(args).toEqual(expect.arrayContaining(["--no-session-persistence", "--setting-sources", "project", "Bash(test -f done.txt:*)"]));
    expect(existsSync(join(repo, "done.txt"))).toBe(false);
    expect(await readdir(join(root, "home", "bench"))).toEqual([]);
    expect(await capture(() => routeStatus())).toMatch(/claude-sonnet-5-5\s+1\/1 passed/);
  });

  it("refuses Codex models, missing checks and folders outside git", async () => {
    await expect(bench(["x"], { models: ["gpt-5.5"], check: "true", runs: "1", timeout: "1" })).rejects.toThrow(/Claude Code models only/);
    await expect(bench(["x"], { models: ["sonnet"], check: " ", runs: "1", timeout: "1" })).rejects.toThrow(/--check/);
    const cwd = process.cwd();
    process.chdir(tmpdir());
    try {
      await expect(bench(["x"], { models: ["sonnet"], check: "true", runs: "1", timeout: "1" })).rejects.toThrow(/git repository/);
    } finally {
      process.chdir(cwd);
    }
  });
});
