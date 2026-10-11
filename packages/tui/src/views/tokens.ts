// Tokens view: a port of the prototype's `tokens(w, h)` (docs/design/tui-v5/reference, script block)
// with the same arithmetic, rounding and segment order. Missing measurements render "not measured yet"
// or a dim "—"; token counts are always measured, money may not be.
import type { Bar, TuiData } from "../model";
import { big, hb, hbars, vchart } from "../render/charts";
import { BOLD, S, fmt, hcat, rp, tr, usd } from "../render/text";
import type { Line, Seg, UiState, ViewOut } from "../types";

const notMeasured = (): Line => [S("not measured yet", "dim")];
const head = (t: string): Line => [S(t, "hi", BOLD)];
const DASH = (n: number): Seg => S(rp("—", n), "dim");
const SPARK = "▁▂▃▄▅▆▇█";

/** Token count in the design's style: "412.6M", "312k". */
export function tok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}

/** "85.4%" (one decimal), or a dim "—" when the denominator is zero. */
const pct1 = (a: number, b: number): Seg => (b > 0 ? S(((a / b) * 100).toFixed(1) + "%", "fg") : S("—", "dim"));

/** `by model` / `by project` bars, or the heading and "not measured yet". */
const barList = (title: string, list: Bar[] | undefined, w: number): Line[] =>
  list?.length ? hbars(title, list.slice(0, 5).map((b): [string, number] => [b.name, b.usd]), w, { nw: 11 }) : [head(title), notMeasured()];

