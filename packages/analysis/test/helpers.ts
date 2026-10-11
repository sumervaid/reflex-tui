import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NormalizedSession, TranscriptAdapter, WorkflowTrace } from "@reflex/core";
import { ClaudeCodeAdapter, CodexAdapter } from "@reflex/adapters";
import { type FixtureSession, writeFixtureHistory } from "@reflex/test-fixtures";
import { buildTrace } from "../src/trace";

export const NOW = new Date("2026-10-11T12:00:00Z");

export async function fixtureSessions(sessions?: FixtureSession[]): Promise<NormalizedSession[]> {
  const root = await mkdtemp(join(tmpdir(), "reflex-analysis-"));
  const history = await writeFixtureHistory(root, NOW, sessions);
  const adapters: TranscriptAdapter[] = [new ClaudeCodeAdapter(history.claudeRoot), new CodexAdapter(history.codexRoot)];
  const parsed: NormalizedSession[] = [];
  for (const adapter of adapters) {
    for (const file of await adapter.discover({ days: 7, now: NOW })) {
      parsed.push(...(await adapter.parse(file, { days: 7, now: NOW })).sessions);
    }
  }
  return parsed;
}

export async function fixtureTraces(sessions?: FixtureSession[]): Promise<WorkflowTrace[]> {
  return (await fixtureSessions(sessions)).map(buildTrace);
}
