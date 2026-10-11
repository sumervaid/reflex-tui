#!/usr/bin/env node
/* global process, console */
// Extract the styled reference rendering from the Claude Design prototype.
//
//   node packages/tui/scripts/extract-reference.mjs \
//     docs/design/tui-v5/reference/agentlens-tui-v5.dc.html \
//     docs/design/tui-v5/mockups \
//     packages/tui/test/golden
//
// Only the prototype's own render functions run, inside a node:vm context that has no
// require, process, filesystem or network. For each target size the script renders all seven
// views with the prototype's initial state, checks the text cell by cell against the mockup
// dump for that size, and writes reference-<W>x<H>.json: every row as text plus style runs
// [length, fg, bg, bold]. The TUI's golden tests compare against these files.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import vm from "node:vm";

const [htmlPath, mockupDir, outDir] = process.argv.slice(2);
if (!htmlPath || !mockupDir || !outDir) {
  console.error("usage: extract-reference.mjs <prototype.dc.html> <mockup-dir> <out-dir>");
  process.exit(2);
}

const html = readFileSync(htmlPath, "utf8");
const block = html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
if (!block) throw new Error("prototype script block not found");

const context = vm.createContext({ DCLogic: class {} });
vm.runInContext(`${block[1]}\n;globalThis.__ref = { compose, TABN, ORDER, KEY, C, initial: new Component().state };`, context, {
  timeout: 10_000,
});
const { compose, TABN, ORDER, KEY, C, initial } = context.__ref;

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** Mockup dump sections keyed by view name: "=== [0] Dashboard  150x45 ===" followed by H rows. */
function readMockup(file, h) {
  const lines = readFileSync(file, "utf8").split("\n");
  const views = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^=== \[(\d)\] (\w+)\s+(\d+)x(\d+) ===$/);
    if (m) views.set(m[2], lines.slice(i + 1, i + 1 + h));
  }
  return views;
}

const SIZES = [
  [150, 45],
  [120, 40],
];
let mismatches = 0;
mkdirSync(outDir, { recursive: true });

for (const [W, H] of SIZES) {
  const mockFile = join(mockupDir, `agentlens-${W}x${H}.txt`);
  const mock = readMockup(mockFile, H);
  const views = [];
  for (const tab of ORDER) {
    const name = TABN[tab];
    const state = { ...initial, W, H, tab, size: `${W}x${H}`, sbFull: W >= 140 && initial.sb !== "rail", clock: "08:14:07", scanTime: "08:02" };
    const grid = compose(W, H, tab, state);
    const rows = grid.map((segs) => {
      const text = segs.map((s) => s.t).join("");
      const runs = segs.map((s) => [s.t.length, C[s.c] || s.c, s.b || null, s.bold ? 1 : 0]);
      return { text, runs };
    });
    const expected = mock.get(name);
    if (!expected) throw new Error(`${basename(mockFile)} has no section for ${name}`);
    rows.forEach((r, y) => {
      if (r.text !== expected[y]) {
        mismatches++;
        console.error(`${W}x${H} ${name} row ${y}:\n  prototype ${JSON.stringify(r.text)}\n  mockup    ${JSON.stringify(expected[y])}`);
      }
      if ([...r.text].length !== W) {
        mismatches++;
        console.error(`${W}x${H} ${name} row ${y}: width ${[...r.text].length}, expected ${W}`);
      }
    });
    views.push({ key: KEY(tab), name, rows });
  }
  const out = {
    source: {
      prototype: { file: basename(htmlPath), sha256: sha(html) },
      mockup: { file: basename(mockFile), sha256: sha(readFileSync(mockFile, "utf8")) },
      state: "prototype initial state (Component.state), clock 08:14:07, scanned 08:02",
    },
    size: { w: W, h: H },
    screenBg: "#1c1c1c",
    defaultFg: C.fg,
    views,
  };
  writeFileSync(join(outDir, `reference-${W}x${H}.json`), JSON.stringify(out) + "\n");
  console.log(`${W}x${H}: ${views.length} views written`);
}

if (mismatches) {
  console.error(`${mismatches} mismatches between the prototype and the mockups`);
  process.exit(1);
}
console.log("prototype output matches both mockup dumps cell for cell");
