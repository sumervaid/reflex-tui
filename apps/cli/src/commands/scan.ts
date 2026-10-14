import type { SourceId, TranscriptAdapter } from "@reflex/core";
import { debug } from "@reflex/core";
import { ClaudeCodeAdapter, CodexAdapter, CursorAdapter } from "@reflex/adapters";
import { type CoveredWorkflow, type Suggestion, analyze, deduplicate } from "@reflex/analysis";
import { totalmem } from "node:os";
import { displayPath } from "@reflex/safety";
import { type MemorySync, syncMemory } from "@reflex/skills";
import { Store, paths } from "@reflex/storage";
import { c, confirm, out, plural, rows, spinner, title, warn } from "../ui";
import { DEFAULT_MODEL, MINILM, modelBytes } from "@reflex/embeddings";
import { EMBED_BUDGET_MS, type VectorResult, sessionVectors, vectorNeeds } from "../embeddings";
import { MAX_FILES_PER_SOURCE, collect, currentKeys } from "../collect";
import { analysisKey, ownSkills, summarize } from "../analysis";

export type ScanOptions = {
  days: number;
  claudeDir?: string;
  codexDir?: string;
  cursorDir?: string;
  /** Only read these sources (`--source`). */
  source?: SourceId[];
  yes?: boolean;
  /** Read every file again instead of reusing what earlier scans cached. */
  full?: boolean;
  /** Most minutes to spend embedding new sessions; the rest wait for the next scan. */
  embedMinutes?: number;
};

export function parseEmbedMinutes(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 60) throw new Error("--embed-minutes must be a number of minutes between 0 and 1440.");
  return n;
}

/** "45 s", "3 min", "1 h 20 min". */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function parseDays(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error("--days must be a whole number between 1 and 365.");
  return n;
}

