#!/usr/bin/env node
/* global process, console */
// Live smoke test of `reflex tui` in a real terminal (tmux), entirely inside a temp folder.
//
// HOME, REFLEX_HOME, REFLEX_{CLAUDE,CODEX,CURSOR}_DIR and REFLEX_{CLAUDE,CODEX,CURSOR}_SKILLS_DIR all
// point into a fresh temp dir, so the user's real history and skill folders are never read or
// touched. Steps:
//   1. fresh REFLEX_HOME (no scan yet): capture the first screen
//   2. write @reflex/test-fixtures history, run `reflex scan --yes --days 30 --claude-dir --codex-dir`
//   3. `reflex tui` at 150x45 and 120x40: capture views 0..6
//   4. on Skills: space installs the selected suggestion into the temp targets, space again removes it
//   5. q returns to the shell, and the tty is back in canonical mode with echo on
// Screens go to docs/tui/live-smoke/*.txt. Needs a built CLI (pnpm build) and tmux.
//
// Usage: node packages/tui/scripts/live-smoke.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(PKG, "..", "..");
const CLI = join(REPO, "apps", "cli", "dist", "reflex.js");
const OUT = join(REPO, "docs", "tui", "live-smoke");
const VIEWS = ["dashboard", "morning", "tokens", "skills", "workflows", "router", "search"];
const SOCK = `reflex-smoke-${process.pid}`;

if (!existsSync(CLI)) {
  console.error(`missing ${CLI}; run pnpm build first`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "reflex-live-smoke-"));
// Everything lives under a temp HOME, so screens show "~/..." display paths.
const home = join(root, "home");
const env = {
  HOME: home,
  REFLEX_HOME: join(home, ".reflex"),
  REFLEX_CLAUDE_DIR: join(home, "history", "claude", "projects"),
  REFLEX_CODEX_DIR: join(home, "history", "codex", "sessions"),
  REFLEX_CURSOR_DIR: join(home, "history", "cursor", "projects"),
  REFLEX_CLAUDE_SKILLS_DIR: join(home, ".claude", "skills"),
  REFLEX_CODEX_SKILLS_DIR: join(home, ".codex", "skills"),
  REFLEX_CURSOR_SKILLS_DIR: join(home, ".cursor", "skills"),
};
for (const d of Object.values(env)) mkdirSync(d, { recursive: true });
const childEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "xterm-256color", LANG: "en_US.UTF-8", ...env };

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const tmux = (...args) => run("tmux", ["-L", SOCK, ...args]);
const capture = () => tmux("capture-pane", "-p", "-t", "v");
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(pred, what, ms = 15000) {
  const end = Date.now() + ms;
  let last = "";
  let stable = 0;
  while (Date.now() < end) {
    const cur = capture();
    if (pred(cur) && cur === last) {
      if (++stable >= 2) return cur;
    } else stable = 0;
    last = cur;
    pause(80);
  }
  throw new Error(`timed out waiting for ${what}; last screen:\n${last}`);
}
const save = (name, text) => writeFileSync(join(OUT, name), text.replace(/[ ]+$/gm, ""));
const files = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith("SKILL.md")).map(String).sort() : []);
const targetFiles = () => ["claude", "codex", "cursor"].flatMap((t) => files(join(home, `.${t}`, "skills")).map((f) => `~/.${t}/skills/${f}`));
const log = [];
const check = (ok, msg) => {
  log.push(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) process.exitCode = 1;
};

