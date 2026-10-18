import { describe, expect, it } from "vitest";
import { designData, designUi } from "../../fixture/design";
import { emptyData, liveShapeData } from "../../fixture/live-shape";
import { llen } from "../../src/render/text";
import type { Line } from "../../src/types";
import { renderTokens, tok } from "../../src/views/tokens";
import { SIZES, diffCells, linesToCells, referenceView, viewRegion } from "../harness";

const text = (l: Line): string => l.map((s) => s.t).join("");
const texts = (lines: Line[]): string[] => lines.map(text);

/** The line after the first line that starts with `heading`. */
const after = (lines: string[], heading: string): string | undefined => lines[lines.findIndex((l) => l.startsWith(heading)) + 1];

function sane(lines: Line[], w: number, h: number): void {
  expect(lines.length).toBeLessThanOrEqual(h);
  for (const l of lines) {
    expect(llen(l)).toBeLessThanOrEqual(w);
    expect(text(l)).not.toMatch(/undefined|NaN|Infinity/);
  }
}

describe("tokens view", () => {
  for (const [W, H] of SIZES) {
    const r = viewRegion(W, H);

    it(`matches the reference at ${W}x${H}`, () => {
      const out = renderTokens(r.w, r.h, designData(), designUi("tokens"));
      const d = diffCells(linesToCells(out.lines, r.w, r.h), referenceView(W, H, "tokens"));
      expect(d.count, d.report).toBe(0);
      expect(out.lines.length).toBeLessThanOrEqual(r.h);
    });

    it(`has no click targets at ${W}x${H}`, () => {
      expect(renderTokens(r.w, r.h, designData(), designUi("tokens")).hits).toEqual([]);
      expect(renderTokens(r.w, r.h, liveShapeData(), designUi("tokens")).hits).toEqual([]);
    });

    it(`renders the empty state before the first scan at ${W}x${H}`, () => {
      const out = renderTokens(r.w, r.h, emptyData(), designUi("tokens"));
      sane(out.lines, r.w, r.h);
      expect(texts(out.lines)).toEqual(["TOKENS", "not measured yet"]);
    });

    it(`shows measured tokens and no money for the live shape at ${W}x${H}`, () => {
      const out = renderTokens(r.w, r.h, liveShapeData(), designUi("tokens"));
      sane(out.lines, r.w, r.h);
      const t = texts(out.lines).map((s) => s.trimEnd());
      expect(t[0]).toBe("LAST 7 DAYS   04 oct – 10 oct   312 sessions   all time —");
      expect(t[1]).toBe("not measured yet");
      expect(t).toContain("context 203.6M tok = fresh input 9.6M + cache writes 14.2M + cache reads 179.8M, plus output 2.9M");
      expect(t).toContain("cache hit rate 88.3% of context served from cache    output share 1.4% of tokens");
      // No money anywhere, and no cost bars (the tok/d sparkline is the only block glyph line).
      expect(t.filter((l) => !l.startsWith("tok/d")).join("\n")).not.toMatch(/\$|of cost|█|▓/);
      // CLI TOOLS keeps sessions; the bar is empty and the money columns are dashes.
      const claude = t.find((l) => l.startsWith("claude"))!;
      expect(claude).toMatch(/^claude\s+201 sess\s+—\s+—\s+—$/);
      expect(after(t, "DAILY COST")).toMatch(/^not measured yet\s+not measured yet$/);
      expect(t.find((l) => l.startsWith("tok/d"))).toBe("tok/d ▄ ▂ ▆ █ █ ▅ ▇");
      expect(after(t, "MOST EXPENSIVE PROMPTS")).toBe("not measured yet");
      expect(after(t, "MOST EXPENSIVE SESSIONS")).toBe("not measured yet");
      expect(t.some((l) => /by model/.test(l))).toBe(true);
      expect(t.some((l) => /by project/.test(l))).toBe(true);
    });

    it(`says when prices were checked and which models have none at ${W}x${H}`, () => {
      const data = designData();
      Object.assign(data.window!, { pricesChecked: "11 Oct 2026", unknownModels: [{ name: "acme-large", sessions: 3 }] });
      const out = renderTokens(r.w, r.h, data, designUi("tokens"));
      expect(out.lines.length).toBeLessThanOrEqual(r.h);
      const t = texts(out.lines).map((l) => l.trimEnd());
      expect(t[0]).toMatch(/all time \$[\d,.]+ {3}API list prices of 11 Oct 2026$/);
      expect(t).toContain("unknown model acme-large (3 sess): no price, so not in any cost. Add it in ~/.reflex/prices.json");
    });
  }

  it("uses the wide variant at 140+ columns", () => {
    const out = renderTokens(160, 42, designData(), designUi("tokens"));
    const t = texts(out.lines);
    expect(t.join("\n")).toContain("█ writing answers $370.20 38%    ▓ re-reading cache $308.60 32%");
    expect(t.find((l) => l.startsWith("DAILY COST"))).toMatch(/^DAILY COST {3}max \$58\.00 {3}avg \$\d+\.\d\d {3}5 days over \$40/);
    // The stacked bar spans the full width; the chart uses 3-cell columns.
    expect(t[5]!.length).toBe(160);
    expect(t.find((l) => l.startsWith("tok/d"))!.slice(6, 9)).toMatch(/^[▁▂▃▄▅▆▇█]{2} $/);
  });

  it("formats token counts like the design", () => {
    expect([tok(412.6e6), tok(312e3), tok(1.25e9), tok(999)]).toEqual(["412.6M", "312k", "1.3B", "999"]);
  });
});
