import { COLOR, type ColorToken, type Hex, type Line, type Row, type Run, type Seg } from "../types";

// Ports of the prototype's layout helpers (docs/design/tui-v5/reference, script block). The arithmetic
// is kept identical so layouts match the mockups cell for cell. Every character is one cell.

export const BOLD = { bold: true } as const;

export function S(t: string | number, c: ColorToken | Hex = "fg", o?: { bold?: boolean; b?: Hex | null } | null): Seg {
  return { t: String(t), c, ...(o ?? {}) };
}

export const llen = (l: Line): number => l.reduce((a, s) => a + s.t.length, 0);

/** Pad right to `n`, or cut to `n` with a trailing "…". */
export function tr(s: string | number, n: number): string {
  const v = String(s);
  if (n <= 0) return "";
  return v.length <= n ? v.padEnd(n) : v.slice(0, n - 1) + "…";
}

/** Pad left to `n`, or cut like `tr`. */
export function rp(s: string | number, n: number): string {
  const v = String(s);
  return v.length <= n ? v.padStart(n) : tr(v, n);
}

export const usd = (v: number): string => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt = (n: number): string => n.toLocaleString("en-US");

/** Exactly `w` cells: cut with "…" when non-blank text overflows, pad with spaces, optional background. */
export function fit(l: Line, w: number, bg?: Hex | null): Line {
  const full = l.map((s) => s.t).join("");
  const over = full.length > w && full.slice(w).trim() !== "";
  const lim = over ? w - 1 : w;
  let out: Line = [];
  let n = 0;
  for (const s of l) {
    if (n >= lim) break;
    let t = s.t;
    if (n + t.length > lim) t = t.slice(0, lim - n);
    if (t) out.push({ ...s, t });
    n += t.length;
  }
  if (over) {
    const last = out[out.length - 1] ?? S("");
    out.push({ ...last, t: "…" });
    n++;
  }
  if (n < w) out.push(S(" ".repeat(w - n)));
  if (bg) out = out.map((s) => (s.b ? s : { ...s, b: bg }));
  return out;
}

export type Block = { lines: Line[]; w: number };

/** Place blocks side by side with `gap` spaces between them. */
export function hcat(blocks: Block[], gap: number): Line[] {
  const h = Math.max(...blocks.map((b) => b.lines.length));
  const out: Line[] = [];
  for (let i = 0; i < h; i++) {
    let l: Line = [];
    blocks.forEach((b, j) => {
      const line = b.lines[i];
      l = l.concat(line ? fit(line, b.w) : [S(" ".repeat(b.w))]);
      if (j < blocks.length - 1) l.push(S(" ".repeat(gap)));
    });
    out.push(l);
  }
  return out;
}

export type BoxOptions = {
  /** Bottom-right label, e.g. "4/18". */
  sub?: string;
  /** First content line to show (preview panes scroll). At 0 the output equals the prototype's. */
  scroll?: number;
};

/** The largest useful scroll offset for `total` content lines in a box of height `h`. */
export const maxScroll = (total: number, h: number): number => Math.max(0, total - (h - 2));

/** Rounded box, `w` x `h`, with a dim title, a scrollbar thumb when content overflows and a bottom label. */
export function box(w: number, h: number, title: string, inner: Line[], o: BoxOptions = {}): Line[] {
  const iw = w - 4;
  const ih = h - 2;
  const L: Line[] = [];
  if (title) {
    const tt = tr(title, w - 6).trimEnd();
    L.push([S("╭─ ", "line"), S(tt, "dim"), S(" " + "─".repeat(Math.max(0, w - 5 - tt.length)) + "╮", "line")]);
  } else L.push([S("╭" + "─".repeat(w - 2) + "╮", "line")]);
  const total = inner.length;
  const over = total > ih;
  const top = over ? Math.min(Math.max(0, Math.floor(o.scroll ?? 0)), total - ih) : 0;
  const th = over ? Math.max(1, Math.round((ih * ih) / total)) : 0;
  const tp = over && total > ih ? Math.round((top / (total - ih)) * (ih - th)) : 0;
  for (let i = 0; i < ih; i++) {
    const thumb = over && i >= tp && i < tp + th;
    L.push([S("│ ", "line"), ...fit(inner[top + i] ?? [], iw), S(" "), S(thumb ? "┃" : "│", thumb ? "dim" : "line")]);
  }
  const sub = o.sub ?? "";
  L.push(
    sub
      ? [S("╰" + "─".repeat(Math.max(0, w - 5 - sub.length)) + " ", "line"), S(sub, "dim"), S(" ─╯", "line")]
      : [S("╰" + "─".repeat(w - 2) + "╯", "line")],
  );
  return L;
}

