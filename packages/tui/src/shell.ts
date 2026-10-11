// The app shell (prototype `sidebar`, `topbar`, `statusbar`, `compose`): top bar, sidebar (full or
// rail), the current view in the content area, status bar and the toast overlay, plus hit regions.
import type { ItemList, LimitBar, TuiData } from "./model";
import { BOLD, S, fit, fmt, llen, toCells, usd } from "./render/text";
import {
  COLOR,
  VIEW_NAMES,
  VIEW_ORDER,
  viewKey,
  type ColorToken,
  type Frame,
  type Hex,
  type Hit,
  type Line,
  type Row,
  type Run,
  type Tone,
  type UiState,
  type ViewId,
  type ViewOut,
} from "./types";
import { renderDashboard } from "./views/dashboard";
import { renderItems } from "./views/items";
import { renderMorning } from "./views/morning";
import { renderRouter } from "./views/router";
import { renderSearch } from "./views/search";
import { renderTokens } from "./views/tokens";

/** Full sidebar width and rail width (prototype `SBW`, `RAILW`). */
export const SBW = 30;
export const RAILW = 3;
const SBG = COLOR.sidebar;

/** The full sidebar needs 140+ columns and the user's choice; otherwise the 3-column rail. */
export const sidebarWidth = (W: number, ui: Pick<UiState, "sidebar">): number => (W >= 140 && ui.sidebar === "full" ? SBW : RAILW);

type Render = (w: number, h: number, data: TuiData, ui: UiState) => ViewOut;
const RENDER: Record<ViewId, Render> = {
  dashboard: renderDashboard,
  morning: renderMorning,
  tokens: renderTokens,
  skills: (w, h, d, u) => renderItems("skills", w, h, d, u),
  workflows: (w, h, d, u) => renderItems("workflows", w, h, d, u),
  router: renderRouter,
  search: renderSearch,
};

/** Limit color (prototype `lc`): red at 90%, yellow at 70%. */
const lc = (p: number): ColorToken => (p >= 90 ? "bad" : p >= 70 ? "warn" : "fg");

/** Token counts for display: 412.6M, 312k. */
const tok = (n: number): string => (n >= 999.5e3 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));

const notMeasured = (): Line => [S("not measured yet", "dim")];

/** The highest limit bar across all tools (the first one wins a tie, like the prototype's cards). */
function topLimit(data: TuiData): LimitBar | undefined {
  let top: LimitBar | undefined;
  for (const l of data.limits ?? []) for (const b of l.bars) if (!top || b.pct > top.pct) top = b;
  return top;
}

/** Yesterday's cost and the average of the 7 days before it, when they were measured. */
function yesterdayVsAvg(data: TuiData): { y: number; avg?: number } | undefined {
  const days = data.days ?? [];
  const y = days[days.length - 1]?.usd;
  if (y === undefined) return undefined;
  const prev = days.slice(-8, -1);
  if (prev.length < 7 || prev.some((d) => d.usd === undefined)) return { y };
  const avg = prev.reduce((a, d) => a + d.usd!, 0) / 7;
  return avg > 0 ? { y, avg } : { y };
}

function itemCounts(list: ItemList | undefined, empty: string, asEvidence = false): Line {
  if (!list) return notMeasured();
  if (!list.items.length) return [S(empty, "dim")];
  if (asEvidence) return [S(fmt(list.items.length) + " found", "fg"), S(" · ", "dim"), S(list.items.filter((x) => x.on).length + " installed", "ok")];
  const n = (k: string): number => list.items.filter((x) => x.state === k).length;
  return [S(n("new") + " new", "ok"), S(" · ", "dim"), S(n("updated") + " upd", "warn"), S(" · ", "dim"), S(n("retired") + " ret", "bad")];
}

