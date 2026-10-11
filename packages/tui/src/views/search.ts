import type { TuiData, Turn } from "../model";
import { BOLD, S, box, fit, fmt, hcat, hl, llen, rp, toCells, tr, usd, wrap } from "../render/text";
import { COLOR, TOOL_FILTERS, type Hit, type Line, type UiState, type ViewOut } from "../types";

/** First results row to show so the selected hit stays centered (prototype `searchTop`). Each hit takes 3 rows. */
export function searchTop(sel: number, n: number, bh: number): number {
  const vis = bh - 2;
  return Math.max(0, Math.min(sel * 3 - Math.floor(vis / 2), n * 3 - vis));
}

/**
 * Search (prototype `search`): query line, tool filter, results list and the selected turn in its
 * session. The query line shows `ui.query`; hits and highlights use `ui.searchQuery`. Without an
 * index the view keeps its frame and says "not indexed yet".
 */
export function renderSearch(w: number, h: number, data: TuiData, ui: UiState): ViewOut {
  const idx = data.search;
  const q = ui.searchQuery.trim();
  const hits: Turn[] = idx ? idx.query(q, ui.tool) : [];
  const sel = Math.max(0, Math.min(ui.sel.search || 0, hits.length - 1));
  const L: Line[] = [];
  const ns = new Set(hits.map((t) => t.session)).size;
  const query = toCells(ui.query);
  const ql: Line = [S(" / ", "hi", { bold: true, b: COLOR.key }), S("  "), S(query, query ? "hi" : "dim"), S(ui.typing ? "▏" : "", "hi")];
  if (!query && !ui.typing) ql.push(S("press / and type to search every turn", "dim"));
  const qr: Line = idx
    ? [S(fmt(hits.length) + " turns", "fg"), S(" in ", "dim"), S(fmt(ns) + " sessions", "fg"), S("   ·   " + fmt(idx.indexed) + " turns indexed", "dim")]
    : [S("not indexed yet", "dim")];
  L.push([...ql, S(" ".repeat(Math.max(2, w - llen(ql) - llen(qr)))), ...qr]);
  const tl: Line = [S("tool  ", "dim")];
  TOOL_FILTERS.forEach((t) => {
    const on = t === ui.tool;
    tl.push(S(on ? "[" + t + "]" : " " + t + " ", on ? "hi" : "dim", on ? BOLD : null), S(" "));
  });
  tl.push(S("   tab cycles · searches your prompts and the replies", w < 140 ? "faint" : "dim"));
  L.push(tl);
  L.push([]);

  const lw = Math.round(w * 0.5);
  const rw = w - lw - 1;
  const bh = h - 3;
  const iw = lw - 4;
  const rl: Line[] = [];
  hits.forEach((t, i) => {
    const s = i === sel;
    const bg = s ? COLOR.sel : null;
    rl.push(fit([S(s ? "▸ " : "  ", "hi"), S(t.date + "  ", s ? "hi" : "fg"), S(tr(t.tool, 8), "fg"), S(tr(t.project, 13), "dim"), S(rp("turn " + t.turn, 9), "dim")], iw, bg));
    const j = q ? t.text.toLowerCase().indexOf(q.toLowerCase()) : 0;
    const s0 = Math.max(0, j - 22);
    const sn = (s0 ? "…" : "") + t.text.slice(s0);
    rl.push(fit([S("  "), S(t.role === "you" ? "you  " : "ai   ", t.role === "you" ? "gb" : "faint"), ...hl(sn, q, s ? "fg" : "dim")], iw, bg));
    rl.push([]);
  });
  if (!idx) rl.push([S("not indexed yet", "dim")]);
  else if (!hits.length) rl.push([S('no turns match "' + toCells(q) + '"', "dim")]);
  const top = searchTop(sel, hits.length, bh);
  const left = box(lw, bh, "results", rl, { sub: idx ? (hits.length ? sel + 1 + "/" + hits.length : "0") : "", scroll: top });

  const T = idx ? hits[sel] : undefined;
  let pr: Line[] = [];
  let selAt = 0;
  if (T && idx) {
    const ctx = idx.session(T.session);
    const all = [...ctx.turns].sort((a, b) => a.turn - b.turn);
    const ci = all.findIndex((x) => x.turn === T.turn);
    pr.push([S(T.tool + " · " + T.project + " · " + T.date, "hi", BOLD)]);
    pr.push([S("session " + T.session + "   " + (ctx.turnCount || "—") + " turns   " + (ctx.usd ? usd(ctx.usd) : "—"), "dim")]);
    pr.push([]);
    let prev = 0;
    all.forEach((x, k) => {
      if (x.turn - prev > 1) pr.push([S("  ⋮ " + (x.turn - prev - 1) + " turns", "faint")]);
      prev = x.turn;
      const cur = k === ci;
      if (cur) selAt = pr.length;
      const bar = S(cur ? "▌ " : "  ", cur ? "hi" : "dim");
      pr.push([bar, S("turn " + x.turn + "  ", "dim"), S(x.role === "you" ? "you" : x.tool, x.role === "you" ? "gb" : "dim", BOLD)]);
      wrap(x.text, rw - 8).forEach((ln) => pr.push([bar, ...hl(ln, q, cur ? "fg" : "dim")]));
      pr.push([]);
    });
    if (ctx.files) pr.push([S("files  ", "dim"), S(ctx.files, "fg")]);
    if (pr.length > bh - 2 && selAt > 4) pr = pr.slice(0, 2).concat([[S("  ⋮", "faint")]], pr.slice(Math.min(selAt - 1, pr.length - (bh - 5))));
  }
  const right = box(rw, bh, T ? "turn " + T.turn + " in context" : "preview", pr, { sub: T ? "enter resumes in " + T.tool : "", scroll: ui.previewScroll });

  // Results start at view line 4 (query, tool line, blank, box top). The first two rows of a hit select it.
  const ih = bh - 2;
  const out: Hit[] = [];
  hits.forEach((_, i) => {
    const y0 = Math.max(4, 4 + 3 * i - top);
    const y1 = Math.min(4 + ih, 4 + 3 * i - top + 2);
    if (y1 > y0) out.push({ x0: 0, x1: lw, y0, y1, action: { type: "select", list: "search", index: i } });
  });
  if (T) out.push({ x0: lw + 1, x1: w, y0: 3, y1: 3 + bh, action: { type: "scroll", pane: "preview" } });
  return { lines: L.concat(hcat([{ lines: left, w: lw }, { lines: right, w: rw }], 1)), hits: out };
}
