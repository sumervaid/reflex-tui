import type { TranscriptAdapter } from "@reflix/core";
import { ClaudeCodeAdapter } from "./claude";
import { CodexAdapter } from "./codex";

export { ClaudeCodeAdapter } from "./claude";
export { CodexAdapter } from "./codex";
export { readJsonl } from "./jsonl";

export type AdapterRoots = { claude?: string; codex?: string };

export function createAdapters(roots: AdapterRoots = {}): TranscriptAdapter[] {
  return [new ClaudeCodeAdapter(roots.claude), new CodexAdapter(roots.codex)];
}
