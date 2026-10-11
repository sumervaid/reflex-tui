import type { TuiData, Turn } from "../model";
import { toCells } from "../render/text";
import { compose } from "../shell";
import type { InputEvent } from "../term/input";
import { TOOL_FILTERS, VIEW_ORDER, type Frame, type Hit, type Tone, type UiState, type ViewId } from "../types";

/** Full sidebar threshold, in columns. */
export const SIDEBAR_MIN_W = 140;
export const QUERY_DEBOUNCE_MS = 100;
export const TOAST_MS = 3000;
/** Lines per mouse wheel notch in a preview pane. */
export const WHEEL_STEP = 3;
const MAX_QUERY = 256;

/** Everything the reducer handles: terminal input, plus `query` when the search debounce fires. */
export type AppEvent = InputEvent | { type: "query" };

/** Work the reducer asks the app to do. */
export type Effect =
  | { type: "quit" }
  | { type: "rescan" }
  | { type: "toggle"; kind: "skills" | "workflows"; name: string; on: boolean }
  | { type: "autopilot"; on: boolean }
  | { type: "memory"; on: boolean }
  | { type: "resume"; sessionId: string; turn: number }
  /** (Re)start the search debounce: after QUERY_DEBOUNCE_MS the app sends `{ type: "query" }`. */
  | { type: "debounce" };

/** `w`/`h` are the terminal size; `frame` is the last frame drawn (mouse hit-testing). */
export type ReduceContext = { data: TuiData; w: number; h: number; frame?: Frame };
export type ReduceResult = { ui: UiState; effects: Effect[] };

type ListId = keyof UiState["sel"];
const LIST_OF: Partial<Record<ViewId, ListId>> = { skills: "skills", workflows: "workflows", router: "router", search: "search" };

export const UNAVAILABLE = {
  workflows: "workflows are not available yet",
  router: "the router is not available yet",
  search: "search is not available yet",
} as const;

/** The state the app opens with: the opening view counts as seen. */
export function initialUi(view: ViewId = "dashboard", clock = ""): UiState {
  return {
    view,
    seen: [view],
    sidebar: "full",
    sel: { skills: 0, workflows: 0, router: 0, search: 0 },
    previewScroll: 0,
    query: "",
    searchQuery: "",
    typing: false,
    tool: "all",
    scanning: false,
    toast: null,
    clock,
  };
}

export const withToast = (ui: UiState, msg: string, tone: Tone): UiState => ({ ...ui, toast: { msg, tone } });

/** The hits the Search view shows: the debounced query under the tool filter. */
export const searchHits = (data: TuiData, ui: UiState): Turn[] => (data.search ? data.search.query(ui.searchQuery.trim(), ui.tool) : []);

function listLength(data: TuiData, ui: UiState, list: ListId): number {
  if (list === "skills") return data.skills.items.length;
  if (list === "workflows") return data.workflows?.items.length ?? 0;
  if (list === "router") return data.router?.tasks.length ?? 0;
  return searchHits(data, ui).length;
}

const clamp = (v: number, n: number): number => Math.max(0, Math.min(n - 1, v));

/**
 * Keep selections inside their lists after the data changed. With `prev`, a skill, workflow or router
 * task stays selected by name when the list was reordered. The preview resets when the current view's
 * selection moves.
 */
export function clampUi(ui: UiState, data: TuiData, prev?: TuiData): UiState {
  const keep = (list: "skills" | "workflows"): number => {
    const before = prev?.[list]?.items[ui.sel[list]]?.name;
    const at = before === undefined ? -1 : (data[list]?.items.findIndex((x) => x.name === before) ?? -1);
    return clamp(at >= 0 ? at : ui.sel[list], listLength(data, ui, list));
  };
  const rkey = prev?.router?.tasks[ui.sel.router]?.key;
  const rat = rkey === undefined ? -1 : (data.router?.tasks.findIndex((t) => t.key === rkey) ?? -1);
  const sel = {
    skills: keep("skills"),
    workflows: keep("workflows"),
    router: clamp(rat >= 0 ? rat : ui.sel.router, listLength(data, ui, "router")),
    search: clamp(ui.sel.search, listLength(data, ui, "search")),
  };
  const same = (Object.keys(sel) as ListId[]).every((k) => sel[k] === ui.sel[k]);
  if (same) return ui;
  const cur = LIST_OF[ui.view];
  return { ...ui, sel, previewScroll: cur && sel[cur] !== ui.sel[cur] ? 0 : ui.previewScroll };
}

