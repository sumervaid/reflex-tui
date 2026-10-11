import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_SESSIONS, CORRUPTED_SESSION, VARIANTS } from "./scenarios";
import { cwdFor, fixtureUuid, startFor, toClaudeLines, toCodexLines } from "./serialize";
import type { FixtureSession } from "./types";

export type DemoHistory = {
  claudeRoot: string;
  codexRoot: string;
  files: number;
};

const encodeClaudeDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");
const pad = (n: number) => String(n).padStart(2, "0");

function jsonl(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

async function writeAt(path: string, content: string, mtime: Date): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await utimes(path, mtime, mtime);
}

/**
 * Write demo history in the on-disk layouts Claude Code and Codex use:
 *   <root>/claude/projects/<encoded-cwd>/<session-id>.jsonl
 *   <root>/codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
 * Timestamps are relative to `now` so `--days 7` always sees them.
 */
export async function writeDemoHistory(root: string, now = new Date(), sessions: FixtureSession[] = ALL_SESSIONS): Promise<DemoHistory> {
  const claudeRoot = join(root, "claude", "projects");
  const codexRoot = join(root, "codex", "sessions");
  const rendered = new Map<string, { lines: Record<string, unknown>[]; end: Date; sessionId: string }>();
  let files = 0;

  for (const s of sessions) {
    const start = startFor(s, now);
    const sessionId = fixtureUuid(`session:${s.key}`);
    if (s.source === "claude-code") {
      const out = toClaudeLines(s, start, sessionId);
      rendered.set(s.key, { ...out, sessionId });
      const dir = join(claudeRoot, encodeClaudeDir(cwdFor(s.project)));
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${sessionId}.jsonl`);
      await writeAt(path, jsonl(out.lines), out.end);
      if (s.key === CORRUPTED_SESSION) {
        await appendFile(path, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"te\n');
        await utimes(path, out.end, out.end);
      }
    } else {
      const out = toCodexLines(s, start, sessionId);
      const d = start;
      const dir = join(codexRoot, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
      await mkdir(dir, { recursive: true });
      const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
      await writeAt(join(dir, `rollout-${stamp}-${sessionId}.jsonl`), jsonl(out.lines), out.end);
    }
    files++;
  }

  for (const v of VARIANTS) {
    const original = rendered.get(v.of);
    if (!original) continue;
    if (v.kind === "mirror") {
      const dir = join(claudeRoot, encodeClaudeDir(cwdFor(v.project)));
      await mkdir(dir, { recursive: true });
      await writeAt(join(dir, `${original.sessionId}.jsonl`), jsonl(original.lines), original.end);
    } else {
      const base = sessions.find((s) => s.key === v.of);
      if (!base) continue;
      const resumedId = fixtureUuid(`session:${v.of}:resumed`);
      const replay = original.lines
        .filter((l) => l.type === "user" || l.type === "assistant")
        .map((l) => ({ ...l, sessionId: resumedId }));
      const continued = toClaudeLines(
        { ...base, key: `${v.of}:resumed`, prompt: v.prompt, steps: v.extra, summary: "The e2e suite passes too." },
        new Date(original.end.getTime() + 3600 * 1000),
        resumedId,
      );
      const dir = join(claudeRoot, encodeClaudeDir(cwdFor(base.project)));
      await writeAt(join(dir, `${resumedId}.jsonl`), jsonl([...replay, ...continued.lines]), continued.end);
    }
    files++;
  }

  return { claudeRoot, codexRoot, files };
}
