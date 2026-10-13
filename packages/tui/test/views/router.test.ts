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
    expect(t).toContain("OFF   reflex run shows the pick and asks first   space turns on");
    expect(t).toContain("WHY HAIKU-4-5 FOR REFACTORING");
    expect(text([out.lines[11]!])).toContain("▸ Refactoring");
  });

  it("lists the sessions behind the selected row, and says when no model has enough sessions", () => {
    const { w } = viewRegion(150, 45);
    const data = designData();
    const t0 = data.router!.tasks[0]!;
    t0.evidence = [{ model: "claude-opus-5-5", sessions: 2, usd: 13.78, friction: 31.4 }];
    t0.rec = t0.most = "claude-opus-5-5";
    t0.recent = [
      { date: "12 Oct", project: "reflex-tui", model: "claude-opus-5-5", usd: 20.1, friction: 40, prompt: "the scan never exits after results" },
      { date: "11 Oct", project: "hedging", model: "claude-opus-5-5", usd: 7.46, friction: 22.8, prompt: "why is this order stuck" },
    ];
    const out = renderRouter(w, 80, data, { ...designUi("router"), sel: { skills: 0, workflows: 0, router: 0, search: 0 } });
    const t = text(out.lines);
    expect(t).toContain(`no model has ${data.router!.minSupport} sessions of this yet · the pick is the one you used most`);
    expect(t).toContain("SESSIONS BEHIND " + t0.name.toUpperCase());
    expect(t).toMatch(/12 Oct\s+reflex-tui\s+claude-opus-5-5\s+\$20\.10\s+400\.0 fixes\/10\s+the scan never exits after results/);
    expect(t).toContain("hedging");
    for (const l of out.lines) expect(llen(l)).toBeLessThanOrEqual(w);
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