/** One summary line per view, shown under its sidebar title (prototype `summaries`). */
export function summaries(data: TuiData): Record<ViewId, Line> {
  const top = topLimit(data);
  const money = data.money;
  const dashboard: Line = [];
  if (top) dashboard.push(S(top.short + " ", "dim"), S(Math.round(top.pct) + "%", lc(top.pct), BOLD));
  if (money) dashboard.push(S(top ? " · today " : "today ", "dim"), S(usd(money.today.usd), "fg"));

  const yd = yesterdayVsAvg(data);
  let morning: Line = notMeasured();
  if (yd) {
    morning = [S(usd(yd.y), "fg")];
    if (yd.avg !== undefined) {
      const dp = Math.round((yd.y / yd.avg - 1) * 100);
      morning.push(S("  " + (dp > 0 ? "+" : "") + dp + "% vs avg", dp > 0 ? "warn" : "ok"));
    }
  }

  const win = data.window;
  let tokens: Line = notMeasured();
  if (win) {
    const last = S(` · last ${win.days} day${win.days === 1 ? "" : "s"}`, "dim");
    if (win.usd) tokens = [S(usd(win.usd.total), "fg"), last];
    else {
      const t = win.tokens;
      tokens = [S(tok(t.input + t.cacheWrite + t.cacheRead + t.output) + " tok", "fg"), last];
    }
  }

  const r = data.router;
  const router: Line = r
    ? [S(r.tasks.filter((t) => t.rec !== t.most).length + " switches", "ok"), S(" · autopilot ", "dim"), S(r.autopilot ? "on" : "off", r.autopilot ? "ok" : "dim")]
    : notMeasured();

  const search: Line = [S("/ ", "hi", BOLD), S(data.search ? fmt(data.search.indexed) + " turns indexed" : "not indexed yet", "dim")];

  return {
    dashboard: dashboard.length ? dashboard : notMeasured(),
    morning,
    tokens,
    skills: itemCounts(data.skills, "no skills yet"),
    workflows: itemCounts(data.workflows, "no workflows yet", !!data.workflows && !data.workflows.runAs),
    router,
    search,
  };
}

/**
 * Attention dot per view (HANDOFF "Attention dots"), or null. A view loses its dot once it is in
 * `ui.seen`. Tokens and Search never get one.
 */
export function attention(data: TuiData, ui: Pick<UiState, "seen">): Record<ViewId, Tone | null> {
  const yd = yesterdayVsAvg(data);
  const isNew = (list?: ItemList): boolean => !!list?.items.some((x) => x.state === "new");
  const dots: Record<ViewId, Tone | null> = {
    dashboard: (data.limits ?? []).some((l) => l.bars.some((b) => b.pct >= 70)) ? "warn" : null,
    morning: yd?.avg !== undefined && yd.y > yd.avg ? "warn" : null,
    tokens: null,
    skills: isNew(data.skills) ? "ok" : null,
    workflows: isNew(data.workflows) ? "ok" : null,
    router: data.router?.tasks.some((t) => t.previous !== undefined) ? "warn" : null,
    search: null,
  };
  for (const v of ui.seen) dots[v] = null;
  return dots;
}

