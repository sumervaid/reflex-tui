import { COLOR, type Row } from "../types";
import { tryXterm256 } from "./colors";

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Replace every control character (C0, DEL, C1) with "?", one for one. Text that reaches the
 * terminal can then never start an escape sequence, and its width does not change.
 */
export const safeText = (s: string): string => s.replace(CONTROL, "?");

const fgParam = (hex: string): string => {
  const i = tryXterm256(hex);
  return i === null ? "39" : `38;5;${i}`;
};

const bgParam = (hex: string | null, screen: string): string => {
  const i = hex === null ? null : tryXterm256(hex);
  return i === null ? screen : `48;5;${i}`;
};

/**
 * One row as ANSI text: xterm-256 colors (SGR 38;5 / 48;5), bold (1 / 22), only the attributes
 * that change between runs, and a reset at the end. `bg: null` is painted as `screenBg`.
 * Control characters in the text become "?".
 */
export function encodeRow(row: Row, screenBg: string = COLOR.bg): string {
  const screen = bgParam(screenBg, "49");
  let out = "";
  let cur: { fg: string; bg: string; bold: boolean } | null = null;
  for (const r of row) {
    if (!r.t) continue;
    const fg = fgParam(r.fg);
    const bg = bgParam(r.bg, screen);
    const p: string[] = [];
    if (!cur) {
      if (r.bold) p.push("1");
      p.push(fg, bg);
    } else {
      if (r.bold !== cur.bold) p.push(r.bold ? "1" : "22");
      if (fg !== cur.fg) p.push(fg);
      if (bg !== cur.bg) p.push(bg);
    }
    if (p.length) out += `\x1b[${p.join(";")}m`;
    out += safeText(r.t);
    cur = { fg, bg, bold: r.bold };
  }
  return cur ? out + "\x1b[0m" : out;
}

const rowWidth = (row: Row): number => row.reduce((a, r) => a + r.t.length, 0);

/** Synchronized output (DEC mode 2026): terminals that support it show a frame at once. */
export const SYNC_START = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

/**
 * Writes frames, rewriting only the rows that changed since the last one. The first frame, a
 * frame of a different size and the frame after `invalidate()` clear the screen and repaint
 * every row. Each frame goes out in one write, wrapped in synchronized-output markers.
 */
export class FrameWriter {
  private prev: string[] = [];
  private w = -1;
  private h = -1;
  private full = true;

  constructor(
    private readonly write: (s: string) => void,
    private readonly screenBg: string = COLOR.bg,
  ) {}

  /** The screen no longer shows the last frame (a child process ran, the terminal resized): repaint everything next time. */
  invalidate(): void {
    this.full = true;
  }

  /** Draw `rows` (row 0 at the top). Returns what was written: "" when nothing changed. */
  render(rows: Row[]): string {
    const w = rows.reduce((m, r) => Math.max(m, rowWidth(r)), 0);
    const enc = rows.map((r) => {
      const n = rowWidth(r);
      // A short row is padded so it cannot leave cells of the previous frame behind.
      return encodeRow(n < w ? [...r, { t: " ".repeat(w - n), fg: COLOR.fg, bg: null, bold: false }] : r, this.screenBg);
    });
    const full = this.full || w !== this.w || rows.length !== this.h;
    // Clear with the screen background (terminals erase with the current background color).
    let body = full ? `\x1b[0;${bgParam(this.screenBg, "49")}m\x1b[2J\x1b[0m` : "";
    enc.forEach((e, y) => {
      if (full || e !== this.prev[y]) body += `\x1b[${y + 1};1H${e}`;
    });
    this.prev = enc;
    this.w = w;
    this.h = rows.length;
    this.full = false;
    if (!body) return "";
    const out = SYNC_START + body + SYNC_END;
    this.write(out);
    return out;
  }
}
