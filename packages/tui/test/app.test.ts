import { afterEach, describe, expect, it, vi } from "vitest";
import { designData, designUi } from "../fixture/design";
import { liveShapeData } from "../fixture/live-shape";
import { FixtureSource } from "../fixture/source";
import type { TuiData } from "../src/model";
import { runTui, tooSmall, type Screen } from "../src/app/app";
import { UNAVAILABLE, clampUi, initialUi, reduce, searchHits, type AppEvent, type Effect } from "../src/app/state";
import { compose } from "../src/shell";
import type { InputEvent } from "../src/term/input";
import {
  VIEW_ORDER,
  type ActionResult,
  type DataSource,
  type Frame,
  type Hit,
  type HitAction,
  type RescanResult,
  type ResumeCommand,
  type Row,
  type UiState,
  type ViewId,
} from "../src/types";

// ---- event helpers --------------------------------------------------------------------------------

const key = (name: string, ch?: string): AppEvent => ({ type: "key", name, ...(ch === undefined ? {} : { ch }) }) as AppEvent;
/** A printable key. */
const ch = (c: string): AppEvent => key(c === " " ? "space" : "char", c);
const CTRL_C = key("ctrl-c");
const mouseAt = (action: string, x: number, y: number, button = 0): AppEvent => ({ type: "mouse", action, button, x, y }) as AppEvent;
const paste = (text: string): AppEvent => ({ type: "paste", text }) as AppEvent;

function run(ui: UiState, events: AppEvent[], data: TuiData = designData(), w = 150, h = 45): { ui: UiState; effects: Effect[] } {
  let effects: Effect[] = [];
  for (const ev of events) {
    const r = reduce(ui, ev, { data, w, h, frame: compose(w, h, data, ui) });
    ui = r.ui;
    effects = effects.concat(r.effects);
  }
  return { ui, effects };
}
const at = (view: ViewId, over: Partial<UiState> = {}): UiState => ({ ...initialUi(view, "08:14:07"), ...over });
const findHit = (f: Frame, pred: (a: HitAction) => boolean): Hit => {
  const h = f.hits.find((x) => pred(x.action));
  if (!h) throw new Error("no such hit");
  return h;
};
const text = (rows: Row[], y: number): string => rows[y]!.map((r) => r.t).join("");

// ---- reducer ---------------------------------------------------------------------------------------

describe("reduce: views", () => {
  it("0-6 switch views and mark them seen", () => {
    let ui = at("dashboard");
    expect(ui.seen).toEqual(["dashboard"]);
    VIEW_ORDER.forEach((v, i) => {
      ui = run(ui, [ch(String(i))]).ui;
      expect(ui.view).toBe(v);
      expect(ui.seen).toContain(v);
    });
    expect([...ui.seen].sort()).toEqual([...VIEW_ORDER].sort());
    expect(run(ui, [ch("0")]).ui.view).toBe("dashboard");
  });

  it("a view switch resets the preview scroll", () => {
    expect(run(at("skills", { previewScroll: 6 }), [ch("4")]).ui.previewScroll).toBe(0);
  });

  it("other ctrl and alt combinations do nothing", () => {
    const ui = at("skills");
    expect(run(ui, [{ type: "key", name: "char", ch: "j", ctrl: false, alt: true, shift: false }, key("ctrl-l")])).toEqual({ ui, effects: [] });
  });

  it("q and ctrl-c quit", () => {
    expect(run(at("tokens"), [ch("q")]).effects).toEqual([{ type: "quit" }]);
    expect(run(at("tokens"), [CTRL_C]).effects).toEqual([{ type: "quit" }]);
  });

  it("b toggles the sidebar at 150 columns and toasts at 120", () => {
    const wide = run(at("dashboard"), [ch("b")], designData(), 150, 45).ui;
    expect(wide.sidebar).toBe("rail");
    expect(wide.toast).toBeNull();
    expect(run(wide, [ch("b")], designData(), 150, 45).ui.sidebar).toBe("full");
    const narrow = run(at("dashboard"), [ch("b")], designData(), 120, 40).ui;
    expect(narrow.sidebar).toBe("full");
    expect(narrow.toast).toEqual({ msg: "sidebar needs 140+ columns", tone: "dim" });
  });

  it("r starts a rescan once; r while scanning is ignored", () => {
    const a = run(at("dashboard"), [ch("r")]);
    expect(a.ui.scanning).toBe(true);
    expect(a.effects).toEqual([{ type: "rescan" }]);
    const b = run(a.ui, [ch("r")]);
    expect(b.ui).toBe(a.ui);
    expect(b.effects).toEqual([]);
  });
});