/** The sidebar, `h` rows of exactly `sw` cells (prototype `sidebar`). */
function sidebar(sw: number, h: number, data: TuiData, ui: UiState): Line[] {
  const att = attention(data, ui);
  const L: Line[] = [];
  if (sw === RAILW) {
    L.push(fit([S(" ◆", "hi", BOLD)], sw, SBG));
    L.push(fit([], sw, SBG));
    for (const v of VIEW_ORDER) {
      const sel = v === ui.view;
      const a = att[v];
      L.push(fit([S(sel ? "▌" : " ", "hi"), S(viewKey(v), sel ? "hi" : "dim", sel ? BOLD : null), S(a ? "●" : " ", a ?? "dim")], sw, sel ? COLOR.sel : SBG));
      L.push(fit([], sw, SBG));
    }
    while (L.length < h) L.push(fit([], sw, SBG));
    return L.slice(0, h);
  }
  const sm = summaries(data);
  L.push([S(" LENSES", "dim", BOLD)]);
  L.push([S(" local only · " + (data.scannedAt || data.sessions ? fmt(data.sessions) + " sessions" : "not scanned yet"), "dim")]);
  L.push([]);
  for (const v of VIEW_ORDER) {
    const sel = v === ui.view;
    const bg = sel ? COLOR.sel : SBG;
    const a = att[v];
    L.push(fit([S(sel ? "▌" : " ", "hi"), S(" " + viewKey(v) + "  ", "dim"), S(VIEW_NAMES[v], sel ? "hi" : "fg", BOLD)], sw - 3, bg).concat([S(a ? " ● " : "   ", a ?? "dim", { b: bg })]));
    L.push(fit([S("     "), ...sm[v]], sw, bg));
    L.push([]);
  }
  const ns = data.skills.items.filter((x) => x.on).length;
  const nw = data.workflows?.items.filter((x) => x.on).length;
  L.push([S(" INSTALLED", "dim", BOLD)]);
  // Workflows that install as their skill are already counted under skills.
  if (data.workflows && !data.workflows.runAs) L.push([S(" " + ns + " skills", "fg")]);
  else L.push([S(" " + ns + " skills", "fg"), S("  ·  ", "dim"), ...(nw === undefined ? [S("—", "dim"), S(" workflows", "fg")] : [S(nw + " workflows", "fg")])]);
  const r = data.router;
  L.push([S(" autopilot ", "dim"), r ? S(r.autopilot ? "on" : "off", r.autopilot ? "ok" : "dim", BOLD) : S("—", "dim")]);
  while (L.length < h - 2) L.push([]);
  L.length = Math.max(0, h - 2);
  L.push([S(" nothing leaves this machine", "dim")]);
  L.push([S(" " + data.dataDir, "faint")]);
  return L.slice(0, Math.max(0, h)).map((l) => fit(l, sw, SBG));
}

/** Top bar (prototype `topbar`), with the brand "Reflex AI". */
function topbar(W: number, data: TuiData, ui: UiState): Line {
  const l: Line = [S(" ◆ Reflex AI ", "hi", { bold: true, b: COLOR.key }), S("  " + VIEW_NAMES[ui.view].toLowerCase(), "hi", BOLD), S("   [" + viewKey(ui.view) + "]", "dim")];
  const scan = ui.scanning ? S("rescanning…   ", "warn") : S(data.scannedAt ? "scanned " + data.scannedAt + "   " : "not scanned yet   ", "dim");
  const r: Line = [scan, S(ui.clock + " ", "dim")];
  return fit([...l, S(" ".repeat(Math.max(1, W - llen(l) - llen(r)))), ...r], W, COLOR.bar);
}

/** Status bar key chips for the view (prototype `statusbar`). */
function statusbar(W: number, view: ViewId): Line {
  const ks: Array<[string, string]> =
    view === "search"
      ? [["0-6", "jump"], ["/", "type"], ["↑↓", "results"], ["tab", "tool"], ["enter", "resume"], ["esc", "done"]]
      : [["0-6", "jump"], ["/", "search"]];
  if (view === "skills" || view === "workflows" || view === "router") ks.push(["↑↓", "select"], ["space", view === "router" ? "autopilot" : "toggle"]);
  if (view !== "search") ks.push(["r", "rescan"], ["b", "sidebar"], ["q", "quit"]);
  const l: Line = [];
  for (const [k, d] of ks) l.push(S(" " + k + " ", "hi", { bold: true, b: COLOR.key }), S(" " + d + "  "));
  const r: Line = [S("● local · offline ", "dim")];
  return fit([...l, S(" ".repeat(Math.max(1, W - llen(l) - llen(r)))), ...r], W, COLOR.bar);
}

