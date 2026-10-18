import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "@reflex/storage";
import { writeFixtureHistory } from "@reflex/test-fixtures";
import { type DataSource, type TuiData, createLiveSource } from "@reflex/tui";
import { scan } from "../src/commands/scan";
import { failureReason, rescanArgs, rescanWithCli, tui } from "../src/commands/tui";

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

  it("maps the latest scan: sessions, tools, tokens and new skills", async () => {
    await scan({ days: 7, yes: true });
    const { scan: s, traces } = latest();
    const data = await source.load();

    expect(data.sessions).toBe(s.sessions);
    expect(data.sessions).toBeGreaterThan(0);
    expect(data.scannedAt).toMatch(/^\d\d:\d\d$/);
    expect(data.tools.map((t) => t.tool)).toEqual(["claude", "codex"]);
    expect(data.tools.reduce((a, t) => a + t.sessions, 0)).toBe(s.sessions);
    expect(data.tools.every((t) => t.sessions > 0)).toBe(true);
    expect(data.reads).toEqual([join(root, "history/claude/projects"), join(root, "history/codex/sessions")]);

    const sum = (k: "input" | "output" | "cacheRead" | "cacheWrite") =>
      [...new Map(traces.map((t) => [t.sessionId, t])).values()].reduce((a, t) => a + (t.usage?.[k] ?? 0), 0);
    expect(data.window).toMatchObject({ days: 7, sessions: s.sessions });
    expect(data.window!.range).toMatch(/^\d\d [a-z]{3} – \d\d [a-z]{3}$/);
    expect(data.window!.tokens).toEqual({ input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") });
    expect(data.window!.tokens.cacheRead).toBeGreaterThan(0);
    expect(data.days!.length).toBeGreaterThanOrEqual(7);
    expect(data.days!.every((d) => /^\d\d [A-Z][a-z]{2}$/.test(d.label))).toBe(true);
    expect(data.days!.reduce((a, d) => a + (d.tokens ?? 0), 0)).toBeGreaterThan(0);
    expect(data.yesterday?.label).toMatch(/^[a-z]{3} \d\d [a-z]{3}$/);

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
    expect(data.attention.filter((a) => a.view === "skills")).toEqual([{ tone: "ok", text: "3 new skills to review", view: "skills" }]);
    expect(data.memory?.enabled).toBe(false);

    expect(data.limits).toBeUndefined();
    expect(data.plansFile).toBeUndefined();
    // Pending previews are generated in memory only.
    expect(await exists(join(root, "reflex", "skills"))).toBe(false);
  });

  it("prices every session at API list prices for its model", async () => {
    const { traces } = latest();
    const data = await source.load();
    const unique = [...new Map(traces.map((t) => [t.sessionId, t])).values()];
    // $ per million tokens: input, output, cache write, cache read.
    const PRICE = { "claude-code": [2, 10, 2.5, 0.1], codex: [1.25, 10, 1.25, 0.125] } as const;
    const costOf = (t: (typeof unique)[number]) => {
      const [i, o, w, r] = PRICE[t.source as keyof typeof PRICE];
      const u = t.usage!;
      return (u.input * i + u.output * o + u.cacheWrite * w + u.cacheRead * r) / 1e6;
    };
    expect(unique.every((t) => Object.keys(t.usageByModel ?? {}).length === 1)).toBe(true);
    const total = unique.reduce((a, t) => a + costOf(t), 0);
    expect(total).toBeGreaterThan(0);
    expect(data.window!.usd!.total).toBeCloseTo(total, 9);
    expect(data.window!.usd!.uncached).toBeGreaterThan(total);
    expect(data.money!.allTime.usd).toBeCloseTo(total, 9);
    // The daily series ends yesterday; today's sessions count in the totals only.
    const midnight = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const beforeToday = unique.filter((t) => Date.parse(t.startedAt!) < midnight).reduce((a, t) => a + costOf(t), 0);
    expect(data.days!.reduce((a, d) => a + (d.usd ?? 0), 0)).toBeCloseTo(beforeToday, 9);
    expect(data.days!.every((d) => d.byTool !== undefined)).toBe(true);
    const byTool = (src: string) => unique.filter((t) => t.source === src).reduce((a, t) => a + costOf(t), 0);
    expect(data.tools.find((t) => t.tool === "claude")!.usd).toBeCloseTo(byTool("claude-code"), 9);
    expect(data.tools.find((t) => t.tool === "codex")!.usd).toBeCloseTo(byTool("codex"), 9);
    expect(data.window!.byModel!.map((b) => b.name).sort()).toEqual(["claude-sonnet-5-5", "gpt-5-codex"]);
    const top = data.topSessions!;
    expect(top.length).toBeGreaterThan(0);
    expect(top.map((s) => s.usd)).toEqual([...top.map((s) => s.usd)].sort((a, b) => b - a));
    expect(top[0]!.usd).toBeCloseTo(Math.max(...unique.map(costOf)), 9);
    expect(data.topPrompts![0]!.usd).toBe(top[0]!.usd);
  });

  it("builds router suggestions from the models each kind of task ran on", async () => {
    const r = (await source.load()).router!;
    expect(r.autopilot).toBe(false);
    expect(r.sessions).toBeGreaterThan(0);
    expect(r.tasks.length).toBeGreaterThan(0);
    for (const t of r.tasks) {
      expect(t.evidence.reduce((a, e) => a + e.sessions, 0)).toBe(t.sessions);
      expect(t.evidence.map((e) => e.model)).toContain(t.rec);
      expect(t.evidence.every((e) => e.usd > 0 && e.friction >= 0)).toBe(true);
    }
    expect(r.tasks.reduce((a, t) => a + t.sessions, 0)).toBe(r.sessions);
    expect(await source.setAutopilot(true)).toEqual({ ok: true, message: "autopilot on · reflex run starts on the pick", tone: "ok" });
    expect((await source.load()).router!.autopilot).toBe(true);
    expect(await source.setAutopilot(false)).toEqual({ ok: true, message: "autopilot off · reflex run asks first", tone: "dim" });
    expect((await source.load()).router!.autopilot).toBe(false);
  });

  it("lists every workflow the scan found, with the evidence behind its skill", async () => {
    const data = await source.load();
    const wf = data.workflows!;
    expect(wf.runAs).toBeUndefined();
    expect(wf.targets).toEqual(data.skills.targets);
    expect(wf.items.map((i) => i.name).sort()).toEqual(["debug-dependency", "fix-ci", "review-pr"]);
    const ci = wf.items.find((i) => i.name === "fix-ci")!;
    expect(ci).toMatchObject({ on: false, state: "", support: 6 });
    expect(ci.steps).toBeGreaterThan(0);
    expect(ci.markdown[0]).toMatch(/^# /);
    for (const heading of ["## Steps", "## Recurring corrections", "## Sessions"]) expect(ci.markdown).toContain(heading);
    expect(ci.markdown).toContain("- Don't change ci workflow. (2 sessions)");
    expect(ci.markdown.filter((l) => /^- \d\d [A-Z][a-z]{2} {2}(claude|codex) {2}/.test(l))).toHaveLength(6);
  });

  it("searches every scanned session's opening request and steps", async () => {
    const { traces } = latest();
    const data = await source.load();
    const idx = data.search!;
    const unique = new Map(traces.map((t) => [t.sessionId, t]));
    const expected = [...unique.values()].reduce((a, t) => a + (t.excerpt.trim() ? 1 : 0) + t.displaySteps.filter((s) => s.trim()).length, 0);
    expect(idx.indexed).toBe(expected);
    expect(idx.query("", "all")).toHaveLength(expected);

    const hits = idx.query("GITHUB ACTIONS", "all");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.text.toLowerCase().includes("github actions"))).toBe(true);
    expect(hits.some((h) => h.role === "you" && h.turn === 1)).toBe(true);
    expect(idx.query("pnpm", "codex").every((h) => h.tool === "codex")).toBe(true);
    expect(idx.query("zzz-no-such-text", "all")).toEqual([]);

    const ctx = idx.session(hits[0]!.session);
    expect(ctx.turns[0]).toMatchObject({ turn: 1, role: "you" });
    expect(ctx.turns.slice(1).every((t) => t.role === "ai")).toBe(true);
  });

  it("resumes Codex sessions directly and Claude Code sessions in their own folder", async () => {
    const { traces } = latest();
    const idx = (await source.load()).search!;
    const nativeOf = (key: string, src: string) => traces.find((t) => t.source === src && t.sessionId.slice(src.length + 1).startsWith(key))!.sessionId.slice(src.length + 1);

    const codex = idx.query("", "codex")[0]!;
    expect(source.resume(codex.session, 1)).toEqual({ cmd: "codex", args: ["resume", nativeOf(codex.session, "codex")] });

    const claude = idx.query("", "claude")[0]!;
    const id = nativeOf(claude.session, "claude-code");
    // The fixture's folders don't exist on this machine, so Claude cannot be started there.
    expect(source.resume(claude.session, 1)).toEqual({ ok: false, message: `run \`claude --resume ${id}\` in the session's project folder`, tone: "dim" });

    const claudeRoot = process.env.REFLEX_CLAUDE_DIR!;
    for (const dir of await readdir(claudeRoot)) {
      const file = join(claudeRoot, dir, `${id}.jsonl`);
      if (!(await exists(file))) continue;
      const text = await readFile(file, "utf8");
      const cwd = (JSON.parse(text.split("\n").find((l) => l.includes('"cwd"'))!) as { cwd: string }).cwd;
      await writeFile(file, text.replaceAll(JSON.stringify(cwd), JSON.stringify(root)));
    }
    expect(source.resume(claude.session, 1)).toEqual({ cmd: "claude", args: ["--resume", id], cwd: root });
    expect(source.resume("no-such-session", 1)).toEqual({ ok: false, message: "this session cannot be resumed", tone: "dim" });
  });

  it("toggling a new skill on approves it and installs it into every detected target", async () => {
    expect(await source.toggleItem("skills", "fix-ci", true)).toEqual({ ok: true, message: "installed fix-ci", tone: "ok" });
    const reflexCopy = await readFile(join(root, "reflex", "skills", "fix-ci", "SKILL.md"), "utf8");
    for (const t of ["claude", "codex", "cursor"]) expect(await readFile(target(t, "fix-ci"), "utf8")).toBe(reflexCopy);
    expect(latest().installs.filter((r) => r.skill === "fix-ci")).toHaveLength(3);
    const data = await source.load();
    expect(item(data, "fix-ci")).toMatchObject({ on: true, state: "" });
    expect(item(data, "fix-ci")!.markdown.join("\n")).toBe(reflexCopy.trimEnd());
    expect(data.attention.filter((a) => a.view === "skills")).toEqual([{ tone: "ok", text: "2 new skills to review", view: "skills" }]);
    expect(data.memory?.enabled).toBe(false);
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

  it("toggling a workflow installs and removes the skill generated from it", async () => {
    expect(await source.toggleItem("workflows", "debug-dependency", true)).toEqual({ ok: true, message: "installed debug-dependency", tone: "ok" });
    for (const t of ["claude", "codex", "cursor"]) expect(await exists(target(t, "debug-dependency"))).toBe(true);
    let data = await source.load();
    expect(data.workflows!.items.find((i) => i.name === "debug-dependency")!.on).toBe(true);
    expect(item(data, "debug-dependency")!.on).toBe(true);
    expect(await source.toggleItem("workflows", "debug-dependency", false)).toEqual({ ok: true, message: "removed debug-dependency", tone: "dim" });
    data = await source.load();
    expect(data.workflows!.items.find((i) => i.name === "debug-dependency")!.on).toBe(false);
  });

  it("answers unavailable features plainly", async () => {
    expect(await source.rescan()).toEqual({ ok: false, message: NOT_SCANNED, tone: "dim" });
    const rescan = vi.fn(async () => ({ ok: true, message: "rescanned: 1 sessions, 0 new", tone: "ok" as const }));
    expect((await createLiveSource({ rescan }).rescan()).message).toBe("rescanned: 1 sessions, 0 new");
    expect(rescan).toHaveBeenCalledOnce();
  });

  it("rescans by running the CLI again with the latest scan's window and sources", async () => {
    const s = latest().scan;
    expect(rescanArgs("reflex.js", s)).toEqual(["reflex.js", "scan", "--yes", "--days", "7", "--source", "claude-code", "--source", "codex", "--embed-minutes", "1"]);
    expect(rescanArgs("reflex.js", { ...s, mode: "custom" })).toBeUndefined();
    expect(rescanArgs("reflex.js", { ...s, sources: {} })).toBeUndefined();

    // A stand-in for the CLI that records its arguments: no shell, fixed argv, nothing read.
    const script = join(root, "fake-reflex.mjs");
    await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "argv.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
    const r = await rescanWithCli(script);
    expect(JSON.parse(await readFile(join(root, "argv.json"), "utf8"))).toEqual(["scan", "--yes", "--days", "7", "--source", "claude-code", "--source", "codex", "--embed-minutes", "1"]);
    expect(r).toEqual({ ok: true, message: `rescanned: ${s.sessions.toLocaleString("en-US")} sessions, 0 new`, tone: "ok", sessions: s.sessions, added: 0 });

    await writeFile(script, "process.exit(3);\n");
    expect(await rescanWithCli(script)).toEqual({ ok: false, message: "rescan failed; run `reflex scan` to see why", tone: "bad" });
  });

  it("says why a rescan failed, from the end of the scan's error output, redacted", async () => {
    const script = join(root, "fake-reflex.mjs");
    const home = "/home/reflex-test-user";
    await writeFile(
      script,
      `process.stderr.write("(node:1) ExperimentalWarning: SQLite is an experimental feature\\n");
process.stderr.write("✖ Can't open ${home}/.claude/projects: permission denied\\n");
process.exit(1);\n`,
    );
    const r = await rescanWithCli(script);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^rescan failed: Can't open .*\/\.claude\/projects: permission denied$/);
    expect(r.message).not.toContain("reflex-test-user");
  });

  it("stops a rescan that runs past its time limit", async () => {
    const script = join(root, "fake-reflex.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n");
    const started = Date.now();
    expect(await rescanWithCli(script, 300)).toEqual({ ok: false, message: "rescan stopped after 0 min; run `reflex scan` to finish it", tone: "bad" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("keeps a failure reason short and leaves out Node's warnings", () => {
    expect(failureReason("(node:1) ExperimentalWarning: x\n(Use `node --trace-warnings ...`)\n")).toBeUndefined();
    expect(failureReason("! one\n✖ two\n\n")).toBe("two");
    expect(failureReason("x".repeat(400))).toHaveLength(160);
  });

  it("refuses to start without a terminal", async () => {
    await expect(tui()).rejects.toThrow("reflex tui needs an interactive terminal");
  });
});