describe("reduce: selection", () => {
  const cases: Array<[ViewId, keyof UiState["sel"], number]> = [
    ["skills", "skills", designData().skills.items.length],
    ["workflows", "workflows", designData().workflows!.items.length],
    ["router", "router", designData().router!.tasks.length],
    ["search", "search", designData().search!.query("", "all").length],
  ];
  for (const [view, list, n] of cases) {
    it(`${view}: j/k/up/down move and clamp to 0..${n - 1}`, () => {
      let ui = at(view);
      ui = run(ui, [ch("k"), key("up")]).ui;
      expect(ui.sel[list]).toBe(0);
      ui = run(ui, [ch("j"), key("down")]).ui;
      expect(ui.sel[list]).toBe(2);
      ui = run(ui, Array.from({ length: n + 5 }, () => ch("j"))).ui;
      expect(ui.sel[list]).toBe(n - 1);
      ui = run(ui, [key("up")]).ui;
      expect(ui.sel[list]).toBe(n - 2);
    });
  }

  it("selection keys do nothing on views without a list", () => {
    const ui = at("tokens");
    expect(run(ui, [ch("j"), ch("k"), ch(" "), key("enter")])).toEqual({ ui, effects: [] });
  });

  it("moving resets the preview scroll", () => {
    expect(run(at("skills", { previewScroll: 9 }), [ch("j")]).ui.previewScroll).toBe(0);
  });

  it("clampUi keeps selections in range and follows a selected item by name", () => {
    const d = designData();
    const ui = at("skills", { sel: { skills: 50, workflows: 50, router: 50, search: 50 } });
    expect(clampUi(ui, d).sel).toEqual({ skills: 17, workflows: 8, router: 7, search: 19 });
    const moved = designData();
    moved.skills.items.reverse();
    expect(clampUi(at("skills", { sel: { skills: 3, workflows: 0, router: 0, search: 0 } }), moved, d).sel.skills).toBe(14);
    expect(clampUi(at("skills"), liveShapeData()).sel).toEqual({ skills: 0, workflows: 0, router: 0, search: 0 });
  });
});

describe("reduce: space and enter", () => {
  it("skills and workflows: toggle the selected item", () => {
    const d = designData();
    const s = d.skills.items[3]!;
    expect(run(at("skills", { sel: { skills: 3, workflows: 0, router: 0, search: 0 } }), [ch(" ")]).effects).toEqual([
      { type: "toggle", kind: "skills", name: s.name, on: !s.on },
    ]);
    const w = d.workflows!.items[2]!;
    expect(run(at("workflows", { sel: { skills: 0, workflows: 2, router: 0, search: 0 } }), [key("enter")]).effects).toEqual([
      { type: "toggle", kind: "workflows", name: w.name, on: !w.on },
    ]);
  });

  it("router: autopilot", () => {
    expect(run(at("router"), [ch(" ")]).effects).toEqual([{ type: "autopilot", on: false }]);
    const off = designData();
    off.router!.autopilot = false;
    expect(run(at("router"), [key("enter")], off).effects).toEqual([{ type: "autopilot", on: true }]);
  });

  it("search: resume the selected hit", () => {
    const ui = at("search", { query: "refund", searchQuery: "refund", sel: { skills: 0, workflows: 0, router: 0, search: 2 } });
    const hit = searchHits(designData(), ui)[2]!;
    expect(run(ui, [key("enter")]).effects).toEqual([{ type: "resume", sessionId: hit.session, turn: hit.turn }]);
    const none = at("search", { query: "zzzz", searchQuery: "zzzz" });
    expect(run(none, [key("enter")]).effects).toEqual([]);
  });

  it("unavailable features toast in dim instead of acting", () => {
    const d = liveShapeData();
    const w = run(at("workflows"), [ch(" ")], d);
    expect(w.effects).toEqual([]);
    expect(w.ui.toast).toEqual({ msg: UNAVAILABLE.workflows, tone: "dim" });
    expect(UNAVAILABLE.workflows).toBe("workflows are not available yet");
    const r = run(at("router"), [key("enter")], d);
    expect(r.effects).toEqual([]);
    expect(r.ui.toast).toEqual({ msg: "the router is not available yet", tone: "dim" });
    const s = run(at("dashboard"), [ch("/")], d);
    expect(s.ui.view).toBe("search");
    expect(s.ui.typing).toBe(false);
    expect(s.ui.toast).toEqual({ msg: "search is not available yet", tone: "dim" });
    const e = run(at("search"), [key("enter")], d);
    expect(e.effects).toEqual([]);
    expect(e.ui.toast).toEqual({ msg: "search is not available yet", tone: "dim" });
    expect(run(at("search"), [key("tab")], d).ui.toast?.msg).toBe("search is not available yet");
  });

  it("skills that exist still toggle with the live shape", () => {
    const d = liveShapeData();
    expect(run(at("skills"), [ch(" ")], d).effects).toEqual([{ type: "toggle", kind: "skills", name: "fix-ci", on: false }]);
  });
});