type Cell = { ch: string; c: ColorToken | Hex; b?: Hex | null; bold?: boolean };
const cells = (l: Line): Cell[] => {
  const o: Cell[] = [];
  for (const s of l) for (const ch of s.t) o.push({ ch, c: s.c, b: s.b, bold: s.bold });
  return o;
};
const hex = (c: ColorToken | Hex): Hex => (c in COLOR ? COLOR[c as ColorToken] : (c as Hex));
/** Cells to runs with resolved colors; adjacent cells with the same style merge. */
const merge = (cs: Cell[]): Row => {
  const o: Run[] = [];
  for (const x of cs) {
    const fg = hex(x.c);
    const bg = x.b && x.b !== COLOR.bg ? x.b : null;
    const bold = !!x.bold;
    const p = o[o.length - 1];
    if (p && p.fg === fg && p.bg === bg && p.bold === bold) p.t += x.ch;
    else o.push({ t: x.ch, fg, bg, bold });
  }
  return o;
};

/** `h` cut to the rectangle, or null when nothing is left. */
function clip(h: Hit, x0: number, x1: number, y0: number, y1: number): Hit | null {
  const c: Hit = { ...h, x0: Math.max(h.x0, x0), x1: Math.min(h.x1, x1), y0: Math.max(h.y0, y0), y1: Math.min(h.y1, y1) };
  return c.x0 < c.x1 && c.y0 < c.y1 ? c : null;
}

/**
 * The whole screen, `H` rows of `W` cells (prototype `compose`): top bar on row 0, the sidebar and the
 * view below it (view line 0 on row 2, after one padding row), the status bar on row H-1 and the
 * toast over rows H-5..H-3 at the right edge. Hits: sidebar items switch views; the view's own hits
 * are moved to screen coordinates and clipped to the content area.
 */
export function compose(W: number, H: number, data: TuiData, ui: UiState): Frame {
  const sw = sidebarWidth(W, ui);
  const CW = Math.max(0, W - sw - 2);
  const CH = Math.max(0, H - 2);
  const side = sidebar(sw, CH, data, ui);
  const out = RENDER[ui.view](CW, Math.max(0, CH - 1), data, ui);
  const body: Line[] = [[] as Line].concat(out.lines).slice(0, CH);
  while (body.length < CH) body.push([]);
  const lines: Line[] = [topbar(W, data, ui), ...body.map((l, i) => [...(side[i] ?? []), S(" "), ...fit(l, CW), S(" ")]), statusbar(W, ui.view)];
  const grid = lines.slice(0, Math.max(1, H)).map((l) => cells(fit(l, W)));

  const t = ui.toast;
  const tw = Math.min(44, W - sw - 4);
  if (t && H >= 6 && tw >= 2) {
    const x0 = W - tw - 2;
    ["", toCells(t.msg), ""].forEach((m, i) => {
      const row = grid[H - 5 + i]!;
      cells([S("▌", t.tone || "ok", { b: COLOR.bar }), ...fit([S(" " + m, "hi")], tw - 1, COLOR.bar)]).forEach((c, j) => (row[x0 + j] = c));
    });
  }

  const hits: Hit[] = [];
  const full = sw === SBW;
  VIEW_ORDER.forEach((view, i) => {
    const y0 = full ? 4 + 3 * i : 3 + 2 * i;
    // Full: title and summary rows, above the pinned footer. Rail: the item row.
    const hit = clip({ x0: 0, x1: sw, y0, y1: y0 + (full ? 2 : 1), action: { type: "view", view } }, 0, sw, 1, full ? H - 3 : H - 1);
    if (hit) hits.push(hit);
  });
  for (const h of out.hits) {
    const moved = clip({ ...h, x0: h.x0 + sw + 1, x1: h.x1 + sw + 1, y0: h.y0 + 2, y1: h.y1 + 2 }, sw + 1, sw + 1 + CW, 2, H - 1);
    if (moved) hits.push(moved);
  }
  return { rows: grid.map(merge), hits };
}
