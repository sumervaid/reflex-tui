#!/usr/bin/env node
/* global process, console */
// Real-terminal check of the dev preview against the golden reference.
//
// Starts `node dist/preview.js --clock 08:14:07 --design-state` in a private tmux server at 150x45 and 120x40 with
// a 256-color TERM, presses 0..6, captures each screen with `tmux capture-pane -p -e -N`, parses the
// SGR codes into cells (text, fg index, bg index, bold) and compares them with
// test/golden/reference-WxH.json, mapping each reference hex color to its xterm-256 index the same
// way src/term/colors.ts does. The brand is substituted on row 0 like test/harness.ts.
//
// The preview runs with --design-state (the selections and query the mockups were dumped with).
// One difference is allowed: the attention dots of the views opened so far (the reference was
// dumped with only the dashboard marked seen; the app marks every view you open as seen).
//
// Usage: pnpm --filter @reflex/tui exec tsup --config tsup.preview.config.ts && node packages/tui/scripts/tmux-verify.mjs
// Exit code 0 when every compared cell matches (apart from the allowed dots), 1 otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW = join(PKG, "dist", "preview.js");
const SIZES = [
  [150, 45],
  [120, 40],
];
const KEYS = ["0", "1", "2", "3", "4", "5", "6"];
const VIEW_IDS = ["dashboard", "morning", "tokens", "skills", "workflows", "router", "search"];
const SOCK = `reflex-verify-${process.pid}`;

if (!existsSync(PREVIEW)) {
  console.error(`missing ${PREVIEW}; build it first: (cd packages/tui && npx tsup --config tsup.preview.config.ts)`);
  process.exit(2);
}

