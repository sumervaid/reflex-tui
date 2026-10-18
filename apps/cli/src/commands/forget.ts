import { SOURCE_LABELS, type SourceId } from "@reflex/core";
import { syncMemory } from "@reflex/skills";
import { type ForgetPlan, Store } from "@reflex/storage";
import { latestAnalysis } from "../analysis";
import { pruneEmbeddings } from "../embeddings";
import { c, confirm, ok, out, plural, rows, shortDate, title } from "../ui";

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseKeepDays(value: string, option: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 36500) throw new Error(`${option} takes a whole number of days from 1, not "${value}".`);
  return n;
}

const cutoff = (days: number, now = new Date()): string => new Date(now.getTime() - days * DAY_MS).toISOString();

/**
 * Remove the planned sessions and everything derived from them: cached vectors, their evidence in
 * suggestions, and memory entries only they supported. The analysis is redone from what is left.
 */
export async function applyForget(store: Store, plan: ForgetPlan): Promise<void> {
  store.forget(plan);
  pruneEmbeddings(store);
  if (store.latestScan()) await latestAnalysis(store);
  await syncMemory(store);
}

/** `reflex forget`: remove kept sessions by age or because their transcript is gone, after asking. */
export async function forget(opts: { olderThan?: string; missing?: boolean; yes?: boolean }): Promise<void> {
  if (opts.olderThan === undefined && !opts.missing) throw new Error("Say what to forget: --older-than <days>, --missing, or both.");
  const days = opts.olderThan === undefined ? undefined : parseKeepDays(opts.olderThan, "--older-than");
  const store = new Store();
  try {
    const plan = store.forgetPlan({ before: days === undefined ? undefined : cutoff(days), missing: opts.missing });
    const what = [days !== undefined && `older than ${plural(days, "day")}`, opts.missing && "whose transcript was deleted"].filter(Boolean).join(" or ");
    if (!plan.paths.length) {
      out(`Nothing to forget: Reflex keeps no sessions ${what}.`);
      return;
    }
    const sources = Object.entries(plan.bySource)
      .map(([s, n]) => `${SOURCE_LABELS[s as SourceId]} ${n}`)
      .join(", ");
    title("Forget");
    rows([
      ["Sessions", `${plural(plan.sessionIds.length, "session")} ${what}${sources ? c.dim(` (${sources})`) : ""}`],
      ...(plan.oldest ? ([["Dates", `${shortDate(plan.oldest)} → ${shortDate(plan.newest)}`]] as Array<[string, string]>) : []),
      ["Transcripts", `${plural(plan.paths.length, "file")}${plan.missingFiles ? c.dim(`, ${plan.missingFiles} already deleted`) : ""}`],
    ]);
    out();
    out(c.dim("  Removed from Reflex's database: their redacted steps and excerpts, their comparisons by meaning, their evidence"));
    out(c.dim("  in suggestions, and memory entries only they supported. Your agents' transcripts are not touched; one that is"));
    out(c.dim("  still on disk is read again by a scan whose window reaches it. Generated skills are kept."));
    out();
    if (!(await confirm(`Forget ${plural(plan.sessionIds.length, "session")}?`, opts))) return;
    await applyForget(store, plan);
    ok(`Forgot ${plural(plan.sessionIds.length, "session")}.`);
  } finally {
    store.close();
  }
}

/** `reflex settings retention`: show or set how many days of sessions to keep after each scan. */
export async function settingsRetention(value: string | undefined): Promise<void> {
  const store = new Store();
  try {
    if (value !== undefined) store.setRetentionDays(value === "off" ? undefined : parseKeepDays(value, "retention"));
    const days = store.retentionDays();
    title("Retention");
    rows([["Keep sessions", days ? `${plural(days, "day")} ${c.dim("· older ones are forgotten after each scan")}` : `all ${c.dim("· until `reflex forget` or `reflex reset` (default)")}`]]);
    out();
    if (value === undefined) out(c.dim("Change with `reflex settings retention <days>`, or `off` to keep everything."));
    else if (days) out(c.dim(`The next scan forgets sessions that ended more than ${plural(days, "day")} ago. To do it now: reflex forget --older-than ${days}`));
  } finally {
    store.close();
  }
}

/** After a scan: forget sessions older than the retention setting. Returns how many were forgotten. */
export async function applyRetention(store: Store, now = new Date()): Promise<number> {
  const days = store.retentionDays();
  if (!days) return 0;
  const plan = store.forgetPlan({ before: cutoff(days, now) });
  if (!plan.paths.length) return 0;
  store.forget(plan);
  return plan.sessionIds.length;
}
