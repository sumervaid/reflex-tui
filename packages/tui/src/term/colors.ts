// Hex colors to xterm-256 indexes. Only the 6x6x6 cube (16..231) and the grayscale ramp (232..255)
// are used: the 16 system colors depend on the user's terminal theme.

const LEVELS = [0, 95, 135, 175, 215, 255];

/** The RGB value of an xterm-256 cube or grayscale entry (16..255). */
export function xtermRgb(i: number): [number, number, number] {
  if (i >= 232) {
    const g = 8 + (i - 232) * 10;
    return [g, g, g];
  }
  const n = i - 16;
  return [LEVELS[Math.floor(n / 36)]!, LEVELS[Math.floor(n / 6) % 6]!, LEVELS[n % 6]!];
}

/** "#rrggbb" or "#rgb" (the "#" is optional) as RGB, or null when it is not a hex color. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const cache = new Map<string, number | null>();

/** Like `toXterm256`, but null for a string that is not a hex color. */
export function tryXterm256(hex: string): number | null {
  const hit = cache.get(hex);
  if (hit !== undefined) return hit;
  const rgb = parseHex(hex);
  let best: number | null = null;
  if (rgb) {
    let bestD = Infinity;
    for (let i = 16; i < 256; i++) {
      const [r, g, b] = xtermRgb(i);
      const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
      // Strictly smaller: ties go to the lower index, so the result is deterministic.
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  if (cache.size > 4096) cache.clear();
  cache.set(hex, best);
  return best;
}

/**
 * The xterm-256 index of a hex color: exact for every cube and grayscale entry (so for every
 * `COLOR` token), otherwise the nearest entry by RGB distance, ties to the lower index.
 * Throws on a string that is not a hex color.
 */
export function toXterm256(hex: string): number {
  const i = tryXterm256(hex);
  if (i === null) throw new TypeError(`not a hex color: ${JSON.stringify(hex)}`);
  return i;
}
