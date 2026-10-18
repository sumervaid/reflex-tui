import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { TokenUsage } from "@reflex/core";
import { addUsage, priceOf } from "@reflex/core";

/** Larger logs are read from their last bytes only: recent turns are what scans need. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9-]{1,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

type Turn = { event: string; at: number; model?: string; usage: TokenUsage };

const CLAUDE = /^(?:claude-)?(?:(\d+(?:[.-]\d+)?)-(opus|sonnet|haiku|fable|mythos)|(opus|sonnet|haiku|fable|mythos)-(\d+(?:[.-]\d+)?))(?:-.*)?$/;

/**
 * Cursor names Claude models its own way ("claude-4.5-sonnet-thinking", "sonnet-5.5") where the
 * price table uses Anthropic's ("claude-sonnet-4-5"). The Anthropic form is used when it has a
 * price; any other name is kept as recorded (Cursor's own models have no list price).
 */
export function cursorModelName(id: string): string {
  const m = id.toLowerCase().match(CLAUDE);
  if (!m) return id;
  const name = `claude-${m[2] ?? m[3]}-${(m[1] ?? m[4])!.replace(".", "-")}`;
  return priceOf(name) ? name : id;
}

/** The last `max` bytes of a file, from the start of a line. Empty when it can't be read. */
function tail(path: string, max: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/**
 * Token counts Reflex's Cursor hook recorded (`reflex cursor-usage on`): one line per `stop` or
 * `afterAgentResponse` event with conversation and generation ids, model and the four token
 * counts, never text. Cursor reports counts per turn (generation), cumulative across its model
 * calls, and its `input_tokens` include cache reads and writes; here `input` excludes them, as
 * for Claude Code and Codex. A turn's `stop` record wins over `afterAgentResponse` records, which
 * repeat the same numbers.
 */
export class CursorUsageLog {
  private turns?: Map<string, Map<string, Turn>>;

  constructor(readonly path: string) {}

  private load(): Map<string, Map<string, Turn>> {
    if (this.turns) return this.turns;
    const turns = new Map<string, Map<string, Turn>>();
    this.turns = turns;
    for (const line of tail(this.path, MAX_LOG_BYTES).split("\n")) {
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const conv = typeof r.conversation_id === "string" && ID.test(r.conversation_id) ? r.conversation_id : undefined;
      const gen = typeof r.generation_id === "string" && ID.test(r.generation_id) ? r.generation_id : undefined;
      if (!conv || !gen) continue;
      const cacheRead = count(r.cache_read_tokens);
      const cacheWrite = count(r.cache_write_tokens);
      const usage = { input: Math.max(0, count(r.input_tokens) - cacheRead - cacheWrite), output: count(r.output_tokens), cacheRead, cacheWrite };
      const turn: Turn = {
        event: r.event === "stop" ? "stop" : "afterAgentResponse",
        at: typeof r.at === "string" ? Date.parse(r.at) || 0 : 0,
        model: typeof r.model === "string" && MODEL.test(r.model) ? cursorModelName(r.model) : undefined,
        usage,
      };
      const byGen = turns.get(conv) ?? new Map<string, Turn>();
      turns.set(conv, byGen);
      const prev = byGen.get(gen);
      if (!prev || turn.event === "stop" || prev.event !== "stop") byGen.set(gen, turn);
    }
    return turns;
  }

  /** Usage for these conversations, in total and per model. */
  usageFor(ids: string[]): { usage: TokenUsage; byModel: Record<string, TokenUsage> } | undefined {
    let usage: TokenUsage | undefined;
    const byModel: Record<string, TokenUsage> = {};
    for (const id of ids)
      for (const t of this.load().get(id)?.values() ?? []) {
        usage = addUsage(usage, t.usage);
        if (t.model) byModel[t.model] = addUsage(byModel[t.model], t.usage);
      }
    return usage ? { usage, byModel } : undefined;
  }

  /** How many turns were recorded for these conversations, and when the latest was: part of a chat's identity for the scan cache. */
  signature(ids: string[]): { turns: number; latest: number } {
    let turns = 0;
    let latest = 0;
    for (const id of ids)
      for (const t of this.load().get(id)?.values() ?? []) {
        turns++;
        latest = Math.max(latest, t.at);
      }
    return { turns, latest };
  }
}
