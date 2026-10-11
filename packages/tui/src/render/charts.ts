import type { ColorToken, Hex, Line } from "../types";
import { BOLD, S, rp, tr, usd, wrap } from "./text";

/** Half-block big-digit font: 6 pixel rows per glyph, drawn on 3 text rows (docs/design/tui-v5/HANDOFF.md). */
const GL: Record<string, string[]> = {
  "0": [".##.", "#..#", "#..#", "#..#", "#..#", ".##."],
  "1": [".#.", "##.", ".#.", ".#.", ".#.", "###"],
  "2": [".##.", "#..#", "...#", "..#.", ".#..", "####"],
  "3": ["###.", "...#", ".##.", "...#", "...#", "###."],
  "4": ["#..#", "#..#", "#..#", "####", "...#", "...#"],
  "5": ["####", "#...", "###.", "...#", "...#", "###."],
  "6": [".##.", "#...", "###.", "#..#", "#..#", ".##."],
  "7": ["####", "...#", "..#.", ".#..", ".#..", ".#.."],
  "8": [".##.", "#..#", ".##.", "#..#", "#..#", ".##."],
  "9": [".##.", "#..#", "#..#", ".###", "...#", ".##."],
  $: ["..#..", ".####", "#.#..", ".###.", "..#.#", "####."],
  ".": [".", ".", ".", ".", ".", "#"],
  ",": [".", ".", ".", ".", "#", "#"],
  "%": ["#..#", "...#", "..#.", ".#..", "#...", "#..#"],
  "+": ["...", ".#.", "###", ".#.", "...", "..."],
  "-": ["...", "...", "###", "...", "...", "..."],
};

/** Three rows of big digits. Glyphs are separated by one space; characters without a glyph are skipped. */
export function big(s: string): [string, string, string] {
  const r: [string, string, string] = ["", "", ""];
  [...s].forEach((ch, k) => {
    const g = GL[ch];
    if (!g) return;
    for (let l = 0; l < 3; l++) {
      let t = "";
      for (let x = 0; x < g[0]!.length; x++) {
        const p = g[2 * l]![x] === "#";
        const q = g[2 * l + 1]![x] === "#";
        t += p && q ? "█" : p ? "▀" : q ? "▄" : " ";
      }
      r[l] += (k ? " " : "") + t;
    }
  });
  return r;
}

/** Horizontal bar: full blocks plus one eighth-block for the remainder, at most `w` cells. */
export function hb(v: number, mx: number, w: number): string {
  const u = Math.max(0, (v / mx) * w);
  const fl = Math.floor(u);
  const rr = Math.round((u - fl) * 8);
  return ("█".repeat(fl) + (rr ? "▏▎▍▌▋▊▉█"[rr - 1] : "")).slice(0, w);
}

export type VChartOptions = {
  max?: number;
  /** Value of a dashed reference line (drawn as ╌ in empty cells of its row). */
  line?: number;
  /** Left axis text for row `r` (top row is 0). */
  axis?: (r: number) => string;
};

/** Vertical bar chart with eighth-block tops. Each bar is `cw-1` cells plus a 1-cell gap. */
export function vchart(vals: number[], rows: number, cw: number, col: (v: number, i: number) => ColorToken | Hex, o: VChartOptions = {}): Line[] {
  const mx = o.max || Math.max(...vals);
  const E = " ▁▂▃▄▅▆▇█";
  const out: Line[] = [];
  const lr = o.line != null ? rows - 1 - Math.min(rows - 1, Math.floor((o.line / mx) * rows)) : -1;
  for (let r = 0; r < rows; r++) {
    const l: Line = o.axis ? [S(o.axis(r), "dim")] : [];
    vals.forEach((v, i) => {
      const lvl = Math.round((v / mx) * rows * 8) - (rows - 1 - r) * 8;
      const ch = lvl >= 8 ? "█" : lvl <= 0 ? " " : E[lvl]!;
      if (ch === " " && r === lr) l.push(S("╌".repeat(cw), "faint"));
      else l.push(S(ch.repeat(cw - 1), col(v, i)), S(r === lr ? "╌" : " ", "faint"));
    });
    out.push(l);
  }
  return out;
}

/** Bold title, then one row per item: name, bar scaled to the largest value, right-aligned USD. */
export function hbars(title: string, items: Array<[string, number]>, w: number, o: { nw?: number; col?: ColorToken | Hex } = {}): Line[] {
  const nw = o.nw || 12;
  const vw = 9;
  const bw = Math.max(4, w - nw - vw - 2);
  const mx = Math.max(...items.map((x) => x[1]));
  return [
    [S(title, "hi", BOLD)],
    ...items.map(([n, v]): Line => [S(tr(n, nw), "fg"), S(" "), S(hb(v, mx, bw).padEnd(bw), o.col || "gb"), S(rp(usd(v), vw + 1), "fg")]),
  ];
}

/** Markdown preview: front matter dim, headings bold, everything wrapped to `w`. */
export function mdLines(src: string[], w: number): Line[] {
  const out: Line[] = [];
  let fm = 0;
  src.forEach((line) => {
    let c: ColorToken = "fg";
    let b: typeof BOLD | null = null;
    if (line === "---") {
      fm++;
      c = "dim";
    } else if (fm === 1) c = "dim";
    else if (line.startsWith("#")) {
      c = "hi";
      b = BOLD;
    }
    wrap(line, w).forEach((t) => out.push([S(t, c, b)]));
  });
  return out;
}
