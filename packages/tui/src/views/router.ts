import type { TuiData } from "../model";
import { big, hb } from "../render/charts";
import { BOLD, S, fit, fmt, hcat, rp, tr, usd } from "../render/text";
import { COLOR, type Hit, type Line, type UiState, type ViewOut } from "../types";

// Port of the prototype's `router(w, h, st)` (docs/design/tui-v5/reference, script block). Same
// arithmetic, rounding and segment order; the mock constants come from `data.router` instead.

/** 5 Router: autopilot banner, build line, savings hero, the task list (2 rows per task) and the evidence behind the selected pick. */
export function renderRouter(w: number, h: number, data: TuiData, ui: UiState): ViewOut {
  const R = data.router;
  const L: Line[] = [];
  const hits: Hit[] = [];
  if (!R) {
    L.push([S(" AUTOPILOT ", "hi", { bold: true, b: COLOR.sel }), S("  not available yet", "dim")]);
    L.push([]);
    L.push([S("not measured yet", "dim")]);
    return { lines: L.slice(0, h), hits };
  }

  const narrow = w < 140;
  const on = R.autopilot;
  const tasks = R.tasks;
  L.push([
    S(" AUTOPILOT ", "hi", { bold: true, b: on ? COLOR.autopilot : COLOR.sel }),
    S("  "),
    S(on ? "ON" : "OFF", on ? "ok" : "dim", BOLD),
    S(on ? "   reflex run starts each task on the pick" : "   reflex run shows the pick and asks first", "fg"),
    S("   space turns " + (on ? "off" : "on"), "dim"),
  ]);
  L.push([
    S("built automatically from ", "dim"),
    S(fmt(R.sessions) + " sessions", "fg"),
    S(" in your history · ", "dim"),
    S(tasks.length + " kinds of task", "fg"),
    S(" found · rebuilt " + (ui.scanning ? "now…" : R.rebuiltAt) + (narrow ? "" : ", and again on every rescan"), "dim"),
  ]);
  L.push([]);

  const sw = tasks.filter((t) => t.rec !== t.most).length;
  const bs = big("$" + Math.round(R.monthlySaving));
  const how: Line[] = [
    [S("how it decides", "dim", BOLD)],
    [S("1 ", "dim"), S("sorts every past session by the kind of task it was")],
    [S("2 ", "dim"), S(narrow ? "compares your models on cost and how often they need fixing" : "compares the models you used on cost and how often they needed fixing")],
    [S("3 ", "dim"), S("picks the cheapest one that was about as reliable as the best")],
  ];
  const hero: Line[] = [
    [S("a month of savings", "dim", BOLD)],
    ...bs.map((t, i): Line => [
      S(t, "ok"),
      S(i === 1 ? "   if you follow every pick" : i === 2 ? "   " + sw + " switches, " + R.movedSessions + " sessions" : "", "dim"),
    ]),
  ];
  L.push(
    ...hcat(
      [
        { lines: hero, w: 44 },
        { lines: how, w: w - 48 },
      ],
      4,
    ),
  );
  L.push([]);

  const nw = narrow ? 15 : 16;
  const mw = 12;
  L.push([
    S("  "),
    S(tr("YOUR TASKS", nw), "hi", BOLD),
    S("  "),
    S(tr("use", mw + 4), "dim"),
    S(tr(narrow ? "" : "instead of", narrow ? 0 : mw + 3), "dim"),
    S(tr(narrow ? "saves" : "saves each time", narrow ? 12 : 17), "dim"),
    S(tr("confidence", narrow ? 18 : 22), "dim"),
    S("verdict", "dim"),
  ]);
  if (!tasks.length) {
    L.push([S("  "), S("not measured yet", "dim")]);
  }
  // The app clamps the selection; clamp here too so a shrinking list never selects nothing.
  const si = Math.min(Math.max(0, ui.sel.router), tasks.length - 1);
  tasks.forEach((r, i) => {
    const sel = i === si;
    const ch = r.rec !== r.most;
    const learn = r.evidence.filter((e) => e.sessions >= R.minSupport).length < 2;
    const changed = !!r.previous && r.previous !== r.rec;
    const bg = sel ? COLOR.sel : null;
    const dots = Math.min(5, Math.ceil(r.sessions / 15));
    const rec = r.evidence.find((e) => e.model === r.rec);
    const most = r.evidence.find((e) => e.model === r.most);
    const pct = rec && most && most.usd > 0 ? Math.round((1 - rec.usd / most.usd) * 100) : null;
    const verdict = learn ? S("LEARNING", "dim", BOLD) : ch ? S("SWITCH", "ok", BOLD) : S("KEEP", "fg", BOLD);
    const y0 = L.length;
    L.push(
      fit(
        [
          S(sel ? "▸ " : "  ", "hi"),
          S(tr(r.name, nw), sel ? "hi" : "fg", sel ? BOLD : null),
          S("  "),
          S(tr(r.rec, mw), ch ? "ok" : "fg", ch ? BOLD : null),
          S("    "),
          S(narrow ? "" : tr(ch ? r.most : "", mw + 3), "dim"),
          S(tr(r.save > 0 ? usd(r.save) : "—", narrow ? 12 : 17), r.save > 0 ? "hi" : "dim"),
          S("●".repeat(dots), "fg"),
          S("○".repeat(5 - dots), "faint"),
          S(tr(" " + r.sessions + " sessions", narrow ? 13 : 17), "dim"),
          verdict,
          S(changed ? "   changed today" : "", "warn"),
        ],
        w,
        bg,
      ),
    );
    const why = learn
      ? "only " + r.most + " has enough sessions so far · try another model on this kind of task to compare"
      : ch
        ? "just as reliable as " + r.most + (pct === null ? "" : ", " + pct + "% cheaper")
        : r.most + " is already the cheapest reliable choice";
    L.push(fit([S("  "), S(" ".repeat(nw + 2)), S(why, "dim")], w, bg));
    if (y0 < h) hits.push({ x0: 0, x1: w, y0, y1: Math.min(h, y0 + 2), action: { type: "select", list: "router", index: i } });
  });
  L.push([]);

  const T = tasks[si];
  if (T) {
    const cmx = Math.max(...T.evidence.map((e) => e.usd)) || 1;
    const fmx = Math.max(...T.evidence.map((e) => e.friction)) || 1;
    const bw = narrow ? 14 : 20;
    L.push([
      S("WHY " + T.rec.toUpperCase() + " FOR " + T.name.toUpperCase(), "hi", BOLD),
      S("   cost per session", "dim"),
      S(" ".repeat(bw - 6)),
      S("needs fixing (per 10 replies)", "dim"),
    ]);
    T.evidence.forEach(({ model: m, sessions: n, usd: c, friction: fr }) => {
      const ex = n < R.minSupport;
      const worse = fr > T.best + R.margin + 1e-9;
      const pick = m === T.rec;
      const tag = pick
        ? S("picked", "ok", BOLD)
        : ex
          ? S("too few sessions (" + n + ")", "dim")
          : worse
            ? S("less reliable", "warn")
            : S("reliable, costs more", "dim");
      L.push([
        S("  "),
        S(tr(m, 14), pick ? "ok" : "fg"),
        S(hb(c, cmx, bw).padEnd(bw), pick ? "ok" : "gb"),
        S(rp(usd(c), 7) + "   ", "fg"),
        S(hb(fr, fmx, bw).padEnd(bw), worse ? "warn" : "faint"),
        S(rp((fr * 10).toFixed(1), 5) + "    ", "fg"),
        tag,
      ]);
    });
    L.push([]);
  }
  L.push([
    S("rules ", "dim"),
    S(R.policyFile),
    S(
      narrow
        ? '   "needs fixing" = corrections + tool errors + repeats'
        : '    "needs fixing" counts your corrections, tool errors and repeated commands',
      "dim",
    ),
  ]);
  return { lines: L.slice(0, h), hits };
}
