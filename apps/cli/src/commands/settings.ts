import { DEFAULT_MATCHING, MAX_SESSIONS, MIN_SESSIONS, STRICTNESS, type Strictness, describeMatching } from "@reflex/analysis";
import { type StoredMatchingSettings, Store } from "@reflex/storage";
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
 *
 * Reflex can also move the bar itself, one step at a time, from the user's approve/reject decisions —
 * but only while the bar is at the defaults and unlocked. Anything set here (`--sessions`,
 * `--strictness`, `--reset` with other flags) belongs to the user, and learning stops until a
 * `--reset` hands it back.
 */
export async function settingsMatching(opts: { sessions?: string; strictness?: string; reset?: boolean; lock?: boolean }): Promise<void> {
  const store = new Store();
  try {
    const before = store.matchingSettings();
    let next: StoredMatchingSettings = { ...before };
    let changed = false;
    if (opts.lock) {
      next = { ...next, locked: true };
      changed = !before.locked;
    }
    if (opts.sessions !== undefined || opts.strictness !== undefined) {
      if (opts.sessions !== undefined) next = { ...next, sessions: parseSessions(opts.sessions) };
      if (opts.strictness !== undefined) next = { ...next, strictness: parseStrictness(opts.strictness) };
      next = { ...next, origin: "user" };
      changed = changed || next.sessions !== before.sessions || next.strictness !== before.strictness;
    } else if (opts.reset) {
      next = { ...DEFAULT_MATCHING, origin: "reflex", locked: false, decisionsSinceMove: 0 };
      changed = changed || next.sessions !== before.sessions || next.strictness !== before.strictness;
    }
    if (changed) store.setMatchingSettings(next);

    title("Matching");
    rows([
      ["Sessions needed", `${next.sessions} ${c.dim(`· independent sessions of the same task, ${MIN_SESSIONS} to ${MAX_SESSIONS} (default ${DEFAULT_MATCHING.sessions})`)}`],
      ["Strictness", `${next.strictness} ${c.dim("· how alike their requests and steps must be: looser, default or stricter")}`],
      ["Bar control", next.locked ? "locked" : next.origin === "user" ? "yours" : c.dim("Reflex adjusts it a step at a time from your decisions; lock with --lock")],
    ]);
    out();
    if (!changed) {
      out(c.dim(`Change with --sessions <n> and --strictness <level>; --reset goes back to ${describeMatching(DEFAULT_MATCHING)}; --lock stops Reflex from moving the bar.`));
      return;
    }
    if (opts.lock && !opts.sessions && !opts.strictness && !opts.reset) {
      ok("Locked. Reflex won't move the bar on its own.");
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
