import { describe, expect, it } from "vitest";
import { designData, designUi } from "../../fixture/design";
import { emptyData, liveShapeData } from "../../fixture/live-shape";
import type { TuiData } from "../../src/model";
import { llen } from "../../src/render/text";
import { COLOR, type Line } from "../../src/types";
import { renderRouter } from "../../src/views/router";
import { SIZES, diffCells, linesToCells, referenceView, viewRegion } from "../harness";

const text = (lines: Line[]): string => lines.map((l) => l.map((s) => s.t).join("")).join("\n");

describe("router view", () => {
  for (const [W, H] of SIZES) {
    it(`matches the reference at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const out = renderRouter(r.w, r.h, designData(), designUi("router"));
      const d = diffCells(linesToCells(out.lines, r.w, r.h), referenceView(W, H, "router"));
      expect(d.count, d.report).toBe(0);
    });

    for (const [name, make] of [
      ["emptyData", emptyData],
      ["liveShapeData", liveShapeData],
    ] as Array<[string, () => TuiData]>) {
      it(`renders the empty state for ${name} at ${W}x${H}`, () => {
        const r = viewRegion(W, H);
        const out = renderRouter(r.w, r.h, make(), designUi("router"));
        expect(out.lines.length).toBeLessThanOrEqual(r.h);
        for (const l of out.lines) expect(llen(l)).toBeLessThanOrEqual(r.w);
        const t = text(out.lines);
        expect(t).not.toMatch(/undefined|NaN|Infinity/);
        expect(out.lines[0]![0]).toMatchObject({ t: " AUTOPILOT ", b: COLOR.sel, bold: true });
        expect(out.lines[0]![1]).toMatchObject({ t: "  not available yet", c: "dim" });
        expect(llen(out.lines[1]!)).toBe(0);
        expect(out.lines[2]).toEqual([{ t: "not measured yet", c: "dim" }]);
        expect(out.hits).toEqual([]);
      });
    }

    it(`has one select hit per task row pair at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const data = designData();
      const out = renderRouter(r.w, r.h, data, designUi("router"));
      const tasks = data.router!.tasks;
      expect(out.hits).toHaveLength(tasks.length);
      out.hits.forEach((hit, i) => {
        expect(hit).toEqual({ x0: 0, x1: r.w, y0: 9 + 2 * i, y1: 11 + 2 * i, action: { type: "select", list: "router", index: i } });
        expect(text([out.lines[hit.y0]!])).toContain(tasks[i]!.name);
      });
    });
  }

  it("shows now… while scanning, the off banner and the selected task's evidence", () => {
    const { w, h } = viewRegion(150, 45);
    const data = designData();
    data.router!.autopilot = false;
    const ui = { ...designUi("router"), scanning: true, sel: { skills: 3, workflows: 1, router: 1, search: 0 } };
    const out = renderRouter(w, h, data, ui);
    const t = text(out.lines);
    expect(t).toContain("rebuilt now…");
    expect(out.lines[0]![0]).toMatchObject({ t: " AUTOPILOT ", b: COLOR.sel });
    expect(t).toContain("OFF   suggestions only, you pick the model yourself   space turns on");
    expect(t).toContain("WHY HAIKU-4-5 FOR REFACTORING");
    expect(text([out.lines[11]!])).toContain("▸ Refactoring");
  });

  it("collapses an empty task list to its heading and the dim line", () => {
    const { w, h } = viewRegion(120, 40);
    const data = designData();
    data.router!.tasks = [];
    const out = renderRouter(w, h, data, designUi("router"));
    const t = text(out.lines);
    expect(t).toContain("YOUR TASKS");
    expect(t).toContain("not measured yet");
    expect(t).not.toContain("WHY ");
    expect(t).not.toMatch(/undefined|NaN|Infinity/);
    expect(out.hits).toEqual([]);
  });
});
