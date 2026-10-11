import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "@reflex/storage";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { type DataSource, type TuiData, createLiveSource } from "@reflex/tui";
import { scan } from "../src/commands/scan";
import { rescanArgs, rescanWithCli, tui } from "../src/commands/tui";

// Every location Reflex reads or writes points into a temp folder: history, Reflex's home, install targets and HOME.
const ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "REFLEX_HOME",
  "REFLEX_CLAUDE_DIR",
  "REFLEX_CODEX_DIR",
  "REFLEX_CURSOR_DIR",
  "REFLEX_CLAUDE_SKILLS_DIR",
  "REFLEX_CODEX_SKILLS_DIR",
  "REFLEX_CURSOR_SKILLS_DIR",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

let root: string;
let source: DataSource;
const NOT_SCANNED = "run `reflex scan` first to choose what Reflex may read";
const target = (tool: string, name: string) => join(root, `${tool}-skills`, name, "SKILL.md");
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );
const item = (data: TuiData, name: string) => data.skills.items.find((i) => i.name === name);

function latest() {
  const store = new Store();
  try {
    return { scan: store.latestScan()!, traces: store.traces(), installs: store.installations() };
  } finally {
    store.close();
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "reflex-tui-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const h = await writeFixtureHistory(join(root, "history"));
  delete process.env.CODEX_HOME;
  Object.assign(process.env, {
    HOME: join(root, "user"),
    REFLEX_HOME: join(root, "reflex"),
    REFLEX_CLAUDE_DIR: h.claudeRoot,
    REFLEX_CODEX_DIR: h.codexRoot,
    REFLEX_CURSOR_DIR: join(root, "history", "cursor"),
    REFLEX_CLAUDE_SKILLS_DIR: join(root, "claude-skills"),
    REFLEX_CODEX_SKILLS_DIR: join(root, "codex-skills"),
    REFLEX_CURSOR_SKILLS_DIR: join(root, "cursor-skills"),
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  source = createLiveSource();
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(root, { recursive: true, force: true });
});

describe("reflex tui on fixture history", () => {
  it("shows an honest empty state before the first scan", async () => {
    const data = await source.load();
    expect(data.scannedAt).toBeUndefined();
    expect(data.sessions).toBe(0);
    expect(data.tools).toEqual([]);
    expect(data.reads).toEqual([]);
    expect(data.skills.items).toEqual([]);
    expect(data.attention).toEqual([]);
    expect(data.activeDirs).toHaveLength(3);
    expect(await source.rescan()).toEqual({ ok: false, message: NOT_SCANNED, tone: "dim" });
  });

  it("scan --source codex reads only Codex", async () => {
    await scan({ days: 7, yes: true, source: ["codex"] });
    const { scan: s, traces } = latest();
    expect(Object.keys(s.sources)).toEqual(["codex"]);
    expect(traces.length).toBeGreaterThan(0);
    expect(traces.every((t) => t.source === "codex")).toBe(true);
    const data = await source.load();
    expect(data.tools.map((t) => t.tool)).toEqual(["codex"]);
    // HOME is a different temp folder, so display paths stay absolute here.
    expect(data.reads).toEqual([join(root, "history/codex/sessions")]);
  });

  it("maps the latest scan: sessions, tools, tokens and new skills, and no money", async () => {
    await scan({ days: 7, yes: true });
    const { scan: s, traces } = latest();
    const data = await source.load();

    expect(data.sessions).toBe(s.sessions);
    expect(data.sessions).toBeGreaterThan(0);
    expect(data.scannedAt).toMatch(/^\d\d:\d\d$/);
    expect(data.tools.map((t) => t.tool)).toEqual(["claude", "codex"]);
    expect(data.tools.reduce((a, t) => a + t.sessions, 0)).toBe(s.sessions);
    expect(data.tools.every((t) => t.sessions > 0 && t.usd === undefined)).toBe(true);
    expect(data.reads).toEqual([join(root, "history/claude/projects"), join(root, "history/codex/sessions")]);

    const sum = (k: "input" | "output" | "cacheRead" | "cacheWrite") =>
      [...new Map(traces.map((t) => [t.sessionId, t])).values()].reduce((a, t) => a + (t.usage?.[k] ?? 0), 0);
    expect(data.window).toMatchObject({ days: 7, sessions: s.sessions });
    expect(data.window!.range).toMatch(/^\d\d [a-z]{3} – \d\d [a-z]{3}$/);
    expect(data.window!.tokens).toEqual({ input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") });
    expect(data.window!.tokens.cacheRead).toBeGreaterThan(0);
    expect(data.days!.length).toBeGreaterThanOrEqual(7);
    expect(data.days!.every((d) => /^\d\d [A-Z][a-z]{2}$/.test(d.label) && d.usd === undefined && d.byTool === undefined)).toBe(true);
    expect(data.days!.reduce((a, d) => a + (d.tokens ?? 0), 0)).toBeGreaterThan(0);
    expect(data.yesterday?.label).toMatch(/^[a-z]{3} \d\d [a-z]{3}$/);
    expect(data.yesterday?.byTool).toBeUndefined();

    const fresh = data.skills.items.filter((i) => i.state === "new");
    expect(fresh.map((i) => i.name).sort()).toEqual(["debug-dependency", "fix-ci", "review-pr"]);
    for (const i of fresh) {
      expect(i.on).toBe(false);
      expect(i.support).toBeGreaterThanOrEqual(3);
      expect(i.steps).toBeGreaterThan(0);
      expect(i.markdown[0]).toBe("---");
      expect(i.markdown).toContain(`name: ${i.name}`);
      expect(i.path).toBe(join(root, "claude-skills", i.name, "SKILL.md"));
    }
    expect(data.skills.targets).toEqual(["claude", "codex", "cursor"].map((t) => `${join(root, `${t}-skills`)}/<name>/SKILL.md`));
    expect(data.attention).toEqual([{ tone: "ok", text: "3 new skills to review", view: "skills" }]);

    for (const k of ["money", "limits", "plansFile", "topPrompts", "topSessions", "workflows", "router", "search"] as const) expect(data[k]).toBeUndefined();
    expect(JSON.stringify(data)).not.toMatch(/usd/i);
    // Pending previews are generated in memory only.
    expect(await exists(join(root, "reflex", "skills"))).toBe(false);
  });

  it("toggling a new skill on approves it and installs it into every detected target", async () => {
    expect(await source.toggleItem("skills", "fix-ci", true)).toEqual({ ok: true, message: "installed fix-ci", tone: "ok" });
    const reflexCopy = await readFile(join(root, "reflex", "skills", "fix-ci", "SKILL.md"), "utf8");
    for (const t of ["claude", "codex", "cursor"]) expect(await readFile(target(t, "fix-ci"), "utf8")).toBe(reflexCopy);
    expect(latest().installs.filter((r) => r.skill === "fix-ci")).toHaveLength(3);
    const data = await source.load();
    expect(item(data, "fix-ci")).toMatchObject({ on: true, state: "" });
    expect(item(data, "fix-ci")!.markdown.join("\n")).toBe(reflexCopy.trimEnd());
    expect(data.attention).toEqual([{ tone: "ok", text: "2 new skills to review", view: "skills" }]);
  });

  it("skips a target where a different skill has the name, and records an identical copy as installed", async () => {
    const generated = item(await source.load(), "review-pr")!.markdown.join("\n") + "\n";
    await mkdir(join(root, "codex-skills", "review-pr"), { recursive: true });
    await writeFile(target("codex", "review-pr"), "my own review-pr skill\n");
    await mkdir(join(root, "cursor-skills", "review-pr"), { recursive: true });
    await writeFile(target("cursor", "review-pr"), generated);
    const r = await source.toggleItem("skills", "review-pr", true);
    expect(r).toEqual({ ok: true, message: "installed review-pr · skipped codex (a different skill exists)", tone: "warn" });
    expect(await readFile(target("codex", "review-pr"), "utf8")).toBe("my own review-pr skill\n");
    expect(await readFile(target("cursor", "review-pr"), "utf8")).toBe(generated);
    expect(await readFile(target("claude", "review-pr"), "utf8")).toBe(generated);
    expect(latest().installs.filter((i) => i.skill === "review-pr").map((i) => i.target).sort()).toEqual(["claude-code", "cursor"]);
  });

  it("toggling an installed skill off removes only the unchanged files Reflex wrote", async () => {
    expect(await source.toggleItem("skills", "fix-ci", false)).toEqual({ ok: true, message: "removed fix-ci", tone: "dim" });
    for (const t of ["claude", "codex", "cursor"]) expect(await exists(join(root, `${t}-skills`, "fix-ci"))).toBe(false);
    expect(latest().installs.filter((r) => r.skill === "fix-ci")).toEqual([]);
    expect(item(await source.load(), "fix-ci")).toMatchObject({ on: false, state: "" });
  });

  it("keeps a copy edited since install, with its record", async () => {
    expect((await source.toggleItem("skills", "fix-ci", true)).message).toBe("installed fix-ci");
    const edited = (await readFile(target("claude", "fix-ci"), "utf8")) + "\nmy own notes\n";
    await writeFile(target("claude", "fix-ci"), edited);
    expect(await source.toggleItem("skills", "fix-ci", false)).toEqual({ ok: false, message: "kept fix-ci in claude: edited since install", tone: "warn" });
    expect(await readFile(target("claude", "fix-ci"), "utf8")).toBe(edited);
    expect(await exists(target("codex", "fix-ci"))).toBe(false);
    expect(latest().installs.filter((r) => r.skill === "fix-ci").map((r) => r.target)).toEqual(["claude-code"]);
    expect(item(await source.load(), "fix-ci")!.on).toBe(true);
  });

  it("answers unavailable features plainly", async () => {
    expect(await source.toggleItem("workflows", "fix-ci", true)).toEqual({ ok: false, message: "workflows are not available yet", tone: "dim" });
    expect(await source.setAutopilot(true)).toEqual({ ok: false, message: "the router is not available yet", tone: "dim" });
    expect(source.resume("claude-code:abc", 3)).toEqual({ ok: false, message: "search is not available yet", tone: "dim" });
    expect(await source.rescan()).toEqual({ ok: false, message: NOT_SCANNED, tone: "dim" });
    const rescan = vi.fn(async () => ({ ok: true, message: "rescanned: 1 sessions, 0 new", tone: "ok" as const }));
    expect((await createLiveSource({ rescan }).rescan()).message).toBe("rescanned: 1 sessions, 0 new");
    expect(rescan).toHaveBeenCalledOnce();
  });

  it("rescans by running the CLI again with the latest scan's window and sources", async () => {
    const s = latest().scan;
    expect(rescanArgs("reflex.js", s)).toEqual(["reflex.js", "scan", "--yes", "--days", "7", "--source", "claude-code", "--source", "codex"]);
    expect(rescanArgs("reflex.js", { ...s, mode: "custom" })).toBeUndefined();
    expect(rescanArgs("reflex.js", { ...s, sources: {} })).toBeUndefined();

    // A stand-in for the CLI that records its arguments: no shell, fixed argv, nothing read.
    const script = join(root, "fake-reflex.mjs");
    await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
    const r = await rescanWithCli(script);
    expect(JSON.parse(await readFile(join(root, "argv.json"), "utf8"))).toEqual(["scan", "--yes", "--days", "7", "--source", "claude-code", "--source", "codex"]);
    expect(r).toEqual({ ok: true, message: `rescanned: ${s.sessions.toLocaleString("en-US")} sessions, 0 new`, tone: "ok", sessions: s.sessions, added: 0 });

    await writeFile(script, "process.exit(3);\n");
    expect((await rescanWithCli(script)).tone).toBe("bad");
  });

  it("refuses to start without a terminal", async () => {
    await expect(tui()).rejects.toThrow("reflex tui needs an interactive terminal");
  });
});
