// Dashboard (view 0): usage limits, the KPI strip, NEEDS A LOOK and the last 14 days by tool.
// Port of the prototype's `dashboard()` (docs/design/tui-v5/reference, script block): same widths,
// rounding and segment order. Missing measurements render "not measured yet" or a dim "—".
import type { Day, ToolLimits, TuiData } from "../model";
import { big } from "../render/charts";
import { BOLD, S, box, fmt, hcat, rp, tr, usd, type Block } from "../render/text";
import { viewKey, type ColorToken, type Hit, type Line, type UiState, type ViewOut } from "../types";

const NOT_MEASURED = "not measured yet";

/** Limit color: red at 90%, yellow at 70%. */
const lc = (p: number): ColorToken => (p >= 90 ? "bad" : p >= 70 ? "warn" : "fg");

const plural = (n: number, word: string): string => `${fmt(n)} ${word}${n === 1 ? "" : "s"}`;

/** One 10-row card per tool, side by side with a 1-cell gap; the last card takes the remainder. */
function limitCards(w: number, limits: ToolLimits[]): Line[] {
  const gap = 1;
  const n = limits.length;
  const cw = Math.floor((w - (n - 1) * gap) / n);
  const cards: Block[] = limits.map((x, ci) => {
    const bw0 = ci === n - 1 ? w - (n - 1) * cw - (n - 1) * gap : cw;
    const iw = bw0 - 4;
    const bars = x.bars.map((b) => ({ ...b, pct: Math.round(b.pct) }));
    const inner: Line[] = [];
    if (bars.length) {
      const top = bars.reduce((a, b) => (b.pct > a.pct ? b : a));
      big(top.pct + "%").forEach((t, i) =>
        inner.push([
          S(t, lc(top.pct)),
          S("   "),
          i === 0 ? S(top.label + " used", "fg") : i === 1 ? S("resets " + top.resets, "dim") : S("highest of " + bars.length, "faint"),
        ]),
      );
      inner.push([]);
      const bw = Math.max(6, iw - 9 - 5 - 10);
      bars.forEach(({ label, pct, resets }) => {
        const fl = Math.min(bw, Math.max(0, Math.round((pct / 100) * bw)));
        const c = lc(pct);
        inner.push([S(tr(label, 8) + " ", "dim"), S("█".repeat(fl), c === "fg" ? "gb" : c), S("░".repeat(bw - fl), "faint"), S(rp(pct + "%", 5), c, BOLD), S(rp(resets, 10), "dim")]);
      });
    } else inner.push([S(NOT_MEASURED, "dim")]);
    while (inner.length < 7) inner.push([]);
    if (x.pace) inner.push([S(x.pace.text, x.pace.tone)]);
    return { lines: box(bw0, 10, x.tool + " · " + x.plan, inner), w: bw0 };
  });
  return hcat(cards, gap);
}

type Kpi = { label: string; value?: string; color: ColorToken; sub?: string; subColor?: ColorToken };

/** The six KPI columns. A missing value is a dim "—"; a sub-line that needs missing data reads "not measured yet". */
function kpis(data: TuiData): Kpi[] {
  const { money, window: win, router } = data;
  const days: Day[] = data.days ?? [];
  const y = days[days.length - 1]?.usd;
  const prior = days.slice(-8, -1);
  const avg = prior.length && prior.every((d) => d.usd != null) ? prior.reduce((a, d) => a + d.usd!, 0) / prior.length : undefined;
  const dp = y != null && avg ? Math.round((y / avg - 1) * 100) : undefined;
  const wd = win?.days;
  return [
    {
      label: "TODAY",
      value: money?.today.usd !== undefined ? usd(money.today.usd) : undefined,
      color: "fg",
      sub: money && (money.today.unpriced ? `${plural(money.today.sessions, "session")} · ${money.today.unpriced} Cursor, no cost recorded` : plural(money.today.sessions, "session") + " so far"),
    },
    {
      label: "YESTERDAY",
      value: y != null ? usd(y) : undefined,
      color: "hi",
      sub: dp != null ? (dp > 0 ? "+" : "") + dp + "% vs usual" : undefined,
      subColor: dp != null && dp > 0 ? "warn" : "ok",
    },
    { label: wd != null ? `${wd} DAY${wd === 1 ? "" : "S"}` : "30 DAYS", value: win?.usd && usd(win.usd.total), color: "hi", sub: win && plural(win.sessions, "session") },
    { label: "ALL TIME", value: money && usd(money.allTime.usd), color: "hi", sub: money && "since " + money.allTime.since },
    {
      label: "CACHE SAVED",
      value: win?.usd && usd(win.usd.uncached - win.usd.total),
      color: "ok",
      sub: win?.usd && `last ${wd} day${wd === 1 ? "" : "s"}`,
    },
    { label: "ROUTER", value: router && "$" + Math.round(router.monthlySaving) + "/mo", color: "ok", sub: router && "if you follow picks" },
  ];
}