/** The Tokens view (`w` x `h` content area). It has no click targets. */
export function renderTokens(w: number, h: number, data: TuiData, _ui: UiState): ViewOut {
  const win = data.window;
  if (!win) return { lines: [head("TOKENS"), notMeasured()], hits: [] };
  const narrow = w < 140;
  const L: Line[] = [];
  const u = win.usd;
  const allTime = data.money?.allTime.usd;
  L.push([
    S(`LAST ${win.days} DAYS`, "dim", BOLD),
    S(`   ${win.range}   ${fmt(win.sessions)} sessions`, "dim"),
    S("   all time ", "dim"),
    allTime != null ? S(usd(allTime), "fg") : S("—", "dim"),
  ]);

  if (u) {
    const bw = Math.max(16, w - 65);
    const saved = u.uncached - u.total;
    const cmpL: Line[] = [
      [S("paid             ", "dim"), S(hb(u.total, u.uncached, bw).padEnd(bw), "fg"), S("  " + usd(u.total), "hi", BOLD)],
      [S("without caching  ", "dim"), S(hb(u.uncached, u.uncached, bw), "faint"), S("  " + usd(u.uncached), "dim")],
      [S("caching saved    ", "dim"), S(usd(saved), "ok", BOLD), S("  " + Math.round((saved / (u.uncached || 1)) * 100) + "% off the uncached price", "dim")],
    ];
    big(usd(u.total)).forEach((t, i) => L.push([S(t, "hi"), S(" ".repeat(Math.max(3, 36 - t.length))), ...cmpL[i]!]));
    L.push([]);
    const tot = u.total || 1;
    const parts: Array<[string, string, number]> = narrow
      ? [["█", "output", u.output], ["▓", "cache reads", u.cacheRead], ["▒", "cache writes", u.cacheWrite], ["░", "fresh input", u.input]]
      : [["█", "writing answers", u.output], ["▓", "re-reading cache", u.cacheRead], ["▒", "saving to cache", u.cacheWrite], ["░", "reading new input", u.input]];
    let acc = 0;
    const bar: Line = [];
    parts.forEach(([c, , v], i) => {
      const n = Math.max(0, Math.min(w - acc, i === parts.length - 1 ? w - acc : Math.round((v / tot) * w)));
      acc += n;
      bar.push(S(c.repeat(n), "gb"));
    });
    L.push(bar, bar);
    const leg: Line = [];
    parts.forEach(([c, n, v], i) => {
      if (i) leg.push(S("    "));
      leg.push(S(c + " ", "gb"), S(n + " ", "fg"), S(usd(v), "hi"), S(" " + Math.round((v / tot) * 100) + "%", "dim"));
    });
    L.push(leg);
  } else L.push(notMeasured(), []);

  const t = win.tokens;
  const ctx = t.input + t.cacheWrite + t.cacheRead;
  L.push([
    S("context ", "dim"),
    S(tok(ctx), "fg"),
    S(` tok = fresh input ${tok(t.input)} + cache writes ${tok(t.cacheWrite)} + cache reads ${tok(t.cacheRead)}, plus output `, "dim"),
    S(tok(t.output), "fg"),
  ]);
  const hit: Line = [S("cache hit rate ", "dim"), pct1(t.cacheRead, ctx), S(" of context served from cache    output share ", "dim"), pct1(t.output, ctx + t.output)];
  if (u) hit.push(S(" of tokens, ", "dim"), S(Math.round((u.output / (u.total || 1)) * 100) + "%", "fg"), S(" of cost", "dim"));
  else hit.push(S(" of tokens", "dim"));
  L.push(hit);
  L.push([]);

  const tbw = Math.max(10, w - 66);
  if (data.tools.length) {
    L.push([
      S(tr("CLI TOOLS", 22), "hi", BOLD),
      S(tr(`cost share, last ${win.days} days`, tbw), "dim"),
      S(rp(`${win.days} days`, 10), "dim"),
      S(rp("share", 6), "dim"),
      S(rp("all time", 14), "dim"),
    ]);
    for (const r of data.tools) {
      const v = u ? r.usd : undefined;
      const tot = u?.total || 1;
      L.push([
        S(tr(r.tool, 9), "fg"),
        S(rp(r.sessions, 5) + " sess   ", "dim"),
        v != null ? S(hb(v, tot, tbw).padEnd(tbw), "gb") : S(" ".repeat(tbw)),
        v != null ? S(rp(usd(v), 10), "hi") : DASH(10),
        v != null ? S(rp(Math.round((v / tot) * 100) + "%", 6), "dim") : DASH(6),
        r.allTimeUsd != null ? S(rp(usd(r.allTimeUsd), 14), "fg") : DASH(14),
      ]);
    }
  } else L.push(head("CLI TOOLS"), notMeasured());
  L.push([]);

  const cw = narrow ? 2 : 3;
  const rows = 10;
  const chartW = 28 * cw + 6;
  const pw = Math.max(1, w - chartW - 4);
  const days = (data.days ?? []).slice(-28);
  const left: Line[] = [];
  if (days.some((d) => d.usd != null)) {
    const cost = days.map((d) => d.usd ?? 0);
    const cmax = Math.max(...cost);
    const budget = data.money?.dailyBudget;
    const bLabel = budget != null ? "$" + fmt(budget) : "";
    const bRow = budget != null ? rows - 1 - Math.floor((budget / cmax) * rows) : -1;
    const ch = vchart(cost, rows, cw, (v) => (budget != null && v > budget ? "warn" : "gb"), {
      line: budget,
      max: cmax || 1,
      axis: (r) =>
        r === 0 ? rp("$" + Math.round(cmax), 5) + " " : r === bRow ? rp(bLabel, 5) + " " : r === rows - 1 ? rp("$0", 5) + " " : "      ",
    });
    // x labels every 7 days, the last one right-aligned; a label that would touch the last one is dropped.
    const N = days.length;
    const lastP = Math.max(0, N * cw - days[N - 1]!.label.length);
    let xl = " ".repeat(28 * cw);
    [...[0, 7, 14, 21].filter((i) => i < N - 1 && i * cw + days[i]!.label.length < lastP), N - 1].forEach((i) => {
      const lb = days[i]!.label;
      const p = i === N - 1 ? lastP : i * cw;
      xl = xl.slice(0, p) + lb + xl.slice(p + lb.length);
    });
    const avg = cost.reduce((a, b) => a + b, 0) / N;
    const hd: Line = [S("DAILY COST", "hi", BOLD), S("   max " + usd(cmax) + (narrow ? "   " : "   avg " + usd(avg) + "   "), "dim")];
    if (budget != null) hd.push(S(cost.filter((v) => v > budget).length + " days over " + bLabel, "warn"));
    left.push(hd, ...ch, [S("      "), S(xl.slice(0, 28 * cw), "dim")]);
  } else left.push(head("DAILY COST"), notMeasured());
  if (days.some((d) => d.tokens != null)) {
    const tmax = Math.max(...days.map((d) => d.tokens ?? 0)) || 1;
    left.push([
      S("tok/d ", "dim"),
      ...days.map((d) => S(d.tokens == null ? " ".repeat(cw) : SPARK[Math.min(7, Math.floor((d.tokens / tmax) * 7.999))]!.repeat(cw - 1) + " ", "faint")),
    ]);
  }
  const right: Line[] = [...barList("by model", win.byModel, pw), [], ...barList("by project", win.byProject, pw)];
  L.push(...hcat([{ lines: left, w: chartW }, { lines: right, w: pw }], 4));
  L.push([]);

  const rem = h - L.length;
  const n = Math.max(2, Math.min(6, Math.floor((rem - 3) / 2)));
  const prompts = data.topPrompts ?? [];
  if (prompts.length) {
    const pm = prompts[0]!.usd;
    L.push([S("MOST EXPENSIVE PROMPTS", "hi", BOLD), S("   the message that started the spend", "dim")]);
    prompts
      .slice(0, n)
      .forEach((p) => L.push([S(rp(usd(p.usd), 7), "hi"), S(" "), S(hb(p.usd, pm, 10).padEnd(10), "gb"), S("  "), S(tr(p.project, 12), "dim"), S("  "), S(p.text, "fg")]));
  } else L.push(head("MOST EXPENSIVE PROMPTS"), notMeasured());
  L.push([]);
  const sessions = data.topSessions ?? [];
  if (sessions.length) {
    const sm = sessions[0]!.usd;
    L.push([S("MOST EXPENSIVE SESSIONS", "hi", BOLD), S("   date · source · project · class · turns · tools · context", "dim")]);
    sessions.slice(0, n).forEach((s) =>
      L.push([
        S(rp(usd(s.usd), 7), "hi"),
        S(" "),
        S(hb(s.usd, sm, 10).padEnd(10), "gb"),
        S("  "),
        S(s.date + "  ", "dim"),
        S(tr(s.tool, 7), "dim"),
        S(tr(s.project, 12), "fg"),
        S(tr(s.kind, 11), "fg"),
        S(rp(s.turns, 4) + "t ", "dim"),
        S(rp(s.toolCalls, 4) + "x ", "dim"),
        S(rp(tok(s.contextTokens), 5) + "  ", "dim"),
        S(s.prompt, "fg"),
      ]),
    );
  } else L.push(head("MOST EXPENSIVE SESSIONS"), notMeasured());
  return { lines: L, hits: [] };
}
