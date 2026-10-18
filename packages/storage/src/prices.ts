import { readFileSync } from "node:fs";
import { type ModelPrice, setPriceOverrides } from "@reflex/core";
import { paths } from "./paths";

const KINDS = ["input", "output", "cacheWrite", "cacheRead", "cacheWrite1h"] as const;
const isPrice = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Prices from `~/.reflex/prices.json`, a map from model id (or a prefix ending in `*`) to USD per
 * million tokens: `{ "my-model": { "input": 3, "output": 15, "cacheWrite": 3.75, "cacheRead": 0.3 } }`,
 * with an optional `cacheWrite1h`. Problems come back as messages; entries with one are skipped.
 */
export function readPriceFile(file = paths.prices()): { prices: Record<string, ModelPrice>; problems: string[] } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { prices: {}, problems: (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : [`Can't read ${file}: ${(err as Error).message}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { prices: {}, problems: [`${file} is not valid JSON (${(err as Error).message}), so none of its prices are used.`] };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return { prices: {}, problems: [`${file} should be an object from model id to prices, so none of its prices are used.`] };
  const prices: Record<string, ModelPrice> = {};
  const problems: string[] = [];
  for (const [model, v] of Object.entries(json)) {
    const entry = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const bad = KINDS.filter((k) => !isPrice(entry[k]) && !(k === "cacheWrite1h" && entry[k] === undefined));
    if (bad.length) problems.push(`${file}: "${model}" needs a number of dollars per million tokens for ${bad.join(", ")}, so it is skipped.`);
    else prices[model] = Object.fromEntries(KINDS.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]])) as ModelPrice;
  }
  return { prices, problems };
}

/** Use the prices in `~/.reflex/prices.json` from now on; returns what was wrong with the file. */
export function loadPriceFile(file = paths.prices()): string[] {
  const { prices, problems } = readPriceFile(file);
  setPriceOverrides(prices);
  return problems;
}
