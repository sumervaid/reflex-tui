import { describe, expect, it } from "vitest";
import { designData, designUi } from "../../fixture/design";
import { emptyData, liveShapeData } from "../../fixture/live-shape";
import type { TuiData } from "../../src/model";
import { mdLines } from "../../src/render/charts";
import { llen } from "../../src/render/text";
import { COLOR, type Line, type ViewOut } from "../../src/types";
import { renderItems } from "../../src/views/items";
import { SIZES, diffCells, linesToCells, referenceView, viewRegion } from "../harness";

const KINDS = ["skills", "workflows"] as const;
const text = (l: Line): string => l.map((s) => s.t).join("");

function render(kind: (typeof KINDS)[number], W: number, H: number, data: TuiData, patch: Partial<ReturnType<typeof designUi>> = {}): ViewOut {
  const r = viewRegion(W, H);
  return renderItems(kind, r.w, r.h, data, { ...designUi(kind), ...patch });
}

function expectSane(out: ViewOut, W: number, H: number): string {
  const r = viewRegion(W, H);
  expect(out.lines.length).toBeLessThanOrEqual(r.h);
  for (const l of out.lines) expect(llen(l)).toBeLessThanOrEqual(r.w);
  const all = out.lines.map(text).join("\n");
  expect(all).not.toMatch(/undefined|NaN|Infinity/);
  for (const hit of out.hits) {
    expect(hit.x0).toBeGreaterThanOrEqual(0);
    expect(hit.x1).toBeLessThanOrEqual(r.w);
    expect(hit.y0).toBeGreaterThanOrEqual(0);
    expect(hit.y1).toBeLessThanOrEqual(r.h);
  }
  return all;
}

describe("items view (skills, workflows)", () => {
  for (const kind of KINDS)
    for (const [W, H] of SIZES)
      it(`${kind} matches the reference at ${W}x${H}`, () => {
        const r = viewRegion(W, H);
        const out = renderItems(kind, r.w, r.h, designData(), designUi(kind));
        const d = diffCells(linesToCells(out.lines, r.w, r.h), referenceView(W, H, kind));
        if (d.count) console.log(`${kind} ${W}x${H}: ${d.count} cells differ\n${d.report}`);
        expect(d.count).toBe(0);
      });

  for (const [W, H] of SIZES) {
    it(`empty data at ${W}x${H}`, () => {
      const s = expectSane(render("skills", W, H, emptyData()), W, H);
      expect(s).toContain("space installs/removes ~/.claude/skills/<name>/SKILL.md + ~/.codex/skills/<name>/SKILL.md");
      expect(s).toContain("╭─ skills  0 · 0 on ");
      expect(s).toContain("no skills yet");
      expect(s).toContain("╭─ preview ─");
      expect(s).not.toContain("installed");
      const wf = render("workflows", W, H, emptyData());
      const t = expectSane(wf, W, H);
      expect(text(wf.lines[0]!)).toBe("workflows are not available yet");
      expect(t).toContain("╭─ workflows  0 · 0 on ");
      expect(t).toContain("no workflows yet");
      expect(t).toContain("╭─ preview ─");
      expect(wf.hits.map((x) => x.action.type)).toEqual(["scroll"]);
    });

    it(`live-shape data at ${W}x${H}`, () => {
      const data = liveShapeData();
      const out = render("skills", W, H, data);
      const s = expectSane(out, W, H);
      // Three targets do not fit the compact hint: the last one collapses into "1 more".
      expect(text(out.lines[0]!)).toBe("space installs/removes ~/.claude/skills/<name>/SKILL.md + ~/.codex/skills/<name>/SKILL.md + 1 more");
      expect(s).toContain("╭─ skills  6 · 3 on ");
      expect(s).toContain("╭─ ~/.claude/skills/bump-node-version/SKILL.md ");
      expect(s).toContain(" installed ─╯");
      expect(s).toContain("4/6");
      const wf = render("workflows", W, H, data);
      expect(expectSane(wf, W, H)).toContain("no workflows yet");
      expect(text(wf.lines[0]!)).toBe("workflows are not available yet");
      // A selection past the end clamps to the last item.
      expect(expectSane(render("skills", W, H, data, { sel: { skills: 99, workflows: 0, router: 0, search: 0 } }), W, H)).toContain("6/6");
    });
  }

  it("rows select and the preview scrolls", () => {
    for (const kind of KINDS)
      for (const [W, H] of SIZES) {
        const data = designData();
        const n = (kind === "skills" ? data.skills : data.workflows!).items.length;
        const out = render(kind, W, H, data);
        const rows = out.hits.filter((x) => x.action.type === "select");
        expect(rows.map((x) => x.action)).toEqual([...Array(n).keys()].map((index) => ({ type: "select", list: kind, index })));
        const sel = designUi(kind).sel[kind];
        const hit = rows[sel]!;
        // The hit row is the selected table row (selection background) showing that item's name.
        const line = out.lines[hit.y0]!;
        expect(text(line)).toContain((kind === "skills" ? data.skills : data.workflows!).items[sel]!.name);
        expect(line.some((s) => s.b === COLOR.sel)).toBe(true);
        const r = viewRegion(W, H);
        const pv = out.hits.find((x) => x.action.type === "scroll")!;
        expect(pv).toEqual({ x0: Math.round(r.w * 0.4) + 1, x1: r.w, y0: 2, y1: r.h, action: { type: "scroll", pane: "preview" } });
      }
  });

  it("previewScroll moves the preview content and the thumb", () => {
    // A short view so the markdown overflows the preview box.
    const w = 115;
    const h = 20;
    const data = designData();
    const a = renderItems("skills", w, h, data, designUi("skills"));
    const b = renderItems("skills", w, h, data, { ...designUi("skills"), previewScroll: 3 });
    const md = mdLines(data.skills.items[3]!.markdown, w - Math.round(w * 0.4) - 1 - 4).map(text);
    // Line 3 is the box's first content row: markdown line 0 at offset 0, line 3 at offset 3.
    expect(text(a.lines[3]!)).toContain("│ " + md[0]!);
    expect(text(b.lines[3]!)).toContain("│ " + md[3]!);
    const thumb = (o: ViewOut): number => o.lines.findIndex((l) => text(l).endsWith("┃"));
    expect(thumb(a)).toBe(3);
    expect(thumb(b)).toBeGreaterThan(thumb(a));
    // Past the end clamps to the last page.
    const c = renderItems("skills", w, h, data, { ...designUi("skills"), previewScroll: 999 });
    expect(text(c.lines[h - 2]!)).toContain("│ " + md[md.length - 1]!);
  });

  it("a long list keeps the selection visible", () => {
    const [W, H] = SIZES[1]!;
    const data = designData();
    const many = Array.from({ length: 60 }, (_, i) => ({ ...data.skills.items[i % data.skills.items.length]!, name: `skill-${i}` }));
    data.skills = { ...data.skills, items: many };
    const out = render("skills", W, H, data, { sel: { skills: 50, workflows: 0, router: 0, search: 0 } });
    const s = expectSane(out, W, H);
    expect(s).toContain("51/60");
    const hit = out.hits.find((x) => x.action.type === "select" && x.action.index === 50)!;
    expect(text(out.lines[hit.y0]!)).toContain("skill-50");
  });
});