describe("reduce: search typing", () => {
  it("/ goes to Search and types; printable keys, paste and backspace edit the query", () => {
    let r = run(at("dashboard"), [ch("/")]);
    expect(r.ui.view).toBe("search");
    expect(r.ui.typing).toBe(true);
    expect(r.ui.seen).toContain("search");
    r = run(r.ui, [ch("r"), ch("e"), ch("f"), ch("q"), ch("1"), ch("/"), ch(" "), ch("j")]);
    expect(r.ui.query).toBe("refq1/ j");
    expect(r.ui.view).toBe("search");
    expect(r.effects.every((e) => e.type === "debounce")).toBe(true);
    expect(r.effects).toHaveLength(8);
    r = run(r.ui, [key("backspace"), key("backspace")]);
    expect(r.ui.query).toBe("refq1/");
    const ESC = String.fromCharCode(27);
    r = run(r.ui, [paste(`a\nb${ESC}[2Jc\tz`)]);
    expect(r.ui.query).toBe("refq1/a b[2Jc z");
    expect(r.effects).toEqual([{ type: "debounce" }]);
  });

  it("query edits reset the selection; the debounce event applies the query", () => {
    let ui = at("search", { typing: true, sel: { skills: 0, workflows: 0, router: 0, search: 4 } });
    ui = run(ui, [ch("r")]).ui;
    expect(ui.sel.search).toBe(0);
    expect(ui.searchQuery).toBe("");
    ui = run(ui, [ch("e"), ch("f"), ch("u")]).ui;
    ui = run(ui, [{ type: "query" }]).ui;
    expect(ui.searchQuery).toBe("refu");
    expect(searchHits(designData(), ui).length).toBeGreaterThan(0);
  });

  it("arrows move while typing; tab is ignored; enter and esc leave typing; ctrl-c quits", () => {
    const ui = at("search", { typing: true });
    expect(run(ui, [key("down"), key("down"), key("up")]).ui.sel.search).toBe(1);
    expect(run(ui, [key("tab")]).ui).toBe(ui);
    expect(run(ui, [key("enter")]).ui.typing).toBe(false);
    expect(run(ui, [key("enter")]).effects).toEqual([]);
    expect(run(ui, [key("escape")]).ui.typing).toBe(false);
    expect(run(ui, [CTRL_C]).effects).toEqual([{ type: "quit" }]);
    expect(run(ui, [ch("q")]).effects).toEqual([{ type: "debounce" }]);
  });

  it("paste outside typing is ignored", () => {
    const ui = at("search");
    expect(run(ui, [paste("hello")]).ui).toBe(ui);
  });

  it("tab cycles the tool filter on Search and resets the selection", () => {
    let ui = at("search", { sel: { skills: 0, workflows: 0, router: 0, search: 3 }, previewScroll: 3 });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      ui = run(ui, [key("tab")]).ui;
      seen.push(ui.tool);
      expect(ui.sel.search).toBe(0);
      expect(ui.previewScroll).toBe(0);
    }
    expect(seen).toEqual(["claude", "codex", "cursor", "all"]);
    const other = at("skills");
    expect(run(other, [key("tab")]).ui).toBe(other);
  });
});

