import type { SourceId } from "@reflex/core";

export type FixtureStep =
  | { bash: string; fail?: boolean }
  | { read: string }
  | { edit: string }
  | { write: string }
  | { grep: string }
  | { tool: string }
  | { say: string }
  | { user: string };

export type FixtureSession = {
  key: string;
  source: SourceId;
  project: string;
  /** Days before "now" the session started. */
  daysAgo: number;
  /** Extra hours before "now" (on top of daysAgo). */
  hoursAgo?: number;
  prompt: string;
  steps: FixtureStep[];
  summary: string;
};

export type FixtureVariant =
  /** Byte-identical copy of another session's file under a different directory. */
  | { kind: "mirror"; of: string; project: string }
  /** New session id that replays another session's messages and then continues. */
  | { kind: "resume"; of: string; extra: FixtureStep[]; prompt: string };
