import { describe, expect, it } from "vitest";
import { designData, designUi } from "../../fixture/design";
import { emptyData, liveShapeData } from "../../fixture/live-shape";
import type { TuiData } from "../../src/model";
import { llen } from "../../src/render/text";
import type { Line } from "../../src/types";
import { renderDashboard } from "../../src/views/dashboard";
import { SIZES, diffCells, linesToCells, referenceView, viewRegion } from "../harness";

const text = (lines: Line[]): string => lines.map((l) => l.map((s) => s.t).join("")).join("\n");
const row = (l: Line | undefined): string => (l ?? []).map((s) => s.t).join("");

describe("dashboard view", () => {
  for (const [W, H] of SIZES) {
    it(`matches the reference at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const out = renderDashboard(r.w, r.h, designData(), designUi("dashboard"));
      const d = diffCells(linesToCells(out.lines, r.w, r.h), referenceView(W, H, "dashboard"));
      expect(d.count, d.report).toBe(0);
    });

    for (const [name, make] of [
      ["emptyData", emptyData],
      ["liveShapeData", liveShapeData],
    ] as Array<[string, () => TuiData]>) {
      it(`renders the empty states for ${name} at ${W}x${H}`, () => {
        const r = viewRegion(W, H);
        const data = make();
        const out = renderDashboard(r.w, r.h, data, designUi("dashboard"));
        expect(out.lines.length).toBeLessThanOrEqual(r.h);
        for (const l of out.lines) expect(llen(l)).toBeLessThanOrEqual(r.w);
        const t = text(out.lines);
        expect(t).not.toMatch(/undefined|NaN|Infinity/);
        // Limits: heading and helper, blank, one dim line; no cards and no plans note.
        expect(row(out.lines[0])).toContain("USAGE LIMITS");
        expect(llen(out.lines[1]!)).toBe(0);
        expect(out.lines[2]).toEqual([{ t: "not measured yet", c: "dim" }]);
        expect(t).not.toContain("╭");
        expect(t).not.toContain("plans in");
        // KPI strip: labels kept, missing values are a dim dash, sub-lines say not measured yet.
        const labels = row(out.lines[4]);
        for (const l of ["TODAY", "YESTERDAY", "ALL TIME", "CACHE SAVED", "ROUTER"]) expect(labels).toContain(l);
        expect(labels).toContain(data.window ? `${data.window.days} DAYS` : "30 DAYS");
        expect(out.lines[5]!.filter((s) => s.t === "—").every((s) => s.c === "dim")).toBe(true);
        expect(out.lines[5]!.filter((s) => s.t === "—")).toHaveLength(6);
        expect(row(out.lines[6])).toContain("not measured yet");
        if (data.window) expect(row(out.lines[6])).toContain(`${data.window.sessions} sessions`);
        // NEEDS A LOOK and the chart.
        expect(row(out.lines[8])).toContain("NEEDS A LOOK");
        expect(row(out.lines[8])).toContain("LAST 14 DAYS BY TOOL");
        expect(row(out.lines[8])).not.toContain("█ claude");
        expect(row(out.lines[9])).toContain("not measured yet");
        if (data.attention.length) {
          for (const a of data.attention) expect(t).toContain(a.text);
          expect(out.hits.map((x) => x.action)).toEqual(data.attention.map((a) => ({ type: "view", view: a.view })));
        } else {
          expect(row(out.lines[9])).toContain("nothing needs a look");
          expect(out.hits).toEqual([]);
        }
      });
    }

    it(`has one view hit per NEEDS A LOOK row at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const data = designData();
      const out = renderDashboard(r.w, r.h, data, designUi("dashboard"));
      expect(out.hits).toHaveLength(data.attention.length);
      const lw = Math.round(r.w * 0.5);
      out.hits.forEach((hit, i) => {
        expect(hit).toEqual({ x0: 0, x1: lw, y0: 19 + i, y1: 20 + i, action: { type: "view", view: data.attention[i]!.view } });
        expect(row(out.lines[hit.y0])).toContain(data.attention[i]!.text);
      });
    });
  }

  it("labels the window KPI from the window length and signs the yesterday delta", () => {
    const { w, h } = viewRegion(150, 45);
    const data = designData();
    data.window!.days = 7;
    data.days![data.days!.length - 1]!.usd = 10;
    const out = renderDashboard(w, h, data, designUi("dashboard"));
    expect(row(out.lines[14])).toContain("7 DAYS");
    expect(row(out.lines[16])).toContain("last 7 days");
    const delta = out.lines[16]!.find((s) => s.t.includes("% vs usual"))!;
    expect(delta.t).toMatch(/^-\d+% vs usual/);
    expect(delta.c).toBe("ok");
  });

  it("caps NEEDS A LOOK at five rows and keeps a measured-but-partial money block honest", () => {
    const { w, h } = viewRegion(120, 40);
    const data = designData();
    data.attention = [...data.attention, { tone: "dim", text: "sixth item", view: "search" }];
    delete data.window!.usd;
    const out = renderDashboard(w, h, data, designUi("dashboard"));
    expect(text(out.lines)).not.toContain("sixth item");
    expect(out.hits).toHaveLength(5);
    expect(row(out.lines[15])).toContain("—");
    expect(row(out.lines[15])).toContain("$12.40");
  });
});
