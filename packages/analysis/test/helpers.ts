import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptAdapter, WorkflowTrace } from "@reflex/core";
import { ClaudeCodeAdapter, CodexAdapter } from "@reflex/adapters";
import { type FixtureSession, writeFixtureHistory } from "@reflex/test-fixtures";
import { buildTrace } from "../src/trace";

export const NOW = new Date("2026-10-11T12:00:00Z");

export async function fixtureTraces(sessions?: FixtureSession[]): Promise<WorkflowTrace[]> {
  const root = await mkdtemp(join(tmpdir(), "reflex-analysis-"));
  const history = await writeFixtureHistory(root, NOW, sessions);
  const adapters: TranscriptAdapter[] = [new ClaudeCodeAdapter(history.claudeRoot), new CodexAdapter(history.codexRoot)];
  const traces: WorkflowTrace[] = [];
  for (const adapter of adapters) {
    for (const file of await adapter.discover({ days: 7, now: NOW })) {
      const result = await adapter.parse(file, { days: 7, now: NOW });
      traces.push(...result.sessions.map(buildTrace));
    }
  }
  return traces;
}
