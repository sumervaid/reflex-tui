import { describe, expect, it } from "vitest";
import { designData, designUi } from "../fixture/design";
import { emptyData, liveShapeData } from "../fixture/live-shape";
import { attention, compose, sidebarWidth, summaries } from "../src/shell";
import { COLOR, VIEW_ORDER, type Frame, type HitAction, type UiState, type ViewId } from "../src/types";
import { renderItems } from "../src/views/items";
import { SIZES, diffCells, referenceCells, rowCells, viewRegion, type Cell } from "./harness";

const text = (f: Frame, y: number): string => f.rows[y]!.map((r) => r.t).join("");
const cellsOf = (f: Frame): Cell[][] => f.rows.map(rowCells);
const hitAt = (f: Frame, x: number, y: number): HitAction | undefined => f.hits.find((h) => x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1)?.action;
const ui = (view: ViewId, over: Partial<UiState> = {}): UiState => ({ ...designUi(view), ...over });

describe("shell regions match the reference", () => {
  for (const [W, H] of SIZES) {
    for (const view of VIEW_ORDER) {
      it(`${view} ${W}x${H}: top bar, status bar, sidebar`, () => {
        const act = cellsOf(compose(W, H, designData(), designUi(view)));
        const ref = referenceCells(W, H, view);
        expect(act).toHaveLength(H);
        for (const row of act) expect(row).toHaveLength(W);
        const top = diffCells([act[0]!], [ref[0]!]);
        expect(top.count, top.report).toBe(0);
        const bottom = diffCells([act[H - 1]!], [ref[H - 1]!]);
        expect(bottom.count, bottom.report).toBe(0);
        const sw = sidebarWidth(W, designUi(view));
        const cut = (g: Cell[][]): Cell[][] => g.slice(1, H - 1).map((r) => r.slice(0, sw + 1));
        const side = diffCells(cut(act), cut(ref));
        expect(side.count, side.report).toBe(0);
      });
    }
  }
});

describe("sidebar summaries and dots from data", () => {
  it("reproduces the prototype's summaries on the design fixture", () => {
    const s = summaries(designData());
    const t = (v: ViewId): string => s[v].map((x) => x.t).join("");
    expect(t("dashboard")).toBe("opus 83% · today $12.40");
    expect(t("morning")).toBe("$41.27  +32% vs avg");
    expect(t("tokens")).toBe("$968.40 · last 30 days");
    expect(t("skills")).toBe("9 new · 3 upd · 2 ret");
    expect(t("workflows")).toBe("2 new · 3 upd · 1 ret");
    expect(t("router")).toBe("5 switches · autopilot on");
    expect(t("search")).toBe("/ 41,208 turns indexed");
  });
  it("computes attention dots and masks seen views", () => {
    expect(attention(designData(), { seen: [] })).toEqual({ dashboard: "warn", morning: "warn", tokens: null, skills: "ok", workflows: "ok", router: "warn", search: null });
    expect(attention(designData(), { seen: ["morning", "router"] })).toMatchObject({ morning: null, router: null, skills: "ok" });
    expect(Object.values(attention(emptyData(), { seen: [] })).every((d) => d === null)).toBe(true);
    expect(attention(liveShapeData(), { seen: [] })).toMatchObject({ dashboard: null, morning: null, skills: "ok", workflows: null, router: null });
  });
});

