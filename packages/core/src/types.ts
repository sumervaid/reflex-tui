export type SourceId = "claude-code" | "codex";

export const SOURCE_LABELS: Record<SourceId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** All text fields below are redacted by the adapter before they leave it. */
export type UserRequest = {
  at?: string;
  text: string;
};

export type FileOp = "read" | "write" | "edit";

export type SessionEvent =
  | { kind: "user"; at?: string; text: string }
  | { kind: "assistant"; at?: string; text: string }
  | { kind: "tool"; at?: string; tool: string; isError?: boolean }
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
  /** Content fingerprint used to detect copies of the same session. */
  fingerprint: string;
  /** Hashes of individual user/action events, used to detect resumed sessions. */
  eventHashes: string[];
  sourceFile: string;
};