export type Column = { h: string; w?: number; flex?: boolean; min?: number; r?: boolean };
export type Cell = Seg | Line | string | number;

/** Header row plus one row per entry; the flex column takes the remaining width. `sel` rows get the selection background. */
export function table(cols: Column[], rows: Cell[][], w: number, o: { sel?: number } = {}): Line[] {
  const nat = cols.reduce((a, c) => a + (c.flex ? (c.min ?? 8) : (c.w ?? 0)), 0);
  const gap = nat + 2 * (cols.length - 1) <= w ? 2 : 1;
  const fixed = cols.reduce((a, c) => a + (c.flex ? 0 : (c.w ?? 0)), 0) + gap * (cols.length - 1);
  const ws = cols.map((c) => (c.flex ? Math.max(1, w - fixed) : (c.w ?? 0)));
  const cell = (x: Cell, i: number): Line => {
    const wd = ws[i]!;
    if (Array.isArray(x)) return fit(x, wd);
    const sg = typeof x === "object" ? x : S(x);
    return [{ ...sg, t: cols[i]!.r ? rp(sg.t, wd) : tr(sg.t, wd) }];
  };
  const mk = (cells: Cell[], bg: Hex | null): Line => {
    let l: Line = [];
    cells.forEach((x, i) => {
      l = l.concat(cell(x, i));
      if (i < cells.length - 1) l.push(S(" ".repeat(gap)));
    });
    return fit(l, w, bg);
  };
  const out: Line[] = [mk(cols.map((c) => S(c.h, "dim")), null)];
  rows.forEach((r, i) => out.push(mk(r, o.sel === i ? COLOR.sel : null)));
  return out;
}

/** Word-wrap to `n` cells; numbered and bulleted lines keep their hanging indent. */
export function wrap(s: string, n: number): string[] {
  if (s.length <= n) return [s];
  const ind = (s.match(/^(\d+\. |- )/) ?? [""])[0].length;
  const out: string[] = [];
  let cur = "";
  s.split(" ").forEach((w) => {
    const nx = cur + (cur.trim() ? " " : "") + w;
    if (nx.length > n && cur.trim()) {
      out.push(cur);
      cur = " ".repeat(ind) + w;
    } else cur = nx;
  });
  if (cur) out.push(cur);
  return out;
}

/** Highlight case-insensitive matches of `q` (bold, highlight background); the rest in `c`. */
export function hl(t: string, q: string, c: ColorToken | Hex): Line {
  if (!q) return [S(t, c)];
  const lt = t.toLowerCase();
  const lq = q.toLowerCase();
  // Lowercasing can change the length of a few exotic characters; then offsets would not line up.
  if (lt.length !== t.length || lq.length !== q.length) return [S(t, c)];
  const o: Line = [];
  let i = 0;
  let j: number;
  while ((j = lt.indexOf(lq, i)) >= 0) {
    if (j > i) o.push(S(t.slice(i, j), c));
    o.push(S(t.slice(j, j + q.length), "hi", { bold: true, b: COLOR.match }));
    i = j + q.length;
  }
  if (i < t.length) o.push(S(t.slice(i), c));
  return o;
}

// East Asian wide and fullwidth ranges (and default-emoji-presentation symbols) that take two cells.
const WIDE =
  /[\u1100-\u115F\u231A\u231B\u2329\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/g;

/**
 * Make untrusted text safe to draw: one cell per UTF-16 unit and no control characters, so it can
 * neither break the layout nor emit terminal escape sequences. Tabs become spaces; other C0/C1
 * controls, zero-width characters and combining marks are dropped; astral and wide characters
 * become "?".
 */
export function toCells(s: string): string {
  return s
    .replace(/\t/g, " ")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    // eslint-disable-next-line no-misleading-character-class -- variation selectors are listed on purpose so they get dropped
    .replace(/[\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFE00-\uFE0F]/g, "")
    .replace(/\p{M}/gu, "")
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?")
    .replace(/[\uD800-\uDFFF]/g, "?")
    .replace(WIDE, "?");
}

const hex = (c: ColorToken | Hex): Hex => (c in COLOR ? COLOR[c as ColorToken] : (c as Hex));

/** Fit a line to `w` cells and resolve it to a terminal row: hex colors, adjacent equal styles merged. */
export function toRow(l: Line, w: number): Row {
  const out: Run[] = [];
  for (const s of fit(l, w)) {
    if (!s.t) continue;
    const run: Run = { t: s.t, fg: hex(s.c), bg: s.b ?? null, bold: !!s.bold };
    const p = out[out.length - 1];
    if (p && p.fg === run.fg && p.bg === run.bg && p.bold === run.bold) p.t += run.t;
    else out.push(run);
  }
  return out;
}
