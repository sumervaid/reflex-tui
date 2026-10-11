import { appendFile, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptAdapter, WorkflowTrace } from "@reflex/core";
import { ClaudeCodeAdapter, CodexAdapter } from "@reflex/adapters";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { Store } from "@reflex/storage";
import { type CacheKeys, collect } from "../src/collect";
import { scan } from "../src/commands/scan";

const KEYS: CacheKeys = { codeKey: "build-a", redactionKey: "user-a" };
let root: string;
let claudeRoot: string;
let codexRoot: string;
let now: Date;

async function claudeFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await readdir(claudeRoot)) for (const f of await readdir(join(claudeRoot, dir))) if (f.endsWith(".jsonl")) out.push(join(claudeRoot, dir, f));
  return out.sort();
}

function run(opts: { days?: number; keys?: CacheKeys; full?: boolean; needsDocument?: (t: WorkflowTrace) => boolean; adapters?: TranscriptAdapter[] } = {}) {
  const store = new Store();
  const adapters = opts.adapters ?? [new ClaudeCodeAdapter(claudeRoot), new CodexAdapter(codexRoot)];
  return collect(adapters, store, { days: opts.days ?? 7, now, keys: opts.keys ?? KEYS, full: opts.full, needsDocument: opts.needsDocument }).finally(() => store.close());
}

const ids = (traces: WorkflowTrace[]) => traces.map((t) => t.sessionId).sort();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-incremental-"));
  process.env.REFLEX_HOME = join(root, "home");
  now = new Date();
  const h = await writeFixtureHistory(join(root, "history"), now);
  claudeRoot = h.claudeRoot;
  codexRoot = h.codexRoot;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("incremental scan", () => {
  it("reads every file once, then reuses all of them without opening any", async () => {
    const first = await run();
    expect(first.read).toBeGreaterThan(0);
    expect(first.reused).toBe(0);
    const second = await run();
    expect(second.read).toBe(0);
    expect(second.reused).toBe(first.read);
    expect(ids(second.traces)).toEqual(ids(first.traces));
    expect(second.documents.size).toBe(0);
  });

  it("re-reads only a file that grew", async () => {
    const first = await run();
    const [file] = await claudeFiles();
    const last = (await readFile(file!, "utf8")).trimEnd().split("\n").at(-1)!;
    await appendFile(file!, `${last}\n`);
    const second = await run();
    expect(second.read).toBe(1);
    expect(second.reused).toBe(first.read - 1);
  });

  it("notices a rewrite that kept the same size and modification time", async () => {
    await run();
    const [file] = await claudeFiles();
    const before = await stat(file!);
    const text = await readFile(file!, "utf8");
    await writeFile(file!, text.replace("git status", "git stash!"));
    await utimes(file!, before.atime, before.mtime);
    const after = await stat(file!);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect((await run()).read).toBe(1);
  });

  it("re-reads everything after Reflex itself changes, or with --full", async () => {
    const first = await run();
    expect((await run({ keys: { ...KEYS, codeKey: "build-b" } })).read).toBe(first.read);
    expect((await run({ keys: { ...KEYS, codeKey: "build-b" }, full: true })).read).toBe(first.read);
  });

  it("serves a different --days window from the same cached reads", async () => {
    const week = await run({ days: 7 });
    const twoDays = await run({ days: 2 });
    expect(twoDays.read).toBe(0);
    expect(twoDays.traces.length).toBeLessThan(week.traces.length);
    const again = await run({ days: 7 });
    expect(again.read).toBe(0);
    expect(ids(again.traces)).toEqual(ids(week.traces));
  });

  it("keeps sessions after their transcript is deleted, inside the window only", async () => {
    await run();
    const files = await claudeFiles();
    const gone = files[0]!;
    const cachedTraces = (() => {
      const store = new Store();
      try {
        return store.fileTraces(gone).map((c) => c.trace);
      } finally {
        store.close();
      }
    })();
    const goneIds = ids(cachedTraces);
    expect(goneIds.length).toBeGreaterThan(0);
    await rm(gone);
    const after = await run();
    expect(after.kept).toBe(goneIds.length);
    for (const id of goneIds) expect(ids(after.traces)).toContain(id);
    const store = new Store();
    try {
      expect(store.cachedFile(gone)?.missing).toBe(true);
    } finally {
      store.close();
    }
    const narrow = await run({ days: 1 });
    const stillIn = (t: WorkflowTrace) => (t.endedAt ?? t.startedAt ?? "") >= new Date(now.getTime() - 864e5).toISOString();
    expect(narrow.kept).toBe(cachedTraces.filter(stillIn).length);
  });

  it("re-redacts kept sessions when redaction inputs change, since their source cannot be re-read", async () => {
    const store = new Store();
    const path = join(claudeRoot, "gone", "session.jsonl");
    try {
      const trace = { sessionId: "kept-1", source: "claude-code", endedAt: now.toISOString(), excerpt: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", intents: [], actionSequence: [] };
      store.saveFile({ path, source: "claude-code", size: 1, mtimeMs: 1, ctimeMs: 1, ino: "1", codeKey: KEYS.codeKey, redactionKey: "old-user", skippedRecords: 0 }, [trace as unknown as WorkflowTrace]);
    } finally {
      store.close();
    }
    const after = await run();
    const kept = after.traces.find((t) => t.sessionId === "kept-1");
    expect(kept?.excerpt).not.toContain("sk-ant-api03");
    const check = new Store();
    try {
      expect(check.fileTraces(path)[0]!.trace.excerpt).not.toContain("sk-ant-api03");
      expect(check.cachedFile(path)?.redactionKey).toBe(KEYS.redactionKey);
    } finally {
      check.close();
    }
  });

  it("never pulls kept sessions from a folder the scan was not pointed at", async () => {
    await run();
    await rm(await claudeFiles().then((f) => f[0]!));
    const otherRoot = join(root, "elsewhere");
    const codexOnly = await run({ adapters: [new ClaudeCodeAdapter(otherRoot), new CodexAdapter(codexRoot)] });
    expect(codexOnly.kept).toBe(0);
    expect(codexOnly.traces.every((t) => t.source === "codex")).toBe(true);
  });

  it("re-reads a cached file when one of its sessions still needs text for an embedding", async () => {
    const first = await run();
    const target = first.traces[0]!;
    const second = await run({ needsDocument: (t) => t.sessionId === target.sessionId });
    expect(second.read).toBe(1);
    expect(second.documents.has(target.sessionId)).toBe(true);
  });
});

describe("scan with the cache", () => {
  it("suggests exactly what a full re-read suggests", async () => {
    const quiet = () => vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const history = { claudeDir: claudeRoot, codexDir: codexRoot, yes: true, days: 7 };
    const snapshot = () => {
      const store = new Store();
      try {
        return { suggestions: store.suggestions().map((s) => s.data), traces: ids(store.traces()) };
      } finally {
        store.close();
      }
    };
    quiet();
    await scan({ ...history, full: true });
    const full = snapshot();
    await scan(history);
    const cached = snapshot();
    expect(cached.traces).toEqual(full.traces);
    expect(JSON.stringify(cached.suggestions)).toBe(JSON.stringify(full.suggestions));
    expect(full.suggestions.length).toBeGreaterThan(0);
  });
});