function go(ui: UiState, view: ViewId): UiState {
  const seen = ui.seen.includes(view) ? ui.seen : [...ui.seen, view];
  if (view === ui.view) return seen === ui.seen ? ui : { ...ui, seen };
  return { ...ui, view, seen, previewScroll: 0, typing: false };
}

function select(ui: UiState, list: ListId, index: number): UiState {
  if (ui.sel[list] === index) return ui;
  return { ...ui, sel: { ...ui.sel, [list]: index }, previewScroll: 0 };
}

function move(ui: UiState, data: TuiData, d: number): UiState {
  const list = LIST_OF[ui.view];
  if (!list) return ui;
  return select(ui, list, clamp(ui.sel[list] + d, listLength(data, ui, list)));
}

/** Space / Enter: install or remove (Skills, Workflows), autopilot (Router), resume (Search). */
function activate(ui: UiState, data: TuiData): ReduceResult {
  const none = { ui, effects: [] };
  if (ui.view === "skills" || ui.view === "workflows") {
    const list = data[ui.view];
    if (!list) return { ui: withToast(ui, UNAVAILABLE.workflows, "dim"), effects: [] };
    const x = list.items[clamp(ui.sel[ui.view], list.items.length)];
    return x ? { ui, effects: [{ type: "toggle", kind: ui.view, name: x.name, on: !x.on }] } : none;
  }
  if (ui.view === "router") {
    if (!data.router) return { ui: withToast(ui, UNAVAILABLE.router, "dim"), effects: [] };
    return { ui, effects: [{ type: "autopilot", on: !data.router.autopilot }] };
  }
  if (ui.view === "search") {
    if (!data.search) return { ui: withToast(ui, UNAVAILABLE.search, "dim"), effects: [] };
    const hs = searchHits(data, ui);
    const t = hs[Math.min(ui.sel.search, hs.length - 1)];
    return t ? { ui, effects: [{ type: "resume", sessionId: t.session, turn: t.turn }] } : none;
  }
  return none;
}

/** Append to (or cut) the query: the selection resets and the debounce restarts. */
function editQuery(ui: UiState, query: string): ReduceResult {
  if (query === ui.query) return { ui, effects: [] };
  return { ui: { ...ui, query, sel: { ...ui.sel, search: 0 }, previewScroll: 0 }, effects: [{ type: "debounce" }] };
}

/** Pasted text as one query line: line breaks become spaces, then `toCells`. */
const pasted = (s: string): string => toCells(s.replace(/\r\n|\r|\n/g, " "));

function typingKey(ui: UiState, data: TuiData, name: string, ch: string | undefined): ReduceResult {
  if (name === "escape" || name === "enter") return { ui: { ...ui, typing: false }, effects: [] };
  if (name === "backspace") return editQuery(ui, ui.query.slice(0, -1));
  if (name === "up" || name === "down") return { ui: move(ui, data, name === "down" ? 1 : -1), effects: [] };
  if (name === "tab" || ch === undefined) return { ui, effects: [] };
  const c = toCells(ch);
  return c.length === 1 ? editQuery(ui, (ui.query + c).slice(0, MAX_QUERY)) : { ui, effects: [] };
}

