import type { TuiData } from "./model";

/**
 * Design tokens from docs/design/tui-v5/HANDOFF.md. Every value is an exact xterm-256 entry
 * (index in the comment), so the TUI renders identically without truecolor.
 */
export const COLOR = {
  bg: "#1c1c1c", // 234 screen
  sidebar: "#262626", // 235 sidebar background
  bar: "#303030", // 236 top bar, status bar, toast
  sel: "#3a3a3a", // 237 selected row
  ul: "#3a3a3a", // 237
  key: "#4e4e4e", // 239 key chips
  line: "#444444", // 238 box borders
  faint: "#585858", // 240 tertiary text, empty bar cells
  dim: "#808080", // 244 labels, unchanged
  gb: "#8a8a8a", // 245 neutral bars
  fg: "#d0d0d0", // 252 body text
  hi: "#eeeeee", // 255 emphasis, numbers
  ok: "#87d787", // 114 enabled / new / good
  warn: "#d7af5f", // 179 updated / over budget / >= 70% of a limit
  bad: "#d75f5f", // 167 retired / >= 90% of a limit
  autopilot: "#005f00", // 22 AUTOPILOT chip background when on
  match: "#5f5f00", // 58 search highlight background
} as const;

export type ColorToken = keyof typeof COLOR;
export type Hex = `#${string}`;

/**
 * A run of text in one style, as the prototype's `S(t, c, o)` builds it. `c` is a color token or a
 * hex color, `b` an optional background hex. Every character is one terminal cell: strings that come
 * from transcripts or files must pass through `toCells` before they reach a segment.
 */
export type Seg = { t: string; c: ColorToken | Hex; b?: Hex | null; bold?: boolean };
export type Line = Seg[];

/** One styled run of a composed screen row, with resolved colors. `bg: null` means the screen background. */
export type Run = { t: string; fg: Hex; bg: Hex | null; bold: boolean };
/** One terminal row: runs whose text adds up to exactly the screen width. */
export type Row = Run[];

export type ViewId = "dashboard" | "morning" | "tokens" | "skills" | "workflows" | "router" | "search";

/** Sidebar and key order: key `0` is the dashboard, `1`..`6` the rest. */
export const VIEW_ORDER: readonly ViewId[] = ["dashboard", "morning", "tokens", "skills", "workflows", "router", "search"];

export const VIEW_NAMES: Record<ViewId, string> = {
  dashboard: "Dashboard",
  morning: "Morning",
  tokens: "Tokens",
  skills: "Skills",
  workflows: "Workflows",
  router: "Router",
  search: "Search",
};

export const viewKey = (v: ViewId): string => String(VIEW_ORDER.indexOf(v));

export type ToolId = "claude" | "codex" | "cursor";
export type ToolFilter = "all" | ToolId;
export const TOOL_FILTERS: readonly ToolFilter[] = ["all", "claude", "codex", "cursor"];

export type Tone = "ok" | "warn" | "bad" | "dim";
export type Toast = { msg: string; tone: Tone };

/** Everything about the screen that is not data: navigation, selection, typing, transient messages. */
export type UiState = {
  view: ViewId;
  /** Views opened in this run. A view shows its attention dot until it is in this list. */
  seen: ViewId[];
  /** The user's sidebar choice. The full sidebar needs 140+ columns; below that it is always the rail. */
  sidebar: "full" | "rail";
  sel: { skills: number; workflows: number; router: number; search: number };
  /** First visible line of the preview pane (Skills/Workflows markdown, Search context). */
  previewScroll: number;
  /** Search text as typed, shown on the query line. */
  query: string;
  /** The query the results reflect: `query` after the ~100 ms debounce. */
  searchQuery: string;
  typing: boolean;
  tool: ToolFilter;
  scanning: boolean;
  toast: Toast | null;
  /** Wall clock shown in the top bar, "HH:MM:SS". */
  clock: string;
};

/** What a click or wheel event at a cell means. Produced by `compose` alongside the rows it drew. */
export type HitAction =
  | { type: "view"; view: ViewId }
  | { type: "select"; list: "skills" | "workflows" | "router" | "search"; index: number }
  | { type: "scroll"; pane: "preview" };

/** A rectangle of cells (inclusive start, exclusive end) and what happens there. */
export type Hit = { x0: number; x1: number; y0: number; y1: number; action: HitAction };

export type Frame = { rows: Row[]; hits: Hit[] };

/**
 * What a view renders into the content area: `lines` (the shell fits each to the view width and cuts
 * at the view height) and hit regions with coordinates relative to the view's first line and column.
 */
export type ViewOut = { lines: Line[]; hits: Hit[] };

export type ActionResult = { ok: boolean; message: string; tone: Tone };

export type RescanResult = ActionResult & { sessions?: number; added?: number };

/** A command that resumes a session in its own CLI, run in `cwd` when the CLI looks sessions up per folder. */
export type ResumeCommand = { cmd: string; args: string[]; cwd?: string; /** Shown once the command returns, for apps that open a window and exit. */ done?: string };

/**
 * Where the TUI gets its data and how it acts on it. The live source reads Reflex's store; the
 * design fixture (packages/tui/fixture) reproduces the prototype for the preview and golden tests.
 */
export interface DataSource {
  /** Build the full view model. Called at start, after every rescan and after every toggle. */
  load(): Promise<TuiData>;
  /** Install (`on`) or remove a skill or workflow. Never overwrites a file it did not write. */
  toggleItem(kind: "skills" | "workflows", name: string, on: boolean): Promise<ActionResult>;
  /** Turn the router autopilot hook on or off. */
  setAutopilot(on: boolean): Promise<ActionResult>;
  /** Turn agent memory on or off (optional: sources without memory toast that it is unavailable). */
  setMemory?(on: boolean): Promise<ActionResult>;
  /** Re-read history. Runs off the UI thread; the UI keeps responding while it runs. */
  rescan(): Promise<RescanResult>;
  /** How to resume a search hit in its own CLI, or a message when that is not possible. */
  resume(sessionId: string, turn: number): ResumeCommand | ActionResult;
}
