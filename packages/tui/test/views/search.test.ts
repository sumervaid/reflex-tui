import { describe, expect, it } from "vitest";
import { designData, designUi } from "../../fixture/design";
import { emptyData, liveShapeData } from "../../fixture/live-shape";
import type { TuiData } from "../../src/model";
import { llen } from "../../src/render/text";
import type { Line, UiState } from "../../src/types";
import { renderSearch, searchTop } from "../../src/views/search";
import { SIZES, diffCells, linesToCells, referenceView, viewRegion } from "../harness";

const str = (l: Line): string => l.map((s) => s.t).join("");
const text = (lines: Line[]): string => lines.map(str).join("\n");
const ui = (o: Partial<UiState> = {}): UiState => ({ ...designUi("search"), ...o });

describe("search view", () => {
  for (const [W, H] of SIZES) {
    it(`matches the reference at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const out = renderSearch(r.w, r.h, designData(), designUi("search"));
      const d = diffCells(linesToCells(out.lines, r.w, r.h), referenceView(W, H, "search"));
      expect(d.count, d.report).toBe(0);
    });

    for (const [name, make] of [
      ["emptyData", emptyData],
      ["liveShapeData", liveShapeData],
    ] as Array<[string, () => TuiData]>) {
      it(`renders the not-indexed state for ${name} at ${W}x${H}`, () => {
        const r = viewRegion(W, H);
        const out = renderSearch(r.w, r.h, make(), designUi("search"));
        expect(out.lines.length).toBe(r.h);
        for (const l of out.lines) expect(llen(l)).toBeLessThanOrEqual(r.w);
        const t = text(out.lines);
        expect(t).not.toMatch(/undefined|NaN|Infinity/);
        // Query line keeps the query; its right side says the index is missing.
        expect(str(out.lines[0]!)).toMatch(/^ \/ {3}refund +not indexed yet$/);
        expect(out.lines[0]!.at(-1)).toEqual({ t: "not indexed yet", c: "dim" });
        expect(str(out.lines[1]!)).toContain("tool  [all]  claude   codex   cursor");
        expect(str(out.lines[3]!)).toMatch(/^╭─ results ─+╮ ╭─ preview ─+╮$/);
        expect(str(out.lines[4]!)).toMatch(/^│ not indexed yet +│ │ +│$/);
        expect(t).not.toMatch(/turns indexed|no turns match|\d+\/\d+/);
        expect(out.hits).toEqual([]);
      });
    }

    it(`keeps the query line working without an index at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const typing = renderSearch(r.w, r.h, emptyData(), ui({ query: "ref", searchQuery: "", typing: true }));
      expect(str(typing.lines[0]!)).toMatch(/^ \/ {3}ref▏ +not indexed yet$/);
      const idle = renderSearch(r.w, r.h, emptyData(), ui({ query: "", searchQuery: "", typing: false }));
      expect(str(idle.lines[0]!)).toContain("press / and type to search every turn");
    });

    it(`has a select hit for the first two rows of each result at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const out = renderSearch(r.w, r.h, designData(), designUi("search"));
      const lw = Math.round(r.w * 0.5);
      const sel = out.hits.filter((x) => x.action.type === "select");
      expect(sel).toHaveLength(10);
      sel.forEach((x, i) => expect(x).toEqual({ x0: 0, x1: lw, y0: 4 + 3 * i, y1: 6 + 3 * i, action: { type: "select", list: "search", index: i } }));
      expect(out.hits.filter((x) => x.action.type === "scroll")).toEqual([{ x0: lw + 1, x1: r.w, y0: 3, y1: r.h, action: { type: "scroll", pane: "preview" } }]);
    });
  }

  it("keeps the selection centered and moves the hits and the thumb with it", () => {
    const w = 115;
    const h = 20;
    const out = renderSearch(w, h, designData(), ui({ sel: { ...designUi("search").sel, search: 5 } }));
    const top = searchTop(5, 10, h - 3);
    expect(top).toBe(8);
    const hit = out.hits.find((x) => x.action.type === "select" && x.action.index === 5)!;
    expect(hit).toMatchObject({ y0: 4 + 15 - top, y1: 6 + 15 - top });
    expect(str(out.lines[hit.y0]!)).toMatch(/^│ ▸ 08 Oct {2}claude {2}billing-svc {4}turn 12/);
    // Hits scrolled out of the box get no region; partly visible ones are clipped to the box.
    for (const x of out.hits.filter((y) => y.action.type === "select")) {
      expect(x.y0).toBeGreaterThanOrEqual(4);
      expect(x.y1).toBeLessThanOrEqual(4 + h - 5);
    }
    // 30 rows in a 15-row box: an 8-row thumb, 4 rows down at this offset.
    const lw = Math.round(w * 0.5);
    const thumb = out.lines.map((l) => str(l)[lw - 1]);
    expect(thumb.slice(4, 4 + 15).join("")).toBe("││││┃┃┃┃┃┃┃┃│││");
  });

  it("scrolls the context pane with previewScroll", () => {
    const w = 115;
    const h = 12;
    const lw = Math.round(w * 0.5);
    const at = (s: number) => str(renderSearch(w, h, designData(), ui({ previewScroll: s })).lines[4]!).slice(lw + 1);
    expect(at(0)).toContain("claude · billing-svc · 10 Oct");
    expect(at(1)).toContain("session a7d3   9 turns   $2.40");
  });

  it("says when nothing matches", () => {
    const out = renderSearch(115, 37, designData(), ui({ query: "zzz", searchQuery: "zzz" }));
    expect(str(out.lines[0]!)).toContain("0 turns in 0 sessions   ·   41,208 turns indexed");
    expect(str(out.lines[4]!)).toContain('no turns match "zzz"');
    expect(str(out.lines[3]!)).toContain("─ preview ─");
    expect(out.hits).toEqual([]);
  });
});