describe("reduce: mouse", () => {
  it("clicking a sidebar item switches the view", () => {
    const ui = designUi("dashboard");
    const f = compose(150, 45, designData(), ui);
    const h = findHit(f, (a) => a.type === "view" && a.view === "tokens");
    const r = reduce(ui, mouseAt("press", h.x0 + 1, h.y0), { data: designData(), w: 150, h: 45, frame: f });
    expect(r.ui.view).toBe("tokens");
    expect(r.ui.seen).toContain("tokens");
  });

  it("clicking a list row selects it; on Search it also leaves typing", () => {
    const d = designData();
    const ui = designUi("skills");
    const f = compose(150, 45, d, ui);
    const h = findHit(f, (a) => a.type === "select" && a.index === 7);
    expect(reduce(ui, mouseAt("press", h.x0 + 2, h.y0), { data: d, w: 150, h: 45, frame: f }).ui.sel.skills).toBe(7);
    // Only the left button selects.
    expect(reduce(ui, mouseAt("press", h.x0 + 2, h.y0, 2), { data: d, w: 150, h: 45, frame: f }).ui).toBe(ui);

    const su = { ...designUi("search"), typing: true };
    const sf = compose(120, 40, d, su);
    const sh = findHit(sf, (a) => a.type === "select" && a.list === "search" && a.index === 1);
    const r = reduce(su, mouseAt("press", sh.x0 + 1, sh.y0), { data: d, w: 120, h: 40, frame: sf });
    expect(r.ui.sel.search).toBe(1);
    expect(r.ui.typing).toBe(false);
  });

  it("the wheel scrolls the preview pane and stops at its end", () => {
    const d = designData();
    // 100 lines in a box with 38 inner rows (150x45): the largest useful offset is 62.
    d.skills.items[3]!.markdown = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    let ui = designUi("skills");
    const f = compose(150, 45, d, ui);
    const p = findHit(f, (a) => a.type === "scroll");
    const wheel = (dir: "wheelup" | "wheeldown"): void => {
      ui = reduce(ui, mouseAt(dir, p.x0 + 3, p.y0 + 3), { data: d, w: 150, h: 45, frame: compose(150, 45, d, ui) }).ui;
    };
    wheel("wheeldown");
    expect(ui.previewScroll).toBe(3);
    expect(text(compose(150, 45, d, ui).rows, p.y0 + 1)).not.toBe(text(f.rows, p.y0 + 1));
    for (let i = 0; i < 40; i++) wheel("wheeldown");
    const end = ui.previewScroll;
    expect(end).toBeGreaterThanOrEqual(62);
    expect(end).toBeLessThanOrEqual(64);
    expect(text(compose(150, 45, d, ui).rows, p.y0 + 38)).toContain("line 99");
    wheel("wheeldown");
    expect(ui.previewScroll).toBe(end);
    for (let i = 0; i < 40; i++) wheel("wheelup");
    expect(ui.previewScroll).toBe(0);
    // A wheel outside the preview does nothing.
    const list = findHit(f, (a) => a.type === "select");
    expect(reduce(ui, mouseAt("wheeldown", list.x0 + 1, list.y0), { data: d, w: 150, h: 45, frame: f }).ui).toBe(ui);
  });
});

// ---- the fixture source ------------------------------------------------------------------------------

describe("FixtureSource", () => {
  it("simulates the prototype's actions", async () => {
    const src = new FixtureSource({ rescanMs: 0 });
    const d0 = await src.load();
    const s = d0.skills.items[2]!;
    expect(await src.toggleItem("skills", s.name, true)).toEqual({ ok: true, message: `installed ${s.name}`, tone: "ok" });
    expect((await src.load()).skills.items[2]!.on).toBe(true);
    const w = d0.workflows!.items[0]!;
    expect(await src.toggleItem("workflows", w.name, false)).toEqual({ ok: true, message: `removed wf-${w.name}`, tone: "dim" });
    expect(await src.setAutopilot(false)).toEqual({ ok: true, message: "autopilot off", tone: "dim" });
    expect((await src.load()).router!.autopilot).toBe(false);
    expect((await src.setAutopilot(true)).message).toBe("autopilot on");
    expect(await src.rescan()).toMatchObject({ message: "rescanned: 1,291 sessions, 7 new", tone: "ok", sessions: 1291, added: 7 });
    expect(await src.rescan()).toMatchObject({ message: "rescanned: 1,291 sessions, 0 new", added: 0 });
    expect((await src.load()).sessions).toBe(1291);
    expect(src.resume("a41f", 41)).toEqual({ ok: true, message: "claude --resume a41f at turn 41", tone: "ok" });
    expect(src.resume("f02d", 6)).toEqual({ ok: true, message: "cursor-agent --resume f02d at turn 6", tone: "ok" });
  });
});

