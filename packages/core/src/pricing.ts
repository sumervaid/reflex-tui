import type { TokenUsage } from "./types";

/**
 * USD per million tokens. `cacheWrite` is the 5-minute write, `cacheWrite1h` the 1-hour write
 * (priced as `cacheWrite` when absent); `cacheRead` a cache hit.
 */
export type ModelPrice = { input: number; output: number; cacheWrite: number; cacheRead: number; cacheWrite1h?: number };

export type Cost = {
  usd: number;
  /** Cost by token kind. */
  split: TokenUsage;
  /** The same tokens priced as if nothing had been cached. */
  uncached: number;
};

/** When the built-in prices were last checked against the pricing pages. */
export const PRICES_CHECKED = "11 Oct 2026";

const p = (input: number, output: number, cacheWrite: number, cacheRead: number): ModelPrice => ({ input, output, cacheWrite, cacheRead });
/** Anthropic charges 1.25x input for a 5-minute cache write and 2x for a 1-hour one. */
const claude = (input: number, output: number, cacheRead: number): ModelPrice => ({ input, output, cacheWrite: input * 1.25, cacheRead, cacheWrite1h: input * 2 });

/**
 * API list prices (Anthropic and OpenAI pricing pages, checked on PRICES_CHECKED), so a session's
 * cost is what the same tokens would cost on the API, not what a subscription charges. First match
 * wins; patterns run on the lowercased model id with any `claude-` / date suffix left in place.
 * Haiku 5.5 uses its up-to-100K-prompt row. OpenAI models before GPT-5.6 charge no cache-write fee.
 */
const PRICES: Array<[RegExp, ModelPrice]> = [
  [/\b(fable|mythos)-5-1\b/, claude(10, 50, 0.25)],
  [/\b(fable|mythos)-5\b/, claude(10, 50, 1)],
  [/\bopus-5-5\b/, claude(4, 20, 0.2)],
  [/\bopus-(5|4-[5-9])\b/, claude(5, 25, 0.5)],
  [/\bopus-4\b|\bopus-4-[01]\b|\b3-opus\b/, claude(15, 75, 1.5)],
  [/\bsonnet-5-5\b/, claude(2, 10, 0.1)],
  [/\bsonnet-5\b/, claude(2, 10, 0.2)],
  [/\bsonnet-4\b|\bsonnet-4-[0-9]\b|\b3-[57]-sonnet\b/, claude(3, 15, 0.3)],
  [/\bhaiku-5-5\b/, claude(0.1, 0.5, 0.01)],
  [/\bhaiku-4-5\b/, claude(1, 5, 0.1)],
  [/\b3-5-haiku\b|\bhaiku-3-5\b/, claude(0.8, 4, 0.08)],
  [/^gpt-5\.6-sol\b/, p(4, 20, 5, 0.4)],
  [/^gpt-5\.6-terra\b/, p(2, 12, 2.5, 0.2)],
  [/^gpt-5\.6-luna\b/, p(0.2, 1.2, 0.25, 0.02)],
  [/^gpt-5\.5\b/, p(5, 30, 5, 0.5)],
  [/^gpt-5\.4\b/, p(2.5, 15, 2.5, 0.25)],
  [/^gpt-5\.3-codex\b/, p(1.75, 14, 1.75, 0.175)],
  [/^gpt-5(\.1)?(-codex)?$/, p(1.25, 10, 1.25, 0.125)],
];

/** Prices the user set (`~/.reflex/prices.json`): lowercased model id, or a prefix ending in `*`. */
let overrides: Array<[string, ModelPrice]> = [];

/** Use these prices ahead of the built-in ones. Keys are model ids, or prefixes ending in `*`. */
export function setPriceOverrides(prices: Record<string, ModelPrice>): void {
  overrides = Object.entries(prices).map(([k, v]) => [k.toLowerCase(), v]);
}

/** The price of a model, yours first, or undefined when Reflex does not know it (it is then left unpriced). */
export function priceOf(model: string): ModelPrice | undefined {
  const id = model.toLowerCase();
  const own = overrides.find(([k]) => (k.endsWith("*") ? id.startsWith(k.slice(0, -1)) : id === k));
  return own?.[1] ?? PRICES.find(([re]) => re.test(id))?.[1];
}

/** What `usage` costs at `price`. */
export function costAt(usage: TokenUsage, price: ModelPrice): Cost {
  const m = (n: number, perM: number): number => (n * perM) / 1e6;
  const hour = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite);
  const split = {
    input: m(usage.input, price.input),
    output: m(usage.output, price.output),
    cacheWrite: m(usage.cacheWrite - hour, price.cacheWrite) + m(hour, price.cacheWrite1h ?? price.cacheWrite),
    cacheRead: m(usage.cacheRead, price.cacheRead),
  };
  const usd = split.input + split.output + split.cacheWrite + split.cacheRead;
  const uncached = m(usage.input + usage.cacheWrite + usage.cacheRead, price.input) + split.output;
  return { usd, split, uncached };
}

/**
 * The API cost of usage recorded per model. Models without a known price are skipped and listed in
 * `unpriced`; `cost` is undefined when nothing could be priced.
 */
export function costOf(usageByModel: Record<string, TokenUsage> | undefined): { cost?: Cost; byModel: Record<string, number>; unpriced: string[] } {
  const byModel: Record<string, number> = {};
  const unpriced: string[] = [];
  let cost: Cost | undefined;
  for (const [model, usage] of Object.entries(usageByModel ?? {})) {
    const price = priceOf(model);
    if (!price) {
      unpriced.push(model);
      continue;
    }
    const c = costAt(usage, price);
    byModel[model] = c.usd;
    cost = cost ? addCost(cost, c) : c;
  }
  return { cost, byModel, unpriced };
}

/** Models that ran in these sessions but have no price, with how many sessions used each, most first. */
export function unknownModels(sessions: Array<Record<string, TokenUsage> | undefined>): Array<{ model: string; sessions: number }> {
  const counts = new Map<string, number>();
  for (const s of sessions) for (const model of Object.keys(s ?? {})) if (!priceOf(model)) counts.set(model, (counts.get(model) ?? 0) + 1);
  return [...counts].map(([model, n]) => ({ model, sessions: n })).sort((x, y) => y.sessions - x.sessions || x.model.localeCompare(y.model));
}

export function addCost(a: Cost, b: Cost): Cost {
  return {
    usd: a.usd + b.usd,
    uncached: a.uncached + b.uncached,
    split: {
      input: a.split.input + b.split.input,
      output: a.split.output + b.split.output,
      cacheWrite: a.split.cacheWrite + b.split.cacheWrite,
      cacheRead: a.split.cacheRead + b.split.cacheRead,
    },
  };
}
