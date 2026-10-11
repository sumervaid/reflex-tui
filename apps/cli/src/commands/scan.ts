import { rm } from "node:fs/promises";
import type { NormalizedSession, SourceId, TranscriptAdapter } from "@reflix/core";
import { debug } from "@reflix/core";
import { ClaudeCodeAdapter, CodexAdapter } from "@reflix/adapters";
import { type Suggestion, analyze, buildTrace, deduplicate } from "@reflix/analysis";
import { displayPath } from "@reflix/safety";
import { Store, paths } from "@reflix/storage";
import { writeDemoHistory } from "@reflix/test-fixtures";
import { c, confirm, out, plural, rows, spinner, title, warn } from "../ui";

/** Bounds parse time and the quadratic clustering step on very large histories. */
const MAX_FILES_PER_SOURCE = 2000;

export type ScanOptions = { days: number; demo?: boolean; claudeDir?: string; codexDir?: string; yes?: boolean };

export function parseDays(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error("--days must be a whole number between 1 and 365.");
  return n;
}

async function chooseAdapters(opts: ScanOptions): Promise<{ adapters: TranscriptAdapter[]; mode: "local" | "demo" | "custom" }> {
  if (opts.demo) {
    const root = paths.demoHistory();
    await rm(root, { recursive: true, force: true });
    const h = await writeDemoHistory(root);
    out(c.dim(`Demo history (sanitized fixtures, timestamps relative to now) written to ${displayPath(root)}`));
    return { adapters: [new ClaudeCodeAdapter(h.claudeRoot), new CodexAdapter(h.codexRoot)], mode: "demo" };
  }
  if (opts.claudeDir || opts.codexDir) {
    const adapters: TranscriptAdapter[] = [];
    if (opts.claudeDir) adapters.push(new ClaudeCodeAdapter(opts.claudeDir));
    if (opts.codexDir) adapters.push(new CodexAdapter(opts.codexDir));
    return { adapters, mode: "custom" };
  }
  return { adapters: [new ClaudeCodeAdapter(), new CodexAdapter()], mode: "local" };
}

export async function scan(opts: ScanOptions): Promise<void> {
  const { adapters, mode } = await chooseAdapters(opts);
  title(`Reflix scan · last ${plural(opts.days, "day")}${mode === "demo" ? " · demo history" : ""}`);

  const found: TranscriptAdapter[] = [];
  const detection: Array<[string, string]> = [];
  for (const a of adapters) {
    const d = await a.detect();
    detection.push([a.label, d.found ? `${d.location}  ${c.dim(`(${plural(d.candidateFiles ?? 0, "transcript file")})`)}` : c.dim(`not found at ${d.location}`)]);
    if (d.found) found.push(a);
  }
  out("History locations (file names only, nothing read yet):");
  rows(detection);
  out();

  if (!found.length) {
    out("No supported Claude Code or Codex history was found.");
    out();
    out("You can:");
    out(`  1. provide a transcript directory   ${c.cyan("reflix scan --claude-dir <dir>")}  or  ${c.cyan("--codex-dir <dir>")}`);
    out(`  2. run the demo fixtures             ${c.cyan("reflix scan --demo")}`);
    return;
  }

  const permitted: TranscriptAdapter[] = [];
  for (const a of found) {
    if (await a.requestPermission((m) => confirm(m, { yes: opts.yes }), opts.days)) permitted.push(a);
  }
  if (!permitted.length) {
    out();
    out("Permission not granted. Nothing was read and nothing was stored.");
    return;
  }

  const now = new Date();
  const perSource: Partial<Record<SourceId, number>> = {};
  const sessions: NormalizedSession[] = [];
  let files = 0;
  let partial = 0;
  let unreadable = 0;
  let skippedRecords = 0;
  let capped = 0;

  const spin = spinner();
  for (const a of permitted) {
    const all = await a.discover({ days: opts.days, now });
    const list = all.sort((x, y) => y.modifiedAt.getTime() - x.modifiedAt.getTime()).slice(0, MAX_FILES_PER_SOURCE);
    capped += all.length - list.length;
    spin.start(`Reading ${plural(list.length, `${a.label} file`)}…`);
    for (const file of list) {
      files++;
      const result = await a.parse(file, { days: opts.days, now });
      if (result.unreadable) {
        unreadable++;
        continue;
      }
      skippedRecords += result.skippedRecords;
      if (result.skippedRecords > 0 && result.sessions.length) partial += result.sessions.length;
      sessions.push(...result.sessions);
      perSource[a.id] = (perSource[a.id] ?? 0) + result.sessions.length;
    }
    spin.stop(`${a.label}: ${plural(perSource[a.id] ?? 0, "session")} from ${plural(list.length, "file")}`);
  }
  debug("sessions parsed", { sessions: sessions.length, files, skipped: skippedRecords, unreadable });

  const traces = sessions.map(buildTrace);
  const store = new Store();
  let suggestions: Suggestion[] = [];
  try {
    store.saveScan(
      { startedAt: now.toISOString(), days: opts.days, mode, sources: perSource, files, sessions: traces.length, partial, unreadable, skippedRecords },
      traces,
    );
    suggestions = analyze(traces).suggestions;
    store.saveSuggestions(store.latestScan()!.id, suggestions);
  } finally {
    store.close();
  }
  const { stats } = deduplicate(traces);

  out();
  rows(permitted.map((a) => [a.label, plural(perSource[a.id] ?? 0, "session")]));
  out();
  out(`  ${c.bold(plural(traces.length, "session"))} analyzed · ${plural(stats.instances, "independent session")} after de-duplication`);
  const folded = [
    stats.copies && plural(stats.copies, "copy", "copies"),
    stats.resumed && plural(stats.resumed, "resumed session"),
    stats.retries && plural(stats.retries, "retry", "retries"),
  ].filter(Boolean);
  if (folded.length) out(c.dim(`  counted once: ${folded.join(", ")}`));
  if (partial) out(c.dim(`  ${plural(partial, "session")} partially recovered (${plural(skippedRecords, "malformed record")} skipped)`));
  if (unreadable) warn(`${plural(unreadable, "unreadable file")} skipped`);
  if (capped) warn(`${plural(capped, "older file")} skipped; Reflix reads the ${MAX_FILES_PER_SOURCE} most recent per source. Use a shorter --days window.`);
  out(`  ${c.green("0 bytes uploaded")} · transcripts were read locally; only redacted summaries were stored in ${displayPath(paths.db())}`);
  out();
  if (!traces.length) {
    out(`No sessions in the last ${plural(opts.days, "day")}. Try a longer history window: ${c.cyan("reflix scan --days 30")}`);
    return;
  }
  out(
    suggestions.length
      ? `${plural(suggestions.length, "repeated workflow")} found. Next: ${c.cyan("reflix suggest")}`
      : `No repeated workflows yet. Details: ${c.cyan("reflix suggest")}`,
  );
}
