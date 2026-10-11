import type { ToolFilter, ToolId, Tone, ViewId } from "./types";

/**
 * The TUI's data contract: everything the seven views render, as plain values.
 *
 * A `DataSource` builds it: the live source from Reflex's store, the design fixture from the
 * prototype's mock data. Optional fields are measurements Reflex may not have yet. A view renders
 * "not measured yet" for a missing block and "—" for a missing value inside a measured block; it
 * never shows a number nobody measured. Money is US dollars and tokens are raw counts. Labels
 * (dates, ranges) are pre-formatted by the source in the design's style. Every string must already
 * be display-safe: one terminal cell per character, no control characters (see `toCells`).
 */
export type TuiData = {
  /** Local time of the latest scan, "08:02" (top bar "scanned 08:02"). Absent before the first scan. */
  scannedAt?: string;
  /** Sessions Reflex has read (sidebar "local only · 1,284 sessions"). */
  sessions: number;
  /** Display path of Reflex's data folder (sidebar footer, Morning DATA line): "~/.reflex". */
  dataDir: string;
  /** Display paths of the history folders scans read (Morning DATA line). */
  reads: string[];
  /** Display paths where installed skills and workflows live (Morning ACTIVE line). */
  activeDirs: string[];
  /** One usage-limit card per CLI tool (Dashboard). */
  limits?: ToolLimits[];
  /** Display path of the plans file, shown under the limit cards. */
  plansFile?: string;
  money?: Money;
  /** Daily series, oldest first, ending yesterday. Tokens shows the last 28, Morning 8, Dashboard 14. */
  days?: Day[];
  yesterday?: Yesterday;
  /** The Tokens view's window ("LAST 30 DAYS"). */
  window?: TokenWindow;
  /** Per-tool rows (Tokens CLI TOOLS). Sessions are always known; money may not be. */
  tools: ToolRow[];
  topPrompts?: PromptRow[];
  topSessions?: SessionRow[];
  skills: ItemList;
  /** Absent until Reflex mines workflows. */
  workflows?: ItemList;
  /** Absent until Reflex builds a router. */
  router?: Router;
  /** Dashboard NEEDS A LOOK, most important first. */
  attention: Attention[];
  /** Absent until Reflex indexes turns. */
  search?: SearchIndex;
};

export type LimitBar = {
  /** At most 8 cells: "5-hour", "weekly", "wk opus", "monthly", "fast req". */
  label: string;
  /** Name in the sidebar summary: "opus" in "opus 83% · today $12.40". */
  short: string;
  /** Percent of the limit used, 0..100. */
  pct: number;
  /** When it resets: "in 3h26m", "Thu 9:00", "1 Nov". */
  resets: string;
};

export type ToolLimits = {
  tool: ToolId;
  /** Plan from plans.toml: "Max 5x", "Pro". */
  plan: string;
  bars: LimitBar[];
  /** Pace projection on the current window, e.g. "hits opus limit Wed 16:00" (warn). */
  pace?: { text: string; tone: Tone };
};

export type Money = {
  today: { usd: number; sessions: number };
  /** All history; `since` is the first day, "14 Mar". */
  allTime: { usd: number; since: string };
  /** Calendar month to date (Morning "this month $246.40"). */
  month: { usd: number };
  /** Daily budget in USD; days over it are yellow on the Tokens chart. */
  dailyBudget: number;
};

export type Day = {
  /** "13 Sep". Morning's chart shows the first two characters. */
  label: string;
  usd?: number;
  /** All tokens that day (Tokens tok/d sparkline). */
  tokens?: number;
  /** Cost per tool that day (Dashboard LAST 14 DAYS BY TOOL). */
  byTool?: Partial<Record<ToolId, number>>;
};

export type Yesterday = {
  /** "sat 10 oct". */
  label: string;
  sessions: number;
  /** Fresh input + cache writes + cache reads. */
  contextTokens: number;
  outputTokens: number;
  byTool?: Bar[];
  byModel?: Bar[];
  byProject?: Bar[];
};

export type TokenSplit = { input: number; cacheWrite: number; cacheRead: number; output: number };