function key(ui: UiState, ev: { name: string; ch?: string; ctrl?: boolean; alt?: boolean }, ctx: ReduceContext): ReduceResult {
  const { data } = ctx;
  const { name } = ev;
  const k = ev.ch ?? name;
  const same = { ui, effects: [] as Effect[] };
  if (name === "ctrl-c") return { ui, effects: [{ type: "quit" }] };
  // Like the prototype, other Ctrl and Alt combinations do nothing.
  if (ev.alt || ev.ctrl || name.startsWith("ctrl-")) return same;
  if (ui.view === "search" && ui.typing) return typingKey(ui, data, name, ev.ch);
  if (k === "/") {
    const s = go(ui, "search");
    return { ui: data.search ? { ...s, typing: true } : withToast(s, UNAVAILABLE.search, "dim"), effects: [] };
  }
  if (name === "tab") {
    if (ui.view !== "search") return same;
    if (!data.search) return { ui: withToast(ui, UNAVAILABLE.search, "dim"), effects: [] };
    const tool = TOOL_FILTERS[(TOOL_FILTERS.indexOf(ui.tool) + 1) % TOOL_FILTERS.length]!;
    return { ui: { ...ui, tool, sel: { ...ui.sel, search: 0 }, previewScroll: 0 }, effects: [] };
  }
  if (k.length === 1 && k >= "0" && k <= "6") return { ui: go(ui, VIEW_ORDER[Number(k)]!), effects: [] };
  if (k === "b") {
    if (ctx.w < SIDEBAR_MIN_W) return { ui: withToast(ui, "sidebar needs 140+ columns", "dim"), effects: [] };
    return { ui: { ...ui, sidebar: ui.sidebar === "full" ? "rail" : "full" }, effects: [] };
  }
  if (name === "down" || k === "j") return { ui: move(ui, data, 1), effects: [] };
  if (name === "up" || k === "k") return { ui: move(ui, data, -1), effects: [] };
  if (name === "space" || name === "enter" || k === " ") return activate(ui, data);
  if (k === "r") return ui.scanning ? same : { ui: { ...ui, scanning: true }, effects: [{ type: "rescan" }] };
  if (k === "m") return data.memory ? { ui, effects: [{ type: "memory", on: !data.memory.enabled }] } : { ui: withToast(ui, "memory is not available yet", "dim"), effects: [] };
  if (k === "q") return { ui, effects: [{ type: "quit" }] };
  return same;
}

/** The topmost hit region containing the cell (x, y). Later hits are drawn over earlier ones. */
export function hitAt(frame: Frame | undefined, x: number, y: number): Hit | undefined {
  const hits = frame?.hits ?? [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]!;
    if (x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1) return h;
  }
  return undefined;
}

/**
 * Scroll the preview pane. The pane clamps its own offset, so scrolling down only goes on while it
 * changes what the screen shows (at most WHEEL_STEP - 1 lines past the end).
 */
function wheel(ui: UiState, down: boolean, ctx: ReduceContext): UiState {
  if (!down) return ui.previewScroll ? { ...ui, previewScroll: Math.max(0, ui.previewScroll - WHEEL_STEP) } : ui;
  const next = { ...ui, previewScroll: ui.previewScroll + WHEEL_STEP };
  const rows = (u: UiState): string => JSON.stringify(compose(ctx.w, ctx.h, ctx.data, u).rows);
  return rows(next) === rows(ui) ? ui : next;
}

function mouse(ui: UiState, ev: Extract<InputEvent, { type: "mouse" }>, ctx: ReduceContext): ReduceResult {
  const hit = hitAt(ctx.frame, ev.x, ev.y);
  if (!hit) return { ui, effects: [] };
  const a = hit.action;
  if (ev.action === "wheelup" || ev.action === "wheeldown") {
    return { ui: a.type === "scroll" ? wheel(ui, ev.action === "wheeldown", ctx) : ui, effects: [] };
  }
  if (ev.action !== "press" || ev.button !== 0) return { ui, effects: [] };
  if (a.type === "view") return { ui: go(ui, a.view), effects: [] };
  if (a.type === "select") {
    const s = select(ui, a.list, a.index);
    return { ui: a.list === "search" && s.typing ? { ...s, typing: false } : s, effects: [] };
  }
  return { ui, effects: [] };
}

/**
 * The app's state machine: the prototype's `onKey` and `termClick` plus the handoff key table.
 * Pure: work that touches the data source or the terminal comes back as `effects`.
 */
export function reduce(ui: UiState, ev: AppEvent, ctx: ReduceContext): ReduceResult {
  if (ev.type === "query") return { ui: clampUi({ ...ui, searchQuery: ui.query }, ctx.data), effects: [] };
  if (ev.type === "paste") {
    if (ui.view !== "search" || !ui.typing) return { ui, effects: [] };
    return editQuery(ui, (ui.query + pasted(ev.text)).slice(0, MAX_QUERY));
  }
  if (ev.type === "mouse") return mouse(ui, ev, ctx);
  if (ev.type === "key") return key(ui, ev, ctx);
  return { ui, effects: [] };
}