// --- xterm-256 mapping (same algorithm as src/term/colors.ts) ---
const LEVELS = [0, 95, 135, 175, 215, 255];
const SYS16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function xtermRgb(i) {
  if (i < 16) return SYS16[i];
  if (i >= 232) {
    const g = 8 + (i - 232) * 10;
    return [g, g, g];
  }
  const n = i - 16;
  return [LEVELS[Math.floor(n / 36)], LEVELS[Math.floor(n / 6) % 6], LEVELS[n % 6]];
}
function nearest(rgb) {
  let best = 16;
  let bestD = Infinity;
  for (let i = 16; i < 256; i++) {
    const [r, g, b] = xtermRgb(i);
    const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
const hexIdx = (hex) => {
  const h = hex.replace("#", "");
  return nearest([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
};

// --- reference cells ---
function referenceCells(ref, viewIdx) {
  const screenBg = hexIdx(ref.screenBg);
  return ref.views[viewIdx].rows.map((row, y) => {
    let text = row.text;
    if (y === 0) text = text.replace(" ◆ agentlens ", " ◆ Reflex AI ");
    const chars = [...text];
    const cells = [];
    let x = 0;
    for (const [len, fg, bg, bold] of row.runs) {
      for (let k = 0; k < len; k++, x++) cells.push({ ch: chars[x] ?? " ", fg: hexIdx(fg), bg: bg ? hexIdx(bg) : screenBg, bold: !!bold });
    }
    while (cells.length < ref.size.w) cells.push({ ch: chars[cells.length] ?? " ", fg: hexIdx(ref.defaultFg), bg: screenBg, bold: false });
    return cells;
  });
}

// --- SGR parsing of a capture ---
function parseCapture(out, w, h, defFg, defBg) {
  const lines = out.split("\n").slice(0, h);
  const rows = [];
  // capture-pane -e emits only attribute changes and carries them across line ends, so the SGR state
  // is kept from one line to the next.
  let fg = null;
  let bg = null;
  let bold = false;
  for (const line of lines) {
    const cells = [];
    for (let i = 0; i < line.length; ) {
      if (line[i] === "\x1b" && line[i + 1] === "[") {
        const m = /^\x1b\[([0-9;:]*)([A-Za-z])/.exec(line.slice(i)); // eslint-disable-line no-control-regex
        if (!m) {
          i++;
          continue;
        }
        i += m[0].length;
        if (m[2] !== "m") continue;
        const p = m[1] === "" ? [0] : m[1].split(/[;:]/).map(Number);
        for (let k = 0; k < p.length; k++) {
          const c = p[k];
          if (c === 0) [fg, bg, bold] = [null, null, false];
          else if (c === 1) bold = true;
          else if (c === 22) bold = false;
          else if (c === 39) fg = null;
          else if (c === 49) bg = null;
          else if (c >= 30 && c <= 37) fg = c - 30;
          else if (c >= 90 && c <= 97) fg = c - 90 + 8;
          else if (c >= 40 && c <= 47) bg = c - 40;
          else if (c >= 100 && c <= 107) bg = c - 100 + 8;
          else if (c === 38 || c === 48) {
            let v = null;
            if (p[k + 1] === 5) {
              v = p[k + 2];
              k += 2;
            } else if (p[k + 1] === 2) {
              v = nearest([p[k + 2], p[k + 3], p[k + 4]]);
              k += 4;
            }
            if (c === 38) fg = v;
            else bg = v;
          }
        }
        continue;
      }
      const ch = String.fromCodePoint(line.codePointAt(i));
      i += ch.length;
      cells.push({ ch, fg: fg ?? defFg, bg: bg ?? defBg, bold });
    }
    while (cells.length < w) cells.push({ ch: " ", fg: defFg, bg: defBg, bold: false });
    rows.push(cells.slice(0, w));
  }
  while (rows.length < h) rows.push(Array.from({ length: w }, () => ({ ch: " ", fg: defFg, bg: defBg, bold: false })));
  return rows;
}

// --- tmux driving ---
const tmux = (...args) => execFileSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const capture = () => tmux("capture-pane", "-p", "-e", "-N", "-t", "v");
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(pred, what, ms = 8000) {
  const end = Date.now() + ms;
  let last = "";
  let stable = 0;
  while (Date.now() < end) {
    const cur = capture();
    if (pred(cur) && cur === last) {
      if (++stable >= 2) return cur;
    } else stable = 0;
    last = cur;
    pause(60);
  }
  throw new Error(`timed out waiting for ${what}; last screen:\n${last.replace(/\x1b\[[0-9;:]*m/g, "")}`); // eslint-disable-line no-control-regex
}

const dir = mkdtempSync(join(tmpdir(), "reflex-tmux-verify-"));
const conf = join(dir, "tmux.conf");
writeFileSync(conf, 'set -g status off\nset -g default-terminal "tmux-256color"\nset -g escape-time 0\n');

let failed = false;
const summary = [];
try {
  for (const [W, H] of SIZES) {
    const ref = JSON.parse(readFileSync(join(PKG, "test", "golden", `reference-${W}x${H}.json`), "utf8"));
    const defFg = hexIdx(ref.defaultFg);
    const defBg = hexIdx(ref.screenBg);
    const sw = W >= 140 ? 30 : 3;
    try {
      tmux("-f", conf, "new-session", "-d", "-s", "v", "-x", String(W), "-y", String(H), `TERM=tmux-256color exec node ${JSON.stringify(PREVIEW)} --clock 08:14:07 --design-state`);
      waitFor((s) => s.includes("Reflex AI"), "first frame");
      for (let vi = 0; vi < KEYS.length; vi++) {
        tmux("send-keys", "-t", "v", KEYS[vi]);
        const shot = waitFor((s) => s.split("\n")[0].includes(`[${KEYS[vi]}]`), `view ${KEYS[vi]}`);
        const act = parseCapture(shot, W, H, defFg, defBg);
        const exp = referenceCells(ref, vi);
        // Every view opened so far is now seen and has lost its dot (the reference only has the dashboard seen).
        const dotRows = Array.from({ length: vi + 1 }, (_, j) => (sw === 30 ? [4 + 3 * j, 5 + 3 * j] : [3 + 2 * j])).flat();
        let compared = 0;
        let allowed = 0;
        const bad = [];
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            compared++;
            const a = act[y][x];
            const e = exp[y][x];
            if (a.ch === e.ch && a.fg === e.fg && a.bg === e.bg && a.bold === e.bold) continue;
            // The dot cell (" ● " in the full sidebar, "●" in the rail) turns into dim blanks once seen.
            if (x < sw && x >= sw - 3 && dotRows.includes(y) && (e.ch === "●" || e.ch === " ") && a.ch === " " && a.bg === e.bg && a.bold === e.bold) {
              allowed++;
              continue;
            }
            bad.push(`  row ${y} col ${x}: expected ${JSON.stringify(e)} got ${JSON.stringify(a)}`);
          }
        if (bad.length) failed = true;
        summary.push({ size: `${W}x${H}`, view: VIEW_IDS[vi], compared, mismatches: bad.length, allowedDot: allowed });
        if (bad.length) console.log(`${W}x${H} ${VIEW_IDS[vi]}: ${bad.length} mismatches\n${bad.slice(0, 20).join("\n")}`);
      }
      tmux("send-keys", "-t", "v", "q");
    } finally {
      try {
        tmux("kill-server");
      } catch {
        // already gone
      }
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

for (const s of summary) console.log(`${s.size} ${s.view.padEnd(10)} compared ${s.compared}  mismatches ${s.mismatches}  allowed-dot ${s.allowedDot}`);
const total = summary.reduce((a, s) => a + s.compared, 0);
const mism = summary.reduce((a, s) => a + s.mismatches, 0);
console.log(`total: ${summary.length} screens, ${total} cells compared, ${mism} mismatches`);
process.exit(failed ? 1 : 0);