describe("sidebar empty states", () => {
  const shellText = (f: Frame, W: number, H: number): string[] => {
    const sw = sidebarWidth(W, designUi("dashboard"));
    return [text(f, 0), text(f, H - 1), ...f.rows.slice(1, H - 1).map((_, i) => text(f, i + 1).slice(0, sw))];
  };
  for (const [W, H] of SIZES) {
    for (const [name, make] of [["empty", emptyData], ["live-shape", liveShapeData]] as const) {
      it(`${name} ${W}x${H}: no invented numbers in the shell`, () => {
        for (const view of VIEW_ORDER) {
          const f = compose(W, H, make(), designUi(view));
          expect(f.rows).toHaveLength(H);
          for (const row of f.rows) expect(row.reduce((a, r) => a + r.t.length, 0)).toBe(W);
          for (const line of shellText(f, W, H)) expect(line).not.toMatch(/undefined|NaN|Infinity/);
        }
      });
    }
  }

  it("empty data, full sidebar", () => {
    const f = compose(150, 45, emptyData(), designUi("dashboard"));
    const side = (y: number): string => text(f, y).slice(0, 30).trimEnd();
    expect(text(f, 0)).toMatch(/not scanned yet {3}08:14:07 $/);
    expect(side(2)).toBe(" local only · not scanned yet");
    expect(side(5)).toBe("     not measured yet");
    expect(side(8)).toBe("     not measured yet");
    expect(side(11)).toBe("     not measured yet");
    expect(side(14)).toBe("     no skills yet");
    expect(side(17)).toBe("     not measured yet");
    expect(side(20)).toBe("     not measured yet");
    expect(side(23)).toBe("     / not indexed yet");
    expect(side(26)).toBe(" 0 skills  ·  — workflows");
    expect(side(27)).toBe(" autopilot —");
    expect(side(42)).toBe(" nothing leaves this machine");
    expect(side(43)).toBe(" ~/.reflex");
    const c = cellsOf(f);
    expect(c[5]![5]).toMatchObject({ ch: "n", fg: COLOR.dim });
    expect(c[43]![1]).toMatchObject({ ch: "~", fg: COLOR.faint, bg: COLOR.sidebar });
    // No dots: nothing was measured.
    for (let i = 0; i < 7; i++) expect(text(f, 4 + 3 * i).slice(27, 30)).toBe("   ");
  });

  it("live-shape data, full sidebar", () => {
    const f = compose(150, 45, liveShapeData(), designUi("dashboard"));
    const side = (y: number): string => text(f, y).slice(0, 30).trimEnd();
    expect(text(f, 0)).toMatch(/scanned 08:02 {3}08:14:07 $/);
    expect(side(2)).toBe(" local only · 312 sessions");
    expect(side(5)).toBe("     not measured yet");
    expect(side(8)).toBe("     not measured yet");
    expect(side(11)).toBe("     206.5M tok · last 7 days");
    expect(side(14)).toBe("     2 new · 0 upd · 1 ret");
    expect(side(17)).toBe("     not measured yet");
    expect(side(20)).toBe("     not measured yet");
    expect(side(23)).toBe("     / not indexed yet");
    expect(side(26)).toBe(" 3 skills  ·  — workflows");
    expect(side(27)).toBe(" autopilot —");
    expect(side(43)).toBe(" ~/.reflex");
    const c = cellsOf(f);
    expect(c[13]![28]).toMatchObject({ ch: "●", fg: COLOR.ok });
    for (const y of [7, 16, 19]) expect(text(f, y).slice(27, 30)).toBe("   ");
  });

  it("live-shape data, rail", () => {
    const c = cellsOf(compose(120, 40, liveShapeData(), designUi("dashboard")));
    expect(c[9]![2]).toMatchObject({ ch: "●", fg: COLOR.ok });
    for (const y of [3, 5, 7, 11, 13, 15]) expect(c[y]![2]!.ch).toBe(" ");
  });

  it("formats small token counts in k", () => {
    const d = liveShapeData();
    d.window!.tokens = { input: 100e3, cacheWrite: 50e3, cacheRead: 150e3, output: 12e3 };
    expect(summaries(d).tokens.map((s) => s.t).join("")).toBe("312k tok · last 7 days");
  });
});

