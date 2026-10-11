import { describe, expect, it } from "vitest";
import { designData, designUi } from "../../fixture/design";
import { emptyData, liveShapeData } from "../../fixture/live-shape";
import type { TuiData } from "../../src/model";
import { llen } from "../../src/render/text";
import type { Line } from "../../src/types";
import { renderMorning } from "../../src/views/morning";
import { SIZES, diffCells, linesToCells, referenceView, viewRegion } from "../harness";

const text = (l: Line): string => l.map((s) => s.t).join("");
const screen = (lines: Line[]): string => lines.map(text).join("\n");
const rowWith = (lines: Line[], s: string): string => lines.map(text).find((t) => t.includes(s)) ?? "";

/** Shared empty-state invariants: fits the area, no placeholder leaks, dim copy, no hits. */
function checkShape(lines: Line[], w: number, h: number): string {
  expect(lines.length).toBeLessThanOrEqual(h);
  for (const l of lines) expect(llen(l)).toBeLessThanOrEqual(w);
  const t = screen(lines);
  expect(t).not.toMatch(/undefined|NaN|Infinity/);
  const nm = lines.flat().filter((s) => s.t.includes("not measured yet"));
  expect(nm.length).toBe(5); // hero, three bar lists, router
  for (const s of nm) expect(s).toMatchObject({ t: "not measured yet", c: "dim" });
  expect(t).not.toContain("$"); // no money was measured
  for (const title of ["by cli tool", "by model", "by project"]) expect(t).toContain(title);
  expect(rowWith(lines, "all time").trimEnd()).toBe("all time —    this month —");
  expect(rowWith(lines, "ROUTER").trimEnd()).toBe("ROUTER  not measured yet");
  return t;
}

describe("morning view", () => {
  for (const [W, H] of SIZES) {
    it(`matches the reference at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const out = renderMorning(r.w, r.h, designData(), designUi("morning"));
      const d = diffCells(linesToCells(out.lines, r.w, r.h), referenceView(W, H, "morning"));
      expect(d.count, d.report).toBe(0);
    });

    it(`has no click regions at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      for (const data of [designData(), emptyData(), liveShapeData()]) expect(renderMorning(r.w, r.h, data, designUi("morning")).hits).toEqual([]);
    });

    it(`renders the empty state before the first scan at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const out = renderMorning(r.w, r.h, emptyData(), designUi("morning"));
      const t = checkShape(out.lines, r.w, r.h);
      expect(out.lines[0]).toEqual([{ t: "YESTERDAY", c: "dim", bold: true }]);
      expect(out.lines[1]).toEqual([{ t: "not measured yet", c: "dim" }]);
      expect(t).not.toContain("output tokens");
      expect(t).toMatch(/0 NEW {2,}0 UPDATED {2,}0 RETIRED/);
      expect(rowWith(out.lines, "ACTIVE").trimEnd()).toBe("ACTIVE  0 skills  in ~/.claude/skills  ~/.codex/skills");
      expect(rowWith(out.lines, "DATA").trimEnd()).toBe("DATA    ~/.reflex");
    });

    it(`renders what the live source measures at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const out = renderMorning(r.w, r.h, liveShapeData(), designUi("morning"));
      const t = checkShape(out.lines, r.w, r.h);
      expect(text(out.lines[0]!)).toBe("YESTERDAY   sat 10 oct");
      expect(out.lines[1]).toEqual([{ t: "not measured yet", c: "dim" }]);
      expect(t).toContain("41 sessions    34.1M context    900k output tokens");
      expect(t).toMatch(/2 NEW {2,}0 UPDATED {2,}1 RETIRED/);
      for (const name of ["review-pr", "debug-dependency", "bump-node-version"]) expect(t).toMatch(new RegExp(`skill ${name} +\\d+ sess`));
      expect(t).not.toContain("fix-ci"); // no state, not listed
      expect(rowWith(out.lines, "ACTIVE").trimEnd()).toBe("ACTIVE  3 skills  in ~/.claude/skills  ~/.codex/skills  ~/.cursor/skills");
      expect(rowWith(out.lines, "DATA").trimEnd()).toBe("DATA    ~/.reflex  reads ~/.claude/projects  ~/.codex/sessions  ~/.cursor/projects");
    });

    it(`falls back block by block on partial data at ${W}x${H}`, () => {
      const r = viewRegion(W, H);
      const data: TuiData = { ...designData(), money: undefined, router: undefined, workflows: undefined };
      const out = renderMorning(r.w, r.h, data, designUi("morning"));
      const t = screen(out.lines);
      expect(t).toContain("above your 7-day average of $31.30 by $9.97");
      expect(t).toContain("all time —    this month —");
      expect(rowWith(out.lines, "ROUTER").trimEnd()).toBe("ROUTER  not measured yet");
      expect(rowWith(out.lines, "ACTIVE").trimEnd()).toBe("ACTIVE  9 skills  in ~/.claude/skills  ~/.claude/commands  ~/.codex/prompts");
      expect(t).not.toContain("/wf-");
      expect(t).not.toMatch(/undefined|NaN|Infinity/);
    });
  }
});
