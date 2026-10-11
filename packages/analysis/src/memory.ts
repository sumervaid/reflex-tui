import type { WorkflowTrace } from "@reflex/core";
import { type Constraint, recurringCorrections } from "./corrections";
import { deduplicate } from "./dedup";

/** Agents read memory on every session start, so it stays short. */
export const MAX_MEMORY = 20;

/**
 * Corrections the developer gave in at least two independent sessions, across all of their work:
 * what a new agent session should already know. Copies, resumes and retries count once, and the
 * same safety rules as skill constraints apply (only words a pair of sessions shared, no commands,
 * paths or attempts to steer the agent).
 */
export function recurringMemory(traces: WorkflowTrace[]): Constraint[] {
  const { instances } = deduplicate(traces);
  return recurringCorrections(instances.map((i) => i.primary.corrections ?? [])).slice(0, MAX_MEMORY);
}
