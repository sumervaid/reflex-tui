type Fields = Record<string, string | number | boolean | undefined>;

/**
 * Local-only debug logging, enabled with REFLIX_DEBUG=1. Callers must pass counts and
 * identifiers only, never transcript text.
 */
export function debug(event: string, fields: Fields = {}): void {
  if (process.env.REFLIX_DEBUG !== "1") return;
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`);
  process.stderr.write(`[reflix] ${event}${parts.length ? " " + parts.join(" ") : ""}\n`);
}
