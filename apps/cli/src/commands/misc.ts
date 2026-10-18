import { spawnSync } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SOURCE_LABELS, totalTokens } from "@reflex/core";
import { createAdapters } from "@reflex/adapters";
import { deduplicate, isGenericTrace } from "@reflex/analysis";
import { agentLaunch, displayPath, excerpt, pathExists } from "@reflex/safety";
import { Store, paths } from "@reflex/storage";
import { detectTargets, removeMemory } from "@reflex/skills";
import { activeModel } from "@reflex/embeddings";
import { latestAnalysis } from "../analysis";
import { cursorHooksFile, hookStatus, removeHook } from "../cursor-hook";
import { c, confirm, ok, out, plural, rows, shortDate, title, warn } from "../ui";

/** Conductor's default workspace folder (`~/conductor/workspaces`); `REFLEX_CONDUCTOR_DIR` overrides it. */
const conductorRoot = (): string => process.env.REFLEX_CONDUCTOR_DIR ?? join(homedir(), "conductor", "workspaces");

/** Whether Conductor's workspace folder exists, and how many repositories it holds (folder names only). */
async function conductorWorkspaces(): Promise<{ dir: string; repos: number } | undefined> {
  const dir = conductorRoot();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return { dir, repos: entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).length };
  } catch {
    return undefined;
  }
}

export async function doctor(): Promise<void> {
  title("Reflex doctor");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const home = paths.home();
  let homeMode = "not created yet";
  if (await pathExists(home)) homeMode = `mode ${((await stat(home)).mode & 0o777).toString(8)}`;
  rows([
    ["Node.js", `${process.versions.node} ${nodeMajor >= 22 ? c.green("ok") : c.red("needs >= 22.13")}`],
    ["SQLite", `built-in node:sqlite ${c.green("ok")}`],
    ["Reflex home", `${displayPath(home)} ${c.dim(homeMode)}`],
    ["Network", "Reflex opens no network connections (enforced in-process; only `reflex model fetch` downloads)"],
    ["Meaning model", await activeModel(paths.models()).then((m) => (m ? `${m.label} ${c.green("installed")}` : c.dim("not installed (optional: reflex model fetch)")))],
  ]);
  out();
  out("Transcript sources (detected by location; nothing is read)");
  for (const a of createAdapters()) {
    const d = await a.detect();
    out(`  ${d.found ? c.green("✔") : c.dim("·")} ${a.label.padEnd(12)} ${d.location} ${c.dim(d.found ? plural(d.candidateFiles ?? 0, "file") : "not found")}`);
  }
  const conductor = await conductorWorkspaces();
  out(
    conductor
      ? `  ${c.green("✔")} ${"Conductor".padEnd(12)} ${displayPath(conductor.dir)} ${c.dim(`${plural(conductor.repos, "repository", "repositories")}; its Claude Code and Codex sessions are read with those sources`)}`
      : `  ${c.dim("·")} ${"Conductor".padEnd(12)} ${displayPath(conductorRoot())} ${c.dim("not found")}`,
  );
  out();
  out("Skill install targets");
  for (const t of await detectTargets()) out(`  ${t.detected ? c.green("✔") : c.dim("·")} ${t.label.padEnd(12)} ${displayPath(t.skillsDir)}`);
  out();
  out("Agent CLIs (for fresh-task validation)");
  for (const bin of ["claude", "codex"]) {
    const launch = agentLaunch(bin, ["--version"]);
    const found = spawnSync(launch.command, launch.args, { stdio: "ignore", windowsVerbatimArguments: launch.windowsVerbatimArguments }).status === 0;
    out(`  ${found ? c.green("✔") : c.dim("·")} ${bin}`);
  }
  out();
  const hook = await hookStatus();
  out("Cursor token usage");
  out(`  ${hook.events.length ? c.green("✔") : c.dim("·")} ${"Cursor hook".padEnd(12)} ${hook.events.length ? `recording (${hook.events.join(", ")})` : c.dim("off · reflex cursor-usage on")}`);
  out();
}

export async function sessions(): Promise<void> {
  const store = new Store();
  try {
    const scan = store.latestScan();
    if (!scan) throw new Error("No scan yet. Run `reflex scan --days 7` first.");
    const traces = store.traces();
    const { instances } = deduplicate(traces);
    const primary = new Set(instances.map((i) => i.primary.sessionId));
    title(`${plural(traces.length, "session")} from the last scan (${shortDate(scan.startedAt)}, ${scan.mode})`);
    for (const t of traces) {
      const launched = t.agents?.spawned ? c.dim(` · ${plural(t.agents.spawned, "agent")}`) : "";
      const via = t.harness?.name === "conductor" ? c.dim(` via Conductor (${t.harness.workspace})`) : "";
      const tag = (!primary.has(t.sessionId) ? c.yellow(" duplicate") : isGenericTrace(t) ? c.dim(" generic") : "") + launched + via;
      const model = t.models?.[0] ?? Object.entries(t.usageByModel ?? {}).sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))[0]?.[0] ?? "—";
      out(`  ${c.dim(shortDate(t.startedAt))}  ${SOURCE_LABELS[t.source].padEnd(11)} ${(t.projectName ?? "?").padEnd(14)} ${c.dim(model.slice(0, 18).padEnd(18))} ${excerpt(t.excerpt, 60)}${tag}`);
    }
    out();
  } finally {
    store.close();
  }
}

