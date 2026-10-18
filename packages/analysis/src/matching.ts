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
