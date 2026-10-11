export type SourceId = "claude-code" | "codex" | "cursor";

export const SOURCE_IDS: readonly SourceId[] = ["claude-code", "codex", "cursor"];

export const SOURCE_LABELS: Record<SourceId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** All text fields below are redacted by the adapter before they leave it. */
export type UserRequest = {
  at?: string;
  text: string;
};

export type FileOp = "read" | "write" | "edit";

/** Token counts as recorded by the source tool. `input` excludes cached input. */
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export function totalTokens(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

export function addUsage(a: TokenUsage | undefined, b: TokenUsage): TokenUsage {
  if (!a) return { ...b };
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

export type SessionEvent =
  | { kind: "user"; at?: string; text: string }
  | { kind: "assistant"; at?: string; text: string }
  | { kind: "tool"; at?: string; tool: string; isError?: boolean; skill?: string }
  | { kind: "shell"; at?: string; command: string; isError?: boolean }
  | { kind: "file"; at?: string; op: FileOp; path: string; isError?: boolean }
  | { kind: "error"; at?: string; message: string };

export type LocalSourceReference = {
  /** Display-safe path to the transcript file (home directory collapsed, user names removed). */
  file: string;
  /** Session identifier as written by the source tool. */
  nativeId: string;
};

export type NormalizedSession = {
  /** `${source}:${nativeId}` */
  id: string;
  source: SourceId;
  startedAt?: string;
  endedAt?: string;
  project?: {
    name?: string;
    pathHash?: string;
  };
  requests: UserRequest[];
  events: SessionEvent[];
  sourceRef: LocalSourceReference;
  /** Number of records in this session that could not be interpreted and were skipped. */
  skippedRecords: number;
  /** Absent when the source does not record token usage (Cursor). */
  usage?: TokenUsage;
  /** The same usage split by the model the source recorded for it. */
  usageByModel?: Record<string, TokenUsage>;
};

export type DetectionResult = {
  found: boolean;
  /** Display-safe location of the history root. */
  location: string;
  candidateFiles?: number;
  note?: string;
};

export type DiscoveryOptions = {
  days: number;
  now?: Date;
};

export type TranscriptFile = {
  path: string;
  displayPath: string;
  modifiedAt: Date;
  sizeBytes: number;
  /**
   * File identity for the scan cache. ctime changes on any write and cannot be set by tools that
   * preserve mtime (cp -p, rsync -t, backup restores), so size + mtime + ctime + inode together
   * detect a changed file without reading it.
   */
  identity?: { mtimeMs: number; ctimeMs: number; ino: string };
};

export type ParseResult = {
  sessions: NormalizedSession[];
  skippedRecords: number;
  totalRecords: number;
  unreadable: boolean;
  error?: string;
};

export interface TranscriptAdapter {
  id: SourceId;
  label: string;
  /** Folder this adapter reads; cached files under it that disappear are treated as deleted. */
  readonly root?: string;
  detect(): Promise<DetectionResult>;
  /** Asks the user (through the injected prompt) before any transcript content is read. */
  requestPermission(ask: (message: string) => Promise<boolean>, days: number): Promise<boolean>;
  discover(options: DiscoveryOptions): Promise<TranscriptFile[]>;
  parse(file: TranscriptFile, options: DiscoveryOptions): Promise<ParseResult>;
}

export type ActionCategory =
  | "inspect-git"
  | "inspect-diff"
  | "inspect-ci"
  | "inspect-pr"
  | "inspect-logs"
  | "inspect-repository"
  | "inspect-code"
  | "inspect-dependencies"
  | "search-code"
  | "install-dependencies"
  | "run-tests"
  | "run-build"
  | "run-lint"
  | "run-command"
  | "modify-code"
  | "modify-tests"
  | "modify-config"
  | "modify-ci"
  | "modify-dependencies"
  | "submit-review"
  | "commit"
  | "push"
  | "research"
  | "summarize";

export type CommandFingerprint = {
  /** Command with arguments generalized, e.g. `git diff <file>`. */
  normalized: string;
  action: ActionCategory;
};

export type OutcomeSignal = {
  /** A test/build/lint run succeeded after the last modification. */
  verified: boolean;
  /** At least one failing command was followed later by a passing one. */
  recoveredFromFailure: boolean;
  modified: boolean;
  summarized: boolean;
};

/** A developer's follow-up pushback: up to 8 lowercase content words in order, filler removed. */
export type Correction = {
  polarity: "avoid" | "prefer";
  words: string[];
};

export type WorkflowTrace = {
  sessionId: string;
  source: SourceId;
  startedAt?: string;
  endedAt?: string;
  projectName?: string;
  projectHash?: string;
  /** Normalized intent terms derived from the user's requests. */
  intents: string[];
  tools: string[];
  commands: CommandFingerprint[];
  fileCategories: string[];
  /** Ordered actions with consecutive repeats collapsed. */
  actionSequence: ActionCategory[];
  /** Ordered, human-readable steps for evidence display: normalized commands and file operations. */
  displaySteps: string[];
  outcome: OutcomeSignal;
  /** Redacted, truncated first request used for evidence display. */
  excerpt: string;
  /** Hash of the session's context document (see analysis `sessionContext`); keys its cached embedding. */
  contextHash?: string;
  /** Content fingerprint used to detect copies of the same session. */
  fingerprint: string;
  /** Hashes of individual user/action events, used to detect resumed sessions. */
  eventHashes: string[];
  sourceFile: string;
  usage?: TokenUsage;
  /** Usage per model, for pricing. Optional in traces stored before it existed. */
  usageByModel?: Record<string, TokenUsage>;
  /** Requests the developer typed. Optional in traces stored before it existed. */
  requests?: number;
  /** Tool calls that failed. Optional in traces stored before it existed. */
  toolErrors?: number;
  /** Shell, file and other tool calls. Optional in traces stored before it existed. */
  toolCalls?: number;
  /** Skill names the agent loaded (Skill tool call or reading a `skills/<name>/SKILL.md`). */
  skillsUsed?: string[];
  /** Corrections from follow-up requests. Optional in traces stored before it existed. */
  corrections?: Correction[];
};
