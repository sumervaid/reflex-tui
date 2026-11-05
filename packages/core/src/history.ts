/** The window `scan --all` uses: far enough back to cover any history. */
export const ALL_HISTORY_DAYS = 100 * 365;

/** "the last 7 days", or "all of your history" for `scan --all`. */
export function historyWindow(days: number): string {
  return days >= ALL_HISTORY_DAYS ? "all of your history" : `the last ${days} day${days === 1 ? "" : "s"}`;
}
