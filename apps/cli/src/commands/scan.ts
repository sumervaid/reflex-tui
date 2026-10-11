import type { NormalizedSession, SourceId, TranscriptAdapter } from "@reflex/core";
import { debug } from "@reflex/core";
import { ClaudeCodeAdapter, CodexAdapter, CursorAdapter } from "@reflex/adapters";
import { type Suggestion, analyze, buildTrace, deduplicate } from "@reflex/analysis";
import { displayPath } from "@reflex/safety";
import { Store, paths } from "@reflex/storage";
import { c, confirm, out, plural, rows, spinner, title, warn } from "../ui";
import { modelBytes } from "@reflex/embeddings";
import { type VectorResult, sessionVectors } from "../embeddings";

/** Bounds parse time and the quadratic clustering step on very large histories. */
const MAX_FILES_PER_SOURCE = 2000;

export type ScanOptions = { days: number; claudeDir?: string; codexDir?: string; cursorDir?: string; yes?: boolean };

export function parseDays(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error("--days must be a whole number between 1 and 365.");
  return n;
}

function chooseAdapters(opts: ScanOptions): { adapters: TranscriptAdapter[]; mode: "local" | "custom" } {
  if (opts.claudeDir || opts.codexDir || opts.cursorDir) {
    const adapters: TranscriptAdapter[] = [];
    if (opts.claudeDir) adapters.push(new ClaudeCodeAdapter(opts.claudeDir));
    if (opts.codexDir) adapters.push(new CodexAdapter(opts.codexDir));
    if (opts.cursorDir) adapters.push(new CursorAdapter(opts.cursorDir));
    return { adapters, mode: "custom" };
  }
  return { adapters: [new ClaudeCodeAdapter(), new CodexAdapter(), new CursorAdapter()], mode: "local" };
}

export async function scan(opts: ScanOptions): Promise<void> {
  const { adapters, mode } = chooseAdapters(opts);
  title(`Reflex scan · last ${plural(opts.days, "day")}`);

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
    out("No supported Claude Code, Codex or Cursor history was found.");
    out();
    out(`If your history lives elsewhere: ${c.cyan("reflex scan --claude-dir <dir>")}, ${c.cyan("--codex-dir <dir>")} or ${c.cyan("--cursor-dir <dir>")}`);
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
  let meaning: VectorResult = { status: "no-model" };
  try {
    store.saveScan(
      { startedAt: now.toISOString(), days: opts.days, mode, sources: perSource, files, sessions: traces.length, partial, unreadable, skippedRecords },
      traces,
    );
    const embedSpin = spinner();
    let embedding = false;
    meaning = await sessionVectors(traces, store, {
      onProgress: (n) => {
        embedding = true;
        embedSpin.start(`Comparing ${plural(n, "new session")} by meaning (local model)…`);
      },
    });
    if (embedding) embedSpin.stop(meaning.status === "ok" ? "Compared by meaning" : "Meaning comparison unavailable");
    suggestions = analyze(traces, meaning.status === "ok" ? { vectors: meaning.vectors } : {}).suggestions;
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
  if (capped) warn(`${plural(capped, "older file")} skipped; Reflex reads the ${MAX_FILES_PER_SOURCE} most recent per source. Use a shorter --days window.`);
  if (meaning.status === "ok") out(c.dim(`  requests compared by words and by meaning (local model; ${plural(meaning.embedded, "session")} newly embedded)`));
  else if (meaning.status === "failed") warn(`Meaning comparison skipped (${meaning.error}); requests were compared by words only.`);
  out(`  ${c.green("0 bytes uploaded")} · transcripts were read locally; only redacted summaries were stored in ${displayPath(paths.db())}`);
  out();
  if (!traces.length) {
    out(`No sessions in the last ${plural(opts.days, "day")}. Try a longer history window: ${c.cyan("reflex scan --days 30")}`);
    return;
  }
  out(
    suggestions.length
      ? `${plural(suggestions.length, "repeated workflow")} found. Next: ${c.cyan("reflex suggest")}`
      : `No repeated workflows yet. Details: ${c.cyan("reflex suggest")}`,
  );
  if (meaning.status === "no-model") out(c.dim(`Tip: ${c.cyan("reflex model fetch")} also matches requests worded differently (optional, ${Math.round(modelBytes() / 1e6)} MB, runs locally).`));
}
