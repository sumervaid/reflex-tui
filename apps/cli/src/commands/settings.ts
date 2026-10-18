import { DEFAULT_MATCHING, MAX_SESSIONS, MIN_SESSIONS, type MatchingSettings, STRICTNESS, type Strictness, describeMatching } from "@reflex/analysis";
import { Store } from "@reflex/storage";
import { latestAnalysis } from "../analysis";
import { c, ok, out, plural, rows, title } from "../ui";

function parseSessions(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_SESSIONS || n > MAX_SESSIONS) throw new Error(`--sessions takes a whole number from ${MIN_SESSIONS} to ${MAX_SESSIONS}, not "${value}".`);
  return n;
}

function parseStrictness(value: string): Strictness {
  if (!(STRICTNESS as readonly string[]).includes(value)) throw new Error(`--strictness takes ${STRICTNESS.join(", ")}, not "${value}".`);
  return value as Strictness;
}

/**
 * Show or change what counts as a repeated workflow. A change re-runs the analysis of the last scan
 * right away, so `reflex suggest`, `reflex show` and the TUI all show suggestions at the new settings.
 */
export async function settingsMatching(opts: { sessions?: string; strictness?: string; reset?: boolean }): Promise<void> {
  const store = new Store();
  try {
    const before = store.matchingSettings();
    let next: MatchingSettings = opts.reset ? { ...DEFAULT_MATCHING } : before;
    if (opts.sessions !== undefined) next = { ...next, sessions: parseSessions(opts.sessions) };
    if (opts.strictness !== undefined) next = { ...next, strictness: parseStrictness(opts.strictness) };
    const changed = next.sessions !== before.sessions || next.strictness !== before.strictness;
    if (changed) store.setMatchingSettings(next);

    title("Matching");
    rows([
      ["Sessions needed", `${next.sessions} ${c.dim(`· independent sessions of the same task, ${MIN_SESSIONS} to ${MAX_SESSIONS} (default ${DEFAULT_MATCHING.sessions})`)}`],
      ["Strictness", `${next.strictness} ${c.dim("· how alike their requests and steps must be: looser, default or stricter")}`],
    ]);
    out();
    if (!changed) {
      out(c.dim(`Change with --sessions <n> and --strictness <level>; --reset goes back to ${describeMatching(DEFAULT_MATCHING)}.`));
      return;
    }
    if (!store.latestScan()) {
      ok("Saved. The next `reflex scan` uses these settings.");
      return;
    }
    await latestAnalysis(store);
    const pending = store.suggestions().filter((s) => s.status === "pending").length;
    ok(`Saved. ${plural(pending, "suggestion")} waiting for review at these settings: ${c.cyan("reflex suggest")}`);
  } finally {
    store.close();
  }
}