const typeList = (types: Record<string, number>): string =>
  Object.entries(types)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => (n > 1 ? `${t} ×${n}` : t))
    .join(", ");

/** Sessions that launched agents (Cursor `Task` / `Subagent`), the kinds, and how much work the agents did. */
export async function agents(): Promise<void> {
  const store = new Store();
  try {
    if (!store.latestScan()) throw new Error("No scan yet. Run `reflex scan --days 7` first.");
    const traces = [...new Map(store.traces().map((t) => [t.sessionId, t])).values()];
    const launched = traces
      .filter((t) => t.agents && (t.agents.spawned || t.agents.transcripts))
      .sort((a, b) => b.agents!.spawned - a.agents!.spawned || b.agents!.toolCalls - a.agents!.toolCalls);
    if (!launched.length) {
      out("No session in the last scan launched agents. Reflex reads Cursor's agents; Claude Code's are not read yet.");
      return;
    }
    const types: Record<string, number> = {};
    for (const t of launched) for (const [k, n] of Object.entries(t.agents!.types)) types[k] = (types[k] ?? 0) + n;
    const sum = (f: (a: NonNullable<(typeof launched)[number]["agents"]>) => number) => launched.reduce((s, t) => s + f(t.agents!), 0);
    title(`${plural(launched.length, "session")} launched agents`);
    rows([
      ["Launched", `${plural(sum((a) => a.spawned), "agent")}${Object.keys(types).length ? ` · ${typeList(types)}` : ""}`],
      ["In background", String(sum((a) => a.background))],
      ["Their work", `${plural(sum((a) => a.toolCalls), "tool call")} in ${plural(sum((a) => a.transcripts), "agent transcript")} ${c.dim("(counted in each session's workflow)")}`],
    ]);
    out();
    for (const t of launched.slice(0, 20)) {
      const a = t.agents!;
      const what = a.spawned ? `${plural(a.spawned, "agent")} (${typeList(a.types)})` : plural(a.transcripts, "agent transcript");
      out(`  ${c.dim(shortDate(t.startedAt))}  ${(t.projectName ?? "?").padEnd(16)} ${what.padEnd(34)} ${c.dim(plural(a.toolCalls, "tool call").padEnd(14))} ${excerpt(t.excerpt, 50)}`);
      for (const d of a.descriptions.slice(0, 3)) out(c.dim(`      → ${d}`));
    }
    if (launched.length > 20) out(c.dim(`  … and ${launched.length - 20} more`));
    out();
    out(c.dim("Descriptions were written by the agent that launched them, not by you. Claude Code's agents are not read yet."));
  } finally {
    store.close();
  }
}

export async function stats(): Promise<void> {
  const store = new Store();
  try {
    const scan = store.latestScan();
    if (!scan) throw new Error("No scan yet. Run `reflex scan --days 7` first.");
    const a = await latestAnalysis(store);
    const counts = store.statusCounts();
    const approved = store.suggestions().filter((s) => s.status === "approved");
    title("Reflex metrics (counts only, from local data)");
    rows([
      ["Sessions analyzed", String(scan.sessions)],
      ["Independent after de-duplication", String(a.stats.dedup.instances)],
      ["Unique repositories", String(a.repositories)],
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
  out(`This deletes Reflex's own data in ${displayPath(home)}: the local database (including sessions kept from deleted transcripts), generated skills, validation sandboxes and recorded Cursor token counts.`);
  out(c.dim("Skills you installed into Claude Code, Codex or Cursor are not touched; Reflex's agent-memory block is removed. The embedding model is kept (`reflex model remove`)."));
  if (!(await confirm("Delete Reflex data?", opts))) return;
  // Agent memory lives in the agents' own files: take Reflex's block out before its database goes.
  for (const w of await removeMemory()) if (w.changed) ok(`Removed Reflex's memory block from ${displayPath(w.path)}`);
  // The Cursor hook points at a script in this folder: take it out of Cursor's hooks file first.
  try {
    const { removed } = await removeHook();
    if (removed.length) ok(`Removed Reflex's hook from ${displayPath(cursorHooksFile())}`);
  } catch (e) {
    warn(`Could not remove Reflex's Cursor hook: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Only remove what Reflex creates, never the whole directory: REFLEX_HOME may point anywhere.
  for (const child of ["reflex.db", "reflex.db-journal", "reflex.db-wal", "reflex.db-shm", "skills", "validation", "cursor-usage.jsonl", "hooks"]) {
    await rm(join(home, child), { recursive: true, force: true });
  }
  ok("Reset.");
}