function chooseAdapters(opts: ScanOptions): { adapters: TranscriptAdapter[]; mode: "local" | "custom" } {
  const only = (list: TranscriptAdapter[]) => (opts.source?.length ? list.filter((a) => opts.source!.includes(a.id)) : list);
  if (opts.claudeDir || opts.codexDir || opts.cursorDir) {
    const adapters: TranscriptAdapter[] = [];
    if (opts.claudeDir) adapters.push(new ClaudeCodeAdapter(opts.claudeDir));
    if (opts.codexDir) adapters.push(new CodexAdapter(opts.codexDir));
    if (opts.cursorDir) adapters.push(new CursorAdapter(opts.cursorDir));
    return { adapters: only(adapters), mode: "custom" };
  }
  return { adapters: only([new ClaudeCodeAdapter(), new CodexAdapter(), new CursorAdapter()]), mode: "local" };
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
  const store = new Store();
  let suggestions: Suggestion[] = [];
  let covered: CoveredWorkflow[] = [];
  let memoryResult: MemorySync | undefined;
  let meaning: VectorResult = { status: "no-model" };
  let collected;
  try {
    const spin = spinner();
    collected = await collect(permitted, store, {
      days: opts.days,
      now,
      full: opts.full,
      keys: currentKeys(),
      needsDocument: await vectorNeeds(store),
      onSource: (a, n) => spin.start(`Checking ${plural(n, `${a.label} file`)}…`),
    });
    spin.stop(`${plural(collected.files, "file")} checked: ${collected.read} read, ${collected.reused} unchanged`);
    debug("sessions collected", { sessions: collected.traces.length, files: collected.files, read: collected.read, reused: collected.reused, kept: collected.kept });
    const { traces } = collected;
    store.saveScan(
      {
        startedAt: now.toISOString(),
        days: opts.days,
        mode,
        sources: collected.perSource,
        files: collected.files,
        sessions: traces.length,
        partial: collected.partial,
        unreadable: collected.unreadable,
        skippedRecords: collected.skippedRecords,
      },
      collected.rows,
    );
    const embedSpin = spinner();
    let embedding = false;
    meaning = await sessionVectors(traces, store, {
      documents: collected.documents,
      budgetMs: (opts.embedMinutes ?? EMBED_BUDGET_MS / 60_000) * 60_000,
      onProgress: (done, total, model, eta) => {
        const text = `Comparing new sessions by meaning (local model ${model.name}): ${done} of ${total}${eta === undefined ? "" : `, about ${duration(eta)} left`}`;
        if (!embedding) embedSpin.start(text);
        else embedSpin.message(text);
        embedding = true;
      },
    });
    if (embedding) embedSpin.stop(meaning.status === "ok" ? "Compared by meaning" : "Meaning comparison unavailable");
    const own = ownSkills(store);
    const analysis = analyze(traces, { ...(meaning.status === "ok" ? { vectors: meaning.vectors } : {}), ownSkills: own });
    suggestions = analysis.suggestions;
    covered = analysis.stats.covered ?? [];
    const scanId = store.latestScan()!.id;
    store.saveSuggestions(scanId, suggestions);
    store.saveAnalysis(scanId, analysisKey(meaning.status === "ok" ? meaning.model.id : undefined, own), summarize(analysis, traces));
    memoryResult = await syncMemory(store);
  } finally {
    store.close();
  }
  const { traces, perSource, partial, skippedRecords, unreadable, capped, kept } = collected;
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
  const conductor = traces.filter((t) => t.harness?.name === "conductor");
  if (conductor.length) {
    const workspaces = new Set(conductor.map((t) => `${t.projectHash}/${t.harness!.workspace}`)).size;
    out(c.dim(`  ${plural(conductor.length, "session")} ran in ${plural(workspaces, "Conductor workspace")}, grouped by repository`));
  }
  if (partial) out(c.dim(`  ${plural(partial, "session")} partially recovered (${plural(skippedRecords, "malformed record")} skipped)`));
  if (unreadable) warn(`${plural(unreadable, "unreadable file")} skipped`);
  if (kept) out(c.dim(`  ${plural(kept, "session")} kept from transcripts that have since been deleted`));
  if (capped) warn(`${plural(capped, "older file")} skipped; Reflex reads the ${MAX_FILES_PER_SOURCE} most recent per source. Use a shorter --days window.`);
  if (meaning.status === "ok") {
    out(c.dim(`  requests compared by words and by meaning (local model ${meaning.model.name}; ${plural(meaning.embedded, "session")} newly embedded)`));
    if (meaning.stoppedBy === "time")
      out(
        c.dim(
          `  ${plural(meaning.remaining, "older session")} not embedded yet (time limit); compared by words for now, the next scan continues (${c.cyan("--embed-minutes")} to change the limit)`,
        ),
      );
    if (meaning.stoppedBy === "memory")
      warn(
        `${plural(meaning.remaining, "session")} not compared by meaning: ${meaning.model.name} needs about ${(meaning.model.peakMemoryMB / 1000).toFixed(1)} GB and this machine has ${(totalmem() / 1e9).toFixed(0)} GB. Try the light model: reflex model fetch --light`,
      );
  }
  else if (meaning.status === "failed") warn(`Meaning comparison skipped (${meaning.error}); requests were compared by words only.`);
  out(`  ${c.green("0 bytes uploaded")} · transcripts were read locally; only redacted summaries were stored in ${displayPath(paths.db())}`);
  if (memoryResult?.writes.length) {
    const changed = memoryResult.writes.filter((w) => w.changed).length;
    out(`  agent memory: ${plural(memoryResult.rules, "entry", "entries")}${changed ? ` · updated ${memoryResult.writes.filter((w) => w.changed).map((w) => displayPath(w.path)).join(", ")}` : " · unchanged"}`);
    for (const w of memoryResult.writes) if (w.skipped) warn(w.skipped);
  } else if (memoryResult?.rules) {
    out(c.dim(`  ${plural(memoryResult.rules, "correction")} your agents could remember across sessions: reflex memory`));
  }
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
  for (const w of covered) {
    const names = w.skills.slice(0, 3).map((s) => s.name);
    out(c.dim(`Already handled by your skills (${names.join(", ")}): ${w.title.toLowerCase()} · ${c.cyan(`reflex improve ${names[0]}`)}`));
  }
  if (meaning.status === "no-model")
    out(
      c.dim(
        `Tip: ${c.cyan("reflex model fetch")} also matches requests worded differently, in any language (optional, ${Math.round(modelBytes(DEFAULT_MODEL) / 1e6)} MB, runs locally; ${c.cyan("--light")} for a ${Math.round(modelBytes(MINILM) / 1e6)} MB English-only model).`,
      ),
    );
}
