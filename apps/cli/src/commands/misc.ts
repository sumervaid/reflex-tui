import { spawnSync } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_LABELS } from "@reflix/core";
import { createAdapters } from "@reflix/adapters";
import { analyze, deduplicate, isGenericTrace } from "@reflix/analysis";
import { displayPath, excerpt, pathExists } from "@reflix/safety";
import { Store, paths } from "@reflix/storage";
import { detectTargets } from "@reflix/skills";
import { c, confirm, ok, out, plural, rows, shortDate, title } from "../ui";

export async function doctor(): Promise<void> {
  title("Reflix doctor");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const home = paths.home();
  let homeMode = "not created yet";
  if (await pathExists(home)) homeMode = `mode ${((await stat(home)).mode & 0o777).toString(8)}`;
  rows([
    ["Node.js", `${process.versions.node} ${nodeMajor >= 22 ? c.green("ok") : c.red("needs >= 22.13")}`],
    ["SQLite", `built-in node:sqlite ${c.green("ok")}`],
    ["Reflix home", `${displayPath(home)} ${c.dim(homeMode)}`],
    ["Network", "Reflix opens no network connections (enforced in-process)"],
  ]);
  out();
  out("Transcript sources (detected by location; nothing is read)");
  for (const a of createAdapters()) {
    const d = await a.detect();
    out(`  ${d.found ? c.green("✔") : c.dim("·")} ${a.label.padEnd(12)} ${d.location} ${c.dim(d.found ? plural(d.candidateFiles ?? 0, "file") : "not found")}`);
  }
  out();
  out("Skill install targets");
  for (const t of await detectTargets()) out(`  ${t.detected ? c.green("✔") : c.dim("·")} ${t.label.padEnd(12)} ${displayPath(t.skillsDir)}`);
  out();
  out("Agent CLIs (for fresh-task validation)");
  for (const bin of ["claude", "codex"]) {
    const found = spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
    out(`  ${found ? c.green("✔") : c.dim("·")} ${bin}`);
  }
  out();
}

export async function sessions(): Promise<void> {
  const store = new Store();
  try {
    const scan = store.latestScan();
    if (!scan) throw new Error("No scan yet. Run `reflix scan --days 7` first.");
    const traces = store.traces();
    const { instances } = deduplicate(traces);
    const primary = new Set(instances.map((i) => i.primary.sessionId));
    title(`${plural(traces.length, "session")} from the last scan (${shortDate(scan.startedAt)}, ${scan.mode})`);
    for (const t of traces) {
      const tag = !primary.has(t.sessionId) ? c.yellow(" duplicate") : isGenericTrace(t) ? c.dim(" generic") : "";
      out(`  ${c.dim(shortDate(t.startedAt))}  ${SOURCE_LABELS[t.source].padEnd(11)} ${(t.projectName ?? "?").padEnd(14)} ${excerpt(t.excerpt, 60)}${tag}`);
    }
    out();
  } finally {
    store.close();
  }
}

export async function stats(): Promise<void> {
  const store = new Store();
  try {
    const scan = store.latestScan();
    if (!scan) throw new Error("No scan yet. Run `reflix scan --days 7` first.");
    const traces = store.traces();
    const a = analyze(traces);
    const counts = store.statusCounts();
    const repos = new Set(traces.map((t) => t.projectHash).filter(Boolean));
    const approved = store.suggestions().filter((s) => s.status === "approved");
    title("Reflix metrics (counts only, from local data)");
    rows([
      ["Sessions analyzed", String(traces.length)],
      ["Independent after de-duplication", String(a.stats.dedup.instances)],
      ["Unique repositories", String(repos.size)],
      ["Workflow traces with reusable structure", `${a.stats.candidates} ${c.dim(`(${a.stats.generic} too generic to reuse)`)}`],
      ["Behavior clusters", String(a.stats.clusters)],
      ["Recurrent workflows (>= 3 sessions)", String(a.stats.recurrent)],
      ["Approved skills", String(counts.approved)],
      ["Rejected suggestions", String(counts.rejected)],
      ["Bytes uploaded", "0"],
    ]);
    for (const s of approved) {
      const minutes = s.data.medianMinutes ? `, median ${Math.round(s.data.medianMinutes)} min each by transcript timestamps` : "";
      out(c.dim(`  ${s.slug}: ${s.data.instances} historical instances consolidated${minutes}`));
    }
    out();
  } finally {
    store.close();
  }
}

export async function reset(opts: { yes?: boolean }): Promise<void> {
  const home = paths.home();
  if (!(await pathExists(home))) {
    out("Nothing to reset.");
    return;
  }
  out(`This deletes Reflix's own data in ${displayPath(home)}: the local database, generated skills, demo history and validation sandboxes.`);
  out(c.dim("Skills you installed into Claude Code or Codex are not touched."));
  if (!(await confirm("Delete Reflix data?", opts))) return;
  // Only remove what Reflix creates, never the whole directory: REFLIX_HOME may point anywhere.
  for (const child of ["reflix.db", "reflix.db-journal", "skills", "demo-history", "validation"]) {
    await rm(join(home, child), { recursive: true, force: true });
  }
  ok("Reset.");
}
