// Golden-test helpers: compare rendered rows with the reference the prototype produced
// (test/golden/reference-WxH.json, see scripts/extract-reference.mjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRow } from "../src/render/text";
import { COLOR, type Line, type Row, type ViewId } from "../src/types";

export type Cell = { ch: string; fg: string; bg: string; bold: boolean };
type RefRun = [number, string, string | null, 0 | 1];
type Reference = { size: { w: number; h: number }; views: Array<{ key: string; name: string; rows: Array<{ text: string; runs: RefRun[] }> }> };

export const SIZES: Array<[number, number]> = [
  [150, 45],
  [120, 40],
];

const cache = new Map<string, Reference>();
function reference(w: number, h: number): Reference {
  const key = `${w}x${h}`;
  if (!cache.has(key)) cache.set(key, JSON.parse(readFileSync(join(__dirname, "golden", `reference-${key}.json`), "utf8")) as Reference);
  return cache.get(key)!;
}

const NAMES: Record<ViewId, string> = {
  dashboard: "Dashboard",
  morning: "Morning",
  tokens: "Tokens",
  skills: "Skills",
  workflows: "Workflows",
  router: "Router",
  search: "Search",
};

/** The reference screen for a view as cells, with the brand changed to "Reflex AI" on the top bar. */
export function referenceCells(w: number, h: number, view: ViewId): Cell[][] {
  const v = reference(w, h).views.find((x) => x.name === NAMES[view]);
  if (!v) throw new Error(`no reference for ${view} at ${w}x${h}`);
  return v.rows.map((r, y) => {
    const cells: Cell[] = [];
    let text = r.text;
    if (y === 0) text = text.replace(" ◆ agentlens ", " ◆ Reflex AI ");
    let x = 0;
    for (const [len, fg, bg, bold] of r.runs) {
      for (let i = 0; i < len; i++) cells.push({ ch: text[x + i]!, fg, bg: bg ?? COLOR.bg, bold: bold === 1 });
      x += len;
    }
    return cells;
  });
}

export function rowCells(row: Row): Cell[] {
  const out: Cell[] = [];
  for (const r of row) for (const ch of r.t) out.push({ ch, fg: r.fg, bg: r.bg ?? COLOR.bg, bold: r.bold });
  return out;
}

/** View lines as the shell places them: each fitted to `w`, blank rows to `h`. */
export function linesToCells(lines: Line[], w: number, h: number): Cell[][] {
  const out: Cell[][] = [];
  for (let y = 0; y < h; y++) out.push(rowCells(toRow(lines[y] ?? [], w)));
  return out;
}

/**
 * Where a view's lines land on screen at a size (prototype `compose`): row 0 is the top bar and
 * row 1 a blank padding row, so view line 0 is screen row 2. The view is `w` wide after the sidebar
 * (30 columns at 140+, 3 below) and one column of padding.
 */
export function viewRegion(W: number, H: number): { x0: number; y0: number; w: number; h: number } {
  const sw = W >= 140 ? 30 : 3;
  return { x0: sw + 1, y0: 2, w: W - sw - 2, h: H - 3 };
}

/** The reference cells of just the view area. */
export function referenceView(W: number, H: number, view: ViewId): Cell[][] {
  const { x0, y0, w, h } = viewRegion(W, H);
  return referenceCells(W, H, view)
    .slice(y0, y0 + h)
    .map((r) => r.slice(x0, x0 + w));
}

export type Diff = { count: number; cells: number; report: string };

/** Cell-by-cell comparison of text and style. `report` lists the first differences by row. */
export function diffCells(actual: Cell[][], expected: Cell[][], max = 25): Diff {
  let count = 0;
  let cells = 0;
  const lines: string[] = [];
  const rows = Math.max(actual.length, expected.length);
  for (let y = 0; y < rows; y++) {
    const a = actual[y] ?? [];
    const e = expected[y] ?? [];
    const n = Math.max(a.length, e.length);
    let first = -1;
    let rowDiffs = 0;
    for (let x = 0; x < n; x++) {
      cells++;
      const ca = a[x];
      const ce = e[x];
      const same = ca && ce && ca.ch === ce.ch && ca.fg === ce.fg && ca.bg === ce.bg && ca.bold === ce.bold;
      if (!same) {
        count++;
        rowDiffs++;
        if (first < 0) first = x;
      }
    }
    if (rowDiffs && lines.length < max) {
      const ca = a[first];
      const ce = e[first];
      const style = (c?: Cell) => (c ? `${JSON.stringify(c.ch)} fg ${c.fg} bg ${c.bg}${c.bold ? " bold" : ""}` : "missing");
      lines.push(
        `row ${y}: ${rowDiffs} cells differ, first at col ${first}: expected ${style(ce)}, got ${style(ca)}\n` +
          `  expected |${e.map((c) => c.ch).join("")}|\n  actual   |${a.map((c) => c.ch).join("")}|`,
      );
    }
  }
  return { count, cells, report: lines.join("\n") };
}
