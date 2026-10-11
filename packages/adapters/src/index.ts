import type { TranscriptAdapter } from "@reflex/core";
import { ClaudeCodeAdapter } from "./claude";
import { CodexAdapter } from "./codex";
import { CursorAdapter } from "./cursor";

export { ClaudeCodeAdapter } from "./claude";
export { CodexAdapter } from "./codex";
export { CursorAdapter, decodeWorkspace } from "./cursor";
export { readJsonl } from "./jsonl";

export type AdapterRoots = { claude?: string; codex?: string; cursor?: string };

export function createAdapters(roots: AdapterRoots = {}): TranscriptAdapter[] {
  return [new ClaudeCodeAdapter(roots.claude), new CodexAdapter(roots.codex), new CursorAdapter(roots.cursor)];
}