// ---- runTui ---------------------------------------------------------------------------------------------

class FakeTerminal implements Screen {
  frames: Row[][] = [];
  log: string[] = [];
  private input: ((ev: InputEvent) => void) | undefined;
  private resized: (() => void) | undefined;
  constructor(
    public w = 150,
    public h = 45,
  ) {}
  start(): void {
    this.log.push("start");
  }
  stop(): void {
    this.log.push("stop");
  }
  onInput(cb: (ev: InputEvent) => void): () => void {
    this.input = cb;
    return () => (this.input = undefined);
  }
  onResize(cb: (size: { w: number; h: number }) => void): () => void {
    this.resized = () => cb(this.size());
    return () => (this.resized = undefined);
  }
  size(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }
  render(rows: Row[]): void {
    this.frames.push(rows);
  }
  invalidate(): void {
    this.log.push("invalidate");
  }
  suspend<T>(fn: () => T): T {
    this.log.push("suspend");
    const r = fn();
    this.log.push("resume");
    return r;
  }
  send(ev: AppEvent): void {
    this.input?.(ev as InputEvent);
  }
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.resized?.();
  }
  get last(): Row[] {
    return this.frames[this.frames.length - 1]!;
  }
  screen(): string[] {
    return this.last.map((r) => r.map((x) => x.t).join(""));
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A data source whose actions resolve when the test says so. */
class FakeSource implements DataSource {
  data = designData();
  calls: string[] = [];
  pending: Array<() => void> = [];
  async load(): Promise<TuiData> {
    this.calls.push("load");
    return this.data;
  }
  toggleItem(kind: "skills" | "workflows", name: string, on: boolean): Promise<ActionResult> {
    this.calls.push(`toggle ${kind} ${name} ${on}`);
    return new Promise((resolve) =>
      this.pending.push(() => {
        const x = this.data[kind]!.items.find((i) => i.name === name)!;
        this.data = { ...this.data };
        x.on = on;
        resolve({ ok: true, message: `${on ? "installed" : "removed"} ${name}`, tone: on ? "ok" : "dim" });
      }),
    );
  }
  async setAutopilot(on: boolean): Promise<ActionResult> {
    this.calls.push(`autopilot ${on}`);
    this.data.router!.autopilot = on;
    return { ok: true, message: `autopilot ${on ? "on" : "off"}`, tone: on ? "ok" : "dim" };
  }
  rescan(): Promise<RescanResult> {
    this.calls.push("rescan");
    return new Promise((resolve) =>
      this.pending.push(() => {
        this.data = { ...this.data, sessions: this.data.sessions + 2 };
        resolve({ ok: true, message: "rescanned: 1,286 sessions, 2 new", tone: "ok", sessions: 1286, added: 2 });
      }),
    );
  }
  resume(sessionId: string, turn: number): ResumeCommand | ActionResult {
    this.calls.push(`resume ${sessionId} ${turn}`);
    return { cmd: process.execPath, args: ["-e", ""] };
  }
  settle(): void {
    this.pending.splice(0).forEach((f) => f());
  }
}

describe("runTui", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders, switches views on keys and quits", async () => {
    const term = new FakeTerminal();
    const done = runTui({ source: new FixtureSource(), terminal: term, clock: "08:14:07" });
    await flush();
    expect(term.log[0]).toBe("start");
    const ui0 = initialUi("dashboard", "08:14:07");
    expect(term.last).toEqual(compose(150, 45, designData(), ui0).rows);
    expect(term.screen()[0]).toContain(" ◆ Reflex AI ");
    expect(term.screen()[0]).toContain("08:14:07");
    term.send(ch("1"));
    await flush();
    expect(term.screen()[0]).toContain("morning");
    term.send(ch("q"));
    await done;
    expect(term.log).toContain("stop");
  });

  it("coalesces renders and redraws on resize, with a notice below 80x24", async () => {
    const term = new FakeTerminal(120, 40);
    const done = runTui({ source: new FixtureSource(), terminal: term, clock: "08:14:07", initialView: "skills" });
    await flush();
    const n = term.frames.length;
    term.send(ch("j"));
    term.send(ch("j"));
    term.send(ch("j"));
    await flush();
    expect(term.frames.length).toBe(n + 1);
    term.resize(70, 20);
    await flush();
    expect(term.last).toEqual(tooSmall(70, 20).rows);
    expect(term.screen()[10]!.trim()).toBe("Reflex AI needs at least 80×24 (now 70×20)");
    expect(term.last.every((r) => r.reduce((a, x) => a + x.t.length, 0) === 70)).toBe(true);
    term.resize(150, 45);
    await flush();
    expect(term.screen()[0]).toContain("skills");
    term.send(CTRL_C);
    await done;
  });

  it("toasts expire after 3 s", async () => {
    vi.useFakeTimers();
    const term = new FakeTerminal(120, 40);
    const done = runTui({ source: new FixtureSource(), terminal: term, clock: "08:14:07" });
    await vi.advanceTimersByTimeAsync(0);
    term.send(ch("b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(term.screen()[36]).toContain("sidebar needs 140+ columns");
    await vi.advanceTimersByTimeAsync(2900);
    expect(term.screen()[36]).toContain("sidebar needs 140+ columns");
    await vi.advanceTimersByTimeAsync(200);
    expect(term.screen()[36]).not.toContain("sidebar needs 140+ columns");
    term.send(ch("q"));
    await done;
  });

  it("the clock ticks every second unless frozen", async () => {
    vi.useFakeTimers();
    let t = new Date(2026, 9, 11, 8, 14, 7);
    const term = new FakeTerminal();
    const done = runTui({ source: new FixtureSource(), terminal: term, now: () => t });
    await vi.advanceTimersByTimeAsync(0);
    expect(term.screen()[0]).toContain("08:14:07");
    t = new Date(2026, 9, 11, 8, 14, 8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(term.screen()[0]).toContain("08:14:08");
    term.send(ch("q"));
    await done;
  });

  it("rescans without blocking the screen, then reloads and toasts", async () => {
    const term = new FakeTerminal();
    const src = new FakeSource();
    const done = runTui({ source: src, terminal: term, clock: "08:14:07" });
    await flush();
    term.send(ch("r"));
    await flush();
    expect(term.screen()[0]).toContain("rescanning…");
    term.send(ch("r"));
    term.send(ch("2"));
    await flush();
    expect(src.calls.filter((c) => c === "rescan")).toHaveLength(1);
    expect(term.screen()[0]).toContain("tokens");
    src.settle();
    await flush();
    expect(term.screen()[0]).not.toContain("rescanning…");
    expect(term.screen()[0]).toContain("scanned 08:02");
    expect(term.screen()[41]).toContain("rescanned: 1,286 sessions, 2 new");
    expect(src.calls.filter((c) => c === "load")).toHaveLength(2);
    term.send(ch("q"));
    await done;
  });

  it("toggles through the source, reloads and toasts its message", async () => {
    const term = new FakeTerminal();
    const src = new FakeSource();
    const name = src.data.skills.items[0]!.name;
    const done = runTui({ source: src, terminal: term, clock: "08:14:07", initialView: "skills" });
    await flush();
    term.send(ch(" "));
    await flush();
    expect(src.calls).toContain(`toggle skills ${name} false`);
    src.settle();
    await flush();
    expect(term.screen()[41]).toContain(`removed ${name}`);
    term.send(ch("5"));
    term.send(key("enter"));
    await flush();
    expect(src.calls).toContain("autopilot false");
    expect(term.screen()[41]).toContain("autopilot off");
    term.send(ch("q"));
    await done;
  });

  it("resumes a session in its own CLI with the terminal suspended", async () => {
    const term = new FakeTerminal();
    const src = new FakeSource();
    const done = runTui({ source: src, terminal: term, clock: "08:14:07", initialView: "search" });
    await flush();
    term.send(key("enter"));
    await flush();
    expect(src.calls.some((c) => c.startsWith("resume "))).toBe(true);
    expect(term.log).toEqual(expect.arrayContaining(["suspend", "resume", "invalidate"]));
    term.send(ch("q"));
    await done;
  });

  it("restores the terminal before rethrowing a failure", async () => {
    const term = new FakeTerminal();
    const err = new Error("store is locked");
    const src: DataSource = { ...new FixtureSource(), load: () => Promise.reject(err) } as unknown as DataSource;
    await expect(runTui({ source: src, terminal: term })).rejects.toBe(err);
    expect(term.log).toEqual(["start", "stop"]);
  });
});
