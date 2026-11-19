import { CLUSTER_THRESHOLD, MIN_INTENT_COHESION, MIN_INTENT_LINK } from "./cluster";

export const STRICTNESS = ["looser", "default", "stricter"] as const;
export type Strictness = (typeof STRICTNESS)[number];

/**
 * What counts as a repeated workflow, as the user set it: how many independent sessions a
 * suggestion needs, and how alike they must be.
 */
export type MatchingSettings = { sessions: number; strictness: Strictness };

export const MIN_SESSIONS = 2;
export const MAX_SESSIONS = 5;
export const DEFAULT_MATCHING: MatchingSettings = { sessions: 3, strictness: "default" };

/** The thresholds a strictness level moves together; "default" is the set chosen against the eval sets. */
export type Thresholds = { cluster: number; intentLink: number; intentCohesion: number };

const STEP = 0.05;

export function thresholds(strictness: Strictness): Thresholds {
  const d = strictness === "looser" ? -STEP : strictness === "stricter" ? STEP : 0;
  return { cluster: CLUSTER_THRESHOLD + d, intentLink: MIN_INTENT_LINK + d, intentCohesion: MIN_INTENT_COHESION + d };
}

export const isDefaultMatching = (m: MatchingSettings): boolean => m.sessions === DEFAULT_MATCHING.sessions && m.strictness === DEFAULT_MATCHING.strictness;

/** "2 sessions, looser matching", for showing settings that differ from the defaults. */
export const describeMatching = (m: MatchingSettings): string => `${m.sessions} sessions, ${m.strictness} matching`;

/** Why a suggestion was rejected. Only "wrong-grouping" says something about matching. */
export const REJECT_REASONS = ["not-useful", "wrong-grouping"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export type Decision = "approved" | RejectReason;

/** Decisions collected before the bar considers moving; it never reacts to a single choice. */
export const DECISIONS_BEFORE_ADJUSTING = 5;

/** How much of a batch must agree before the bar moves. The issue's example is 6 of 8. */
const MOST = 0.75;

/**
 * One step looser or stricter: the strictness thresholds move first (±0.05, a small nudge to what
 * counts as alike), and only at the edge of those does the session count move. A step off the floor
 * or ceiling is no change at all, so callers can tell nothing happened.
 */
export function stepMatching(m: MatchingSettings, direction: "looser" | "stricter"): MatchingSettings {
  if (direction === "looser") {
    if (m.strictness !== "looser") return { ...m, strictness: "looser" };
    return { ...m, sessions: Math.max(MIN_SESSIONS, m.sessions - 1) };
  }
  if (m.strictness !== "stricter") return { ...m, strictness: "stricter" };
  return { ...m, sessions: Math.min(MAX_SESSIONS, m.sessions + 1) };
}

/**
 * The bar a user's own decisions ask for. Only stored decisions are counted, and those are all
 * suggestions that already cleared the bar, so a high approval rate can only mean "show a little
 * more", never "drop the bar". Decisions that came back "not useful" say nothing about matching:
 * the grouping was right, the workflow just isn't wanted. Nothing moves on a mixed batch.
 */
export function learnedMatching(
  current: MatchingSettings,
  decisions: Decision[],
): { next: MatchingSettings; direction: "looser" | "stricter"; message: string } | undefined {
  const total = decisions.length;
  if (total < DECISIONS_BEFORE_ADJUSTING) return undefined;
  const approved = decisions.filter((d) => d === "approved").length;
  const regrouped = decisions.filter((d) => d === "wrong-grouping").length;
  const direction: "looser" | "stricter" | undefined =
    approved / total >= MOST ? "looser" : regrouped > approved && regrouped / total >= MOST ? "stricter" : undefined;
  if (!direction) return undefined;
  const next = stepMatching(current, direction);
  if (next.sessions === current.sessions && next.strictness === current.strictness) return undefined;
  const message =
    direction === "looser"
      ? `Showing a bit more: you approved ${approved} of your last ${total} suggestions. The new bar applies at the next scan.`
      : `Matching a bit stricter: ${regrouped} of your last ${total} suggestions mixed unrelated tasks. The new bar applies at the next scan.`;
  return { next, direction, message: `${message} Lock the bar with ${"`reflex settings matching --lock`"}.` };
}