describe("hit regions", () => {
  it("full sidebar: title and summary rows switch views", () => {
    const f = compose(150, 45, designData(), designUi("dashboard"));
    VIEW_ORDER.forEach((view, i) => {
      for (const x of [0, 15, 29]) {
        expect(hitAt(f, x, 4 + 3 * i)).toEqual({ type: "view", view });
        expect(hitAt(f, x, 5 + 3 * i)).toEqual({ type: "view", view });
      }
      expect(hitAt(f, 5, 6 + 3 * i)).toBeUndefined();
    });
    expect(hitAt(f, 5, 3)).toBeUndefined();
  });

  it("rail: the item row switches views", () => {
    const f = compose(120, 40, designData(), designUi("dashboard"));
    VIEW_ORDER.forEach((view, i) => {
      for (const x of [0, 2]) expect(hitAt(f, x, 3 + 2 * i)).toEqual({ type: "view", view });
      expect(hitAt(f, 1, 4 + 2 * i)).toBeUndefined();
    });
    expect(hitAt(f, 3, 3)).toBeUndefined();
  });

  it("the full sidebar becomes the rail when the user picks it", () => {
    const f = compose(150, 45, designData(), ui("dashboard", { sidebar: "rail" }));
    expect(text(f, 1).slice(0, 4)).toBe(" ◆  ");
    expect(hitAt(f, 1, 5)).toEqual({ type: "view", view: "morning" });
  });

  for (const [W, H] of SIZES) {
    it(`view hits are moved to the content area and clipped (${W}x${H})`, () => {
      const r = viewRegion(W, H);
      const data = designData();
      const u = designUi("skills");
      const own = renderItems("skills", r.w, r.h, data, u).hits;
      expect(own.length).toBeGreaterThan(0);
      const f = compose(W, H, data, u);
      const moved = f.hits.filter((h) => h.action.type !== "view");
      expect(moved.length).toBeGreaterThan(0);
      for (const h of moved) {
        expect(h.x0).toBeGreaterThanOrEqual(r.x0);
        expect(h.x1).toBeLessThanOrEqual(r.x0 + r.w);
        expect(h.y0).toBeGreaterThanOrEqual(r.y0);
        expect(h.y1).toBeLessThanOrEqual(r.y0 + r.h);
      }
      const expected = own
        .map((h) => ({ ...h, x0: h.x0 + r.x0, x1: Math.min(h.x1 + r.x0, r.x0 + r.w), y0: h.y0 + r.y0, y1: Math.min(h.y1 + r.y0, r.y0 + r.h) }))
        .filter((h) => h.x0 < h.x1 && h.y0 < h.y1);
      expect(moved).toEqual(expected);
      // The first list row of the skills table is view row 4, screen row 6 (prototype termClick).
      expect(hitAt(f, r.x0 + 2, 6)).toMatchObject({ type: "select", list: "skills" });
    });
  }
});

describe("overlays and top bar states", () => {
  for (const [W, H] of SIZES) {
    it(`toast sits on rows H-5..H-3 at the right edge (${W}x${H})`, () => {
      const base = cellsOf(compose(W, H, designData(), designUi("skills")));
      const f = compose(W, H, designData(), ui("skills", { toast: { msg: "installed flaky-test-bisect", tone: "ok" } }));
      const c = cellsOf(f);
      const tw = 44;
      const x0 = W - tw - 2;
      for (let y = 0; y < H; y++) {
        const inToast = y >= H - 5 && y <= H - 3;
        for (let x = 0; x < W; x++) if (!inToast || x < x0 || x >= x0 + tw) expect(c[y]![x]).toEqual(base[y]![x]);
      }
      const msg = " installed flaky-test-bisect";
      for (const y of [H - 5, H - 4, H - 3]) {
        expect(c[y]![x0]).toEqual({ ch: "▌", fg: COLOR.ok, bg: COLOR.bar, bold: false });
        // The message is bright; the padding (prototype `fit`) is body text color, all on the bar background.
        const bright = y === H - 4 ? msg.length : 1;
        for (let x = x0 + 1; x < x0 + tw; x++) expect(c[y]![x]).toMatchObject({ fg: x <= x0 + bright ? COLOR.hi : COLOR.fg, bg: COLOR.bar, bold: false });
      }
      expect(text(f, H - 4).slice(x0, x0 + tw)).toBe(("▌" + msg).padEnd(tw));
      expect(text(f, H - 5).slice(x0, x0 + tw)).toBe("▌".padEnd(tw));
    });
  }

  it("a dim toast uses a dim bar and cuts long messages", () => {
    const f = compose(120, 40, designData(), ui("workflows", { toast: { msg: "workflows are not available yet ".repeat(3), tone: "dim" } }));
    const c = cellsOf(f);
    expect(c[36]![74]).toMatchObject({ ch: "▌", fg: COLOR.dim });
    expect(text(f, 36).slice(74, 118)).toBe("▌ workflows are not available yet workflows…");
  });

  for (const [W, H] of SIZES) {
    it(`rescanning replaces the scan time in the top bar (${W}x${H})`, () => {
      const f = compose(W, H, designData(), ui("dashboard", { scanning: true }));
      const row = text(f, 0);
      expect(row).toHaveLength(W);
      expect(row.startsWith(" ◆ Reflex AI   dashboard   [0]")).toBe(true);
      expect(row.endsWith("rescanning…   08:14:07 ")).toBe(true);
      const c = cellsOf(f)[0]!;
      const at = row.indexOf("rescanning");
      for (let x = at; x < at + "rescanning…   ".length; x++) expect(c[x]).toMatchObject({ fg: COLOR.warn, bg: COLOR.bar });
      for (let x = W - 9; x < W; x++) expect(c[x]).toMatchObject({ fg: COLOR.dim, bg: COLOR.bar });
    });
  }
});
