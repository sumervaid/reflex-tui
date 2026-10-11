import { ClaudeCodeAdapter, CodexAdapter, CursorAdapter } from "@reflex/adapters";
import { SOURCE_IDS, type SourceId, type TokenUsage, type WorkflowTrace, totalTokens } from "@reflex/core";
import { displayPath } from "@reflex/safety";
import { detectTargets } from "@reflex/skills";
import { type ScanRecord, Store, reflexHome } from "@reflex/storage";
import type { Attention, Day, Item, TuiData } from "../model";
import { toCells } from "../render/text";
import type { ActionResult, DataSource, RescanResult } from "../types";
import { type CostFields, costFields, needsRescan, priceTraces } from "./costs";
import { clockLabel, dayLabel, dayStart, rangeLabel, weekdayLabel } from "./labels";
import { buildRouter } from "./router";
import { type LiveSearch, buildSearch, resumeCommand } from "./search";
import { TOOL_OF, errorText, skillItems, turnOff, turnOn } from "./skills";
import { workflowItems } from "./workflows";

export type LiveSourceOptions = {
  /** Re-read history the way the latest scan did. The CLI runs `reflex scan` in a child process. */
  rescan?: () => Promise<RescanResult>;
  /** The current time, for "yesterday" and in-memory previews. */
  now?: () => Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const NOT_SCANNED = "run `reflex scan` first to choose what Reflex may read";

/** The history folder each source reads by default (the adapters' own resolution, env overrides included). */
const HISTORY_ROOT: Record<SourceId, () => string> = {
  "claude-code": () => new ClaudeCodeAdapter().root,
  codex: () => new CodexAdapter().root,
  cursor: () => new CursorAdapter().root,
};

const unavailable = (message: string): ActionResult => ({ ok: false, message, tone: "dim" });

/**
 * The TUI's data from Reflex's own store: the latest scan's sessions, token usage and its cost at
 * API list prices, generated skills and pending suggestions, the workflows behind them, router
 * suggestions and a search over every scanned session. Usage limits are not recorded, so the views
 * show them as not measured.
 */
export function createLiveSource(opts: LiveSourceOptions = {}): DataSource {
  const now = opts.now ?? (() => new Date());
  let search: LiveSearch | undefined;
  return {
    async load() {
      const live = await loadLive(now());
      search = live.search;
      return live.data;
    },
    async toggleItem(kind, name, on) {
      try {
        const skill = kind === "workflows" ? skillFor(name) : name;
        return on ? await turnOn(skill) : await turnOff(skill);
      } catch (e) {
        return { ok: false, message: errorText(e), tone: "bad" };
      }
    },
    setAutopilot: async () => unavailable("autopilot is not available yet: the router only suggests models"),
    async rescan() {
      if (!opts.rescan || !hasScan()) return unavailable(NOT_SCANNED);
      try {
        return await opts.rescan();
      } catch (e) {
        return { ok: false, message: errorText(e), tone: "bad" };
      }
    },
    resume: (sessionId) => resumeCommand(search?.sessions.get(sessionId)),
  };
}

/** The skill a workflow installs as: the one generated from it (possibly renamed), else its own slug. */
function skillFor(slug: string): string {
  const store = new Store();
  try {
    return store.skills().find((k) => k.suggestionSlug === slug)?.name ?? slug;
  } finally {
    store.close();
  }
}

function hasScan(): boolean {
  const store = new Store();
  try {
    return store.latestScan() !== undefined;
  } finally {
    store.close();
  }
}

async function loadLive(now: Date): Promise<{ data: TuiData; search?: LiveSearch }> {
  const targets = await detectTargets();
  const store = new Store();
  try {
    const scan = store.latestScan();
    const skills = await skillItems(store, scan, targets, now);
    const traces = uniqueSessions(store.traces());
    const read = scan ? SOURCE_IDS.filter((s) => scan.sources[s] !== undefined) : [];
    const data: TuiData = {
      sessions: scan?.sessions ?? 0,
      dataDir: toCells(displayPath(reflexHome())),
      // A custom-folder scan did not record its folders, so there is nothing true to show.
      reads: scan?.mode === "local" ? read.map((s) => toCells(displayPath(HISTORY_ROOT[s]()))) : [],
      activeDirs: targets.filter((t) => t.detected).map((t) => toCells(displayPath(t.skillsDir))),
      tools: read.map((s) => ({ tool: TOOL_OF[s], sessions: scan!.sources[s]! })),
      skills,
      attention: attention(skills.items),
    };
    if (!scan) return { data };
    data.scannedAt = clockLabel(new Date(scan.startedAt));
    Object.assign(data, usage(scan, traces, now));
    const priced = priceTraces(traces);
    addCosts(data, costFields(priced, windowDays(scan, now), now));
    data.router = buildRouter(priced, data.scannedAt, scan.days);
    const stale = needsRescan(priced);
    if (stale) data.attention.push({ tone: "warn", text: `press r to rescan: ${stale} ${stale === 1 ? "session was" : "sessions were"} stored before Reflex recorded models, so ${stale === 1 ? "it has" : "they have"} no cost yet`, view: "dashboard" });
    const skillOf = new Map(store.skills().map((k) => [k.suggestionSlug, k.name]));
    data.workflows = workflowItems(store.suggestions(), skillOf, skills, dayLabel(new Date(scan.startedAt)));
    const search = buildSearch(priced);
    data.search = search.index;
    return { data, search };
  } finally {
    store.close();
  }
}

/** Dollar figures at API list prices, for the sessions whose models Reflex can price. */
function addCosts(data: TuiData, c: CostFields | undefined): void {
  if (!c) return;
  data.money = c.money;
  data.days = data.days?.map((d, i) => ({ ...d, ...c.dayCost[i] }));
  if (data.window) Object.assign(data.window, { usd: c.windowUsd, byModel: c.windowByModel, byProject: c.windowByProject });
  if (data.yesterday) Object.assign(data.yesterday, c.yesterday);
  data.tools = data.tools.map((r) => (c.toolUsd[r.tool] === undefined ? r : { ...r, usd: c.toolUsd[r.tool], allTimeUsd: c.toolUsd[r.tool] }));
  data.topSessions = c.topSessions;
  data.topPrompts = c.topPrompts;
}

/** The store keeps copies of a session found in two places; count each session once. */
const uniqueSessions = (traces: WorkflowTrace[]): WorkflowTrace[] => [...new Map(traces.map((t) => [t.sessionId, t])).values()];

type Totals = { sessions: number; usage: TokenUsage; measured: boolean };

/** Token sums. `measured` is false when there were sessions but none recorded usage (Cursor). */
function totals(traces: WorkflowTrace[]): Totals {
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let recorded = 0;
  for (const t of traces) {
    if (!t.usage) continue;
    recorded++;
    usage.input += t.usage.input;
    usage.output += t.usage.output;
    usage.cacheRead += t.usage.cacheRead;
    usage.cacheWrite += t.usage.cacheWrite;
  }
  return { sessions: traces.length, usage, measured: traces.length === 0 || recorded > 0 };
}

const startedIn = (traces: WorkflowTrace[], from: Date, to: Date): WorkflowTrace[] =>
  traces.filter((t) => {
    const at = t.startedAt ? Date.parse(t.startedAt) : NaN;
    return at >= from.getTime() && at < to.getTime();
  });

/**
 * The scan window is the `days` x 24 hours before the scan. `days` has one entry per local day the
 * window touches (sessions by start time); `yesterday` is set only when the window covers all of it.
 */
/** Local days of the scan window, ending yesterday: the views read the last entry as yesterday. */
function windowDays(scan: ScanRecord, now: Date): Date[] {
  const end = Math.min(new Date(scan.startedAt).getTime(), dayStart(now).getTime() - 1);
  const out: Date[] = [];
  for (let d = dayStart(new Date(new Date(scan.startedAt).getTime() - scan.days * DAY_MS)); d.getTime() <= end; d = dayStart(d, 1)) out.push(d);
  return out;
}

function usage(scan: ScanRecord, traces: WorkflowTrace[], now: Date): Pick<TuiData, "days" | "window" | "yesterday"> {
  const end = new Date(scan.startedAt);
  const start = new Date(end.getTime() - scan.days * DAY_MS);
  const days: Day[] = windowDays(scan, now).map((d) => {
    const t = totals(startedIn(traces, d, dayStart(d, 1)));
    return { label: dayLabel(d), tokens: t.measured ? totalTokens(t.usage) : undefined };
  });
  const out: Pick<TuiData, "days" | "window" | "yesterday"> = { days };
  const all = totals(traces);
  if (all.measured) out.window = { days: scan.days, range: rangeLabel(start, end), sessions: scan.sessions, tokens: all.usage };
  const y0 = dayStart(now, -1);
  const t0 = dayStart(now);
  if (start.getTime() <= y0.getTime() && end.getTime() >= t0.getTime()) {
    const y = totals(startedIn(traces, y0, t0));
    if (y.measured) {
      const u = y.usage;
      out.yesterday = { label: weekdayLabel(y0), sessions: y.sessions, contextTokens: u.input + u.cacheWrite + u.cacheRead, outputTokens: u.output };
    }
  }
  return out;
}

function attention(items: Item[]): Attention[] {
  const out: Attention[] = [];
  const fresh = items.filter((i) => i.state === "new").length;
  const stale = items.filter((i) => i.state === "retired" && i.on).length;
  if (fresh) out.push({ tone: "ok", text: `${fresh} new ${fresh === 1 ? "skill" : "skills"} to review`, view: "skills" });
  if (stale) out.push({ tone: "bad", text: `${stale} retired ${stale === 1 ? "skill is" : "skills are"} still installed`, view: "skills" });
  return out;
}