export type TokenWindow = {
  /** Window length ("LAST 30 DAYS", "caching saved … last 30 days"). */
  days: number;
  /** "11 sep – 10 oct". */
  range: string;
  sessions: number;
  /** Raw token counts. `input` excludes cached input. */
  tokens: TokenSplit;
  /** What the window cost by token kind; `uncached` is the same usage priced without caching. */
  usd?: TokenSplit & { total: number; uncached: number };
  byModel?: Bar[];
  byProject?: Bar[];
};

export type Bar = { name: string; usd: number };

export type ToolRow = { tool: ToolId; sessions: number; usd?: number; allTimeUsd?: number };

export type PromptRow = { usd: number; project: string; text: string };

export type SessionRow = {
  usd: number;
  /** "08 Oct". */
  date: string;
  tool: ToolId;
  project: string;
  /** Task class: "debug", "refactor", "test-write". */
  kind: string;
  turns: number;
  toolCalls: number;
  contextTokens: number;
  /** Opening prompt. */
  prompt: string;
};

export type ItemState = "new" | "updated" | "retired" | "";

export type Item = {
  /** Slug. Workflows show as "/wf-<name>" in Morning and install as "wf-<name>". */
  name: string;
  /** Installed. */
  on: boolean;
  /** Independent sessions behind it ("sup"). */
  support: number;
  /** Last generated, "10 Oct". */
  updated: string;
  state: ItemState;
  /** Steps or phases ("st"). */
  steps: number;
  /** Display path of the installed file (preview box title). */
  path: string;
  /** The generated markdown, one entry per line, front matter included. */
  markdown: string[];
};

export type ItemList = {
  items: Item[];
  /** Display paths `space` writes, with "<name>" standing for the item name. */
  targets: string[];
  /**
   * Slash-command prefix when workflows install as their own commands ("/wf-", run as
   * "/wf-<name> <task>"). Absent when a workflow installs as its skill: then the Workflows view is
   * the evidence behind each skill and its items are not counted again as installed workflows.
   */
  runAs?: string;
};

export type ModelEvidence = {
  model: string;
  sessions: number;
  /** Average cost per session. */
  usd: number;
  /** (corrections + tool errors + repeated commands) / assistant turns. */
  friction: number;
};

export type RouterTask = {
  /** Task class key: "debug". */
  key: string;
  /** Plain name: "Debugging". */
  name: string;
  evidence: ModelEvidence[];
  /** Recommended model. */
  rec: string;
  /** Most used model, and its session count. */
  most: string;
  mostSessions: number;
  /** Saving per session when `rec` replaces `most`; 0 when they are the same. */
  save: number;
  /** Sessions across all models. */
  sessions: number;
  /** Lowest friction among models with enough sessions. */
  best: number;
  /** Yesterday's pick, when it differs from today's. */
  previous?: string;
};

export type Router = {
  autopilot: boolean;
  /** Sessions the router was built from. */
  sessions: number;
  /** "08:02". */
  rebuiltAt: string;
  /** Display path of the policy file. */
  policyFile: string;
  /** Policy: models need this many sessions, and friction within `margin` of the best. */
  minSupport: number;
  margin: number;
  /** USD per month if every pick is followed. */
  monthlySaving: number;
  /** Sessions that would move to a cheaper model. */
  movedSessions: number;
  tasks: RouterTask[];
};

export type Attention = { tone: Tone; text: string; view: ViewId };

export type Turn = {
  /** "10 Oct". */
  date: string;
  tool: ToolId;
  project: string;
  session: string;
  turn: number;
  role: "you" | "ai";
  text: string;
};

export type SessionContext = {
  /** The session's indexed turns, in order. */
  turns: Turn[];
  usd?: number;
  turnCount?: number;
  /** Files the session touched, already joined for display. */
  files?: string;
};

export type SearchIndex = {
  /** Turns in the index ("41,208 turns indexed"). */
  indexed: number;
  /** Matching turns, newest date first, then highest turn. Called on render, so it must be fast. */
  query(q: string, tool: ToolFilter): Turn[];
  session(id: string): SessionContext;
};