function startShell(W, H) {
  const envArgs = Object.entries(childEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "v", "-x", String(W), "-y", String(H), ...envArgs, "/bin/sh");
  tmux("set", "-g", "status", "off");
  tmux("set", "-g", "escape-time", "0");
  tmux("send-keys", "-t", "v", `PS1='smoke$ '; cd ${JSON.stringify(root)}; clear`, "Enter");
  waitFor((s) => s.includes("smoke$"), "shell prompt");
}
function startTui() {
  tmux("send-keys", "-t", "v", `node ${JSON.stringify(CLI)} tui`, "Enter");
  return waitFor((s) => s.split("\n")[0].includes("Reflex AI"), "tui first frame");
}
function quitAndCheckShell(label) {
  tmux("send-keys", "-t", "v", "q");
  waitFor((s) => s.includes("smoke$") && !s.split("\n")[0].includes("Reflex AI"), "shell after q");
  tmux("send-keys", "-t", "v", "clear; stty -a | tr ' ' '\\n' | grep -E '^-?(icanon|echo|isig)$' | tr '\\n' ' '; echo SANE", "Enter");
  const s = waitFor((x) => /SANE\s*$/m.test(x) && /icanon/.test(x), "stty output");
  const line = s.split("\n").find((l) => l.includes("icanon")) ?? "";
  check(/(^|\s)icanon/.test(line) && /(^|\s)echo(\s|$)/.test(line) && /(^|\s)isig/.test(line), `${label}: q returns to a sane shell (stty: ${line.trim()})`);
}

try {
  // 1. Fresh REFLEX_HOME, before any scan.
  startShell(150, 45);
  save("fresh-150x45.txt", startTui());
  quitAndCheckShell("fresh 150x45");
  tmux("kill-server");

  // 2. Fixture history and a scan.
  run("npx", ["tsup", "--config", "tsup.preview.config.ts", "--silent"], { cwd: PKG });
  const h = JSON.parse(run(process.execPath, [join(PKG, "dist", "write-history.js"), join(home, "history")]));
  check(h.files > 0, `wrote ${h.files} fixture transcripts`);
  const scan = run(process.execPath, [CLI, "scan", "--yes", "--days", "30", "--claude-dir", h.claudeRoot, "--codex-dir", h.codexRoot], { env: childEnv });
  writeFileSync(join(OUT, "scan.txt"), scan.replaceAll(home, "~"));
  check(/session/i.test(scan), "scan finished");

  // 3 + 4. The TUI at both sizes.
  for (const [W, H] of [
    [150, 45],
    [120, 40],
  ]) {
    startShell(W, H);
    startTui();
    for (let i = 0; i < VIEWS.length; i++) {
      tmux("send-keys", "-t", "v", String(i));
      const s = waitFor((x) => x.split("\n")[0].includes(`[${i}]`), `view ${i}`);
      save(`${W}x${H}-${i}-${VIEWS[i]}.txt`, s);
      check(!/undefined|NaN|Infinity/.test(s), `${W}x${H} ${VIEWS[i]}: no undefined/NaN/Infinity`);
    }
    if (W === 150) {
      tmux("send-keys", "-t", "v", "3");
      waitFor((x) => x.split("\n")[0].includes("[3]"), "skills");
      const before = targetFiles();
      tmux("send-keys", "-t", "v", "Space");
      const on = waitFor((x) => /installed|approved|kept|skipped|added/.test(x.split("\n").slice(-6).join("\n")), "install toast");
      save(`${W}x${H}-3-skills-after-install.txt`, on);
      const installed = targetFiles();
      check(installed.length > before.length, `space installs: ${before.length} -> ${installed.length} SKILL.md files in temp targets (${installed.join(", ")})`);
      pause(3300); // let the toast clear
      tmux("send-keys", "-t", "v", "Space");
      const off = waitFor((x) => /removed|not installed|kept/.test(x.split("\n").slice(-6).join("\n")), "remove toast");
      save(`${W}x${H}-3-skills-after-remove.txt`, off);
      const after = targetFiles();
      check(after.length === before.length, `space again removes: ${installed.length} -> ${after.length} SKILL.md files`);
    }
    quitAndCheckShell(`${W}x${H}`);
    tmux("kill-server");
  }
} catch (err) {
  check(false, String(err?.message ?? err));
} finally {
  try {
    tmux("kill-server");
  } catch {
    // already gone
  }
  writeFileSync(join(OUT, "RESULT.txt"), log.join("\n") + "\n");
  console.log(log.join("\n"));
  if (!process.env.KEEP_SMOKE_TMP) rmSync(root, { recursive: true, force: true });
  else console.log(`kept ${root}`);
}