/** Stacked bars per day (█ claude, ▓ codex, ░ cursor), yesterday's bar brighter, first date and "yday" below. */
function byToolChart(days: Day[], h: number): Line[] {
  const head = S("LAST 14 DAYS BY TOOL", "hi", BOLD);
  if (!days.length || !days.every((d) => d.byTool)) return [[head], [S(NOT_MEASURED, "dim")]];
  const rows = Math.max(6, Math.min(12, h - 22));
  const dcw = 3;
  const split = days.map((d) => [d.byTool!.claude ?? 0, d.byTool!.codex ?? 0, d.byTool!.cursor ?? 0] as const);
  const mx = Math.max(...days.map((d, i) => d.usd ?? split[i]![0] + split[i]![1] + split[i]![2])) || 1;
  const out: Line[] = [[head, S("   █ claude  ▓ codex  ░ cursor", "dim")]];
  for (let r = rows; r >= 1; r--) {
    const l: Line = [];
    split.forEach(([a, b, c2], i) => {
      const t = ((a + b + c2) / mx) * rows;
      const ha = (a / mx) * rows;
      const hb2 = ((a + b) / mx) * rows;
      const ch = r <= Math.round(ha) ? "█" : r <= Math.round(hb2) ? "▓" : r <= Math.round(t) ? "░" : " ";
      l.push(S(ch.repeat(dcw - 1) + " ", i === split.length - 1 ? "fg" : "gb"));
    });
    out.push(l);
  }
  out.push([S(days[0]!.label, "faint"), S(" ".repeat(Math.max(1, days.length * dcw - 12))), S("yday", "faint")]);
  return out;
}

/** The dashboard in the content area (`w` x `h`). Hits: each NEEDS A LOOK row jumps to its view. */
export function renderDashboard(w: number, h: number, data: TuiData, _ui: UiState): ViewOut {
  const L: Line[] = [];
  const hits: Hit[] = [];
  L.push([S("USAGE LIMITS", "hi", BOLD), S("   how much of each plan you have used · estimated from local usage", "dim")]);
  L.push([]);
  if (data.limits?.length) {
    L.push(...limitCards(w, data.limits));
    L.push([S((data.plansFile ? `plans in ${data.plansFile} · ` : "") + "red at 90%, yellow at 70%", "faint")]);
  } else L.push([S(NOT_MEASURED, "dim")]);
  L.push([]);

  const K = kpis(data);
  const kw = Math.floor(w / K.length);
  L.push(
    ...hcat(
      K.map(
        ({ label, value, color, sub, subColor }, i): Block => ({
          lines: [[S(label, "dim", BOLD)], [value != null ? S(value, color, BOLD) : S("—", "dim")], [sub != null ? S(sub, subColor ?? "dim") : S(NOT_MEASURED, "dim")]],
          w: i === K.length - 1 ? w - kw * (K.length - 1) : kw - 2,
        }),
      ),
      2,
    ),
  );
  L.push([]);

  const lw = Math.round(w * 0.5);
  const rw = w - lw - 4;
  const att = data.attention.slice(0, 5);
  const left: Line[] = [[S("NEEDS A LOOK", "hi", BOLD)]];
  if (att.length) {
    att.forEach((a, i) => {
      left.push([S("● ", a.tone), S(tr(a.text, lw - 8), "fg"), S(rp("[" + viewKey(a.view) + "]", 6), "dim")]);
      const y = L.length + 1 + i;
      hits.push({ x0: 0, x1: lw, y0: y, y1: y + 1, action: { type: "view", view: a.view } });
    });
  } else left.push([S("nothing needs a look", "dim")]);
  L.push(...hcat([{ lines: left, w: lw }, { lines: byToolChart((data.days ?? []).slice(-14), h), w: rw }], 4));

  return { lines: L.slice(0, h), hits: hits.filter((x) => x.y0 < h) };
}
