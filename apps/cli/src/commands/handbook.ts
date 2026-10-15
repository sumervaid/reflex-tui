import { dirname } from "node:path";
import { type Practice, askHandbook, buildHandbook, practicesFor } from "@reflex/analysis";
import { shortHash } from "@reflex/core";
import { Store } from "@reflex/storage";
import { c, out, plural, shortDate, title } from "../ui";

/**
 * `reflex handbook`: how work is done in a repository, learned from past agent sessions. Every
 * subcommand only reads Reflex's database, so agents can call it freely: nothing they run here
 * can change what Reflex learned.
 */

export type HandbookOptions = { project?: string; all?: boolean; json?: boolean };

const TOOL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };

function load(): Practice[] {
  const store = new Store();
  try {
    if (!store.latestScan()) throw new Error("No scan yet. Run `reflex scan --days 30` first.");
    const forgotten = new Set(store.memoryEntries().filter((e) => e.status === "forgotten").map((e) => e.text));
    return buildHandbook(store.traces(), { forgotten });
  } finally {
    store.close();
  }
}

type Scope = { name?: string; hash?: string };

/** The repository asked for (`--project`), or the one containing the current folder. */
function scope(practices: Practice[], opts: HandbookOptions): Scope {
  const known = new Map(practices.filter((p) => p.project).map((p) => [p.project!.hash, p.project!]));
  if (opts.project) {
    const hit = [...known.values()].find((p) => p.name === opts.project || p.hash === opts.project);
    if (!hit) throw new Error(`No practices for a repository named "${opts.project}". \`reflex handbook --all\` lists them.`);
    return hit;
  }
  // Sessions are keyed by the folder the agent started in; walk up so a subfolder finds its repository.
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const hit = known.get(shortHash(dir));
    if (hit) return hit;
    if (dirname(dir) === dir) return {};
  }
}

function meta(p: Practice): string {
  return `${plural(p.sessions, "session")}${p.last ? ` · last ${shortDate(p.last)}` : ""} · ${p.id}`;
}

function line(p: Practice): string {
  return `    ${p.text}${p.when ? c.cyan(` (${p.when})`) : ""}  ${c.dim(meta(p))}`;
}

function section(name: string, items: Practice[]): void {
  if (!items.length) return;
  out(c.bold(`  ${name}`));
  for (const p of items) out(line(p));
  out();
}

const json = (value: unknown) => out(JSON.stringify(value, null, 2));

export async function handbook(opts: HandbookOptions): Promise<void> {
  const all = load();
  if (opts.all) {
    if (opts.json) return json({ project: null, practices: all });
    title(`Handbook · every repository · ${plural(all.length, "practice")}`);
    const groups = new Map<string, Practice[]>();
    for (const p of all) groups.set(p.project?.name ?? "Across repositories", [...(groups.get(p.project?.name ?? "Across repositories") ?? []), p]);
    for (const [name, items] of groups) section(name, items);
    return;
  }
  const where = scope(all, opts);
  const practices = practicesFor(all, where.hash);
  if (opts.json) return json({ project: where.hash ? where : null, practices });
  title(`Handbook · ${where.name ?? "no repository matched this folder"}`);
  if (!practices.length) {
    out("Nothing learned yet. Practices come from commands that worked and corrections you repeated, in at least 2 independent sessions.");
    return;
  }
  const own = practices.filter((p) => p.project);
  section("Commands that work here", own.filter((p) => p.kind === "command"));
  section("Rules you gave agents here", own.filter((p) => p.kind === "rule"));
  section("Rules across your repositories", practices.filter((p) => !p.project));
  out(c.dim(`reflex handbook show <id> · ask "<question>" · export · --json${where.hash ? "" : " · --project <name> · --all"}`));
}

export async function handbookShow(id: string, opts: HandbookOptions): Promise<void> {
  const p = load().find((x) => x.id === id);
  if (!p) throw new Error(`No practice ${id}. \`reflex handbook\` lists them with their ids.`);
  if (opts.json) return json(p);
  title(p.text);
  if (p.when) out(`  Applies ${p.when}.`);
  out(`  ${p.project?.name ? `In ${p.project.name}` : "Across your repositories"} · ${plural(p.sessions, "independent session")}`);
  out();
  out(c.bold(`  Sessions behind it${p.sessions > p.sources.length ? ` (newest ${p.sources.length})` : ""}`));
  for (const s of p.sources) out(`  ${shortDate(s.date)}  ${(TOOL[s.tool] ?? s.tool).padEnd(11)}  ${c.dim(s.request || "(no request text)")}`);
}

export async function handbookAsk(words: string[], opts: HandbookOptions): Promise<void> {
  const question = words.join(" ").trim();
  if (!question) throw new Error('Ask a question: reflex handbook ask "how do we run tests here?"');
  const all = load();
  const where = scope(all, opts);
  const answers = askHandbook(practicesFor(all, where.hash), question, where.hash);
  if (opts.json) return json({ question, project: where.hash ? where : null, answers: answers.map((a) => ({ score: Number(a.score.toFixed(3)), ...a.practice })) });
  out();
  if (!answers.length) {
    out(`Nothing in the handbook${where.name ? ` for ${where.name}` : ""} answers that. Reflex only knows what past sessions showed.`);
    return;
  }
  for (const { practice: p } of answers) {
    out(`${c.green("›")} ${p.text}${p.when ? c.cyan(` (${p.when})`) : ""}`);
    out(c.dim(`  ${p.project?.name ? `in ${p.project.name}` : "across your repositories"} · ${meta(p)} · reflex handbook show ${p.id}`));
  }
}

/** A Markdown handbook for a teammate or new hire: practices and their evidence counts, never request text. */
export async function handbookExport(opts: HandbookOptions): Promise<void> {
  const all = load();
  const where = opts.all ? {} : scope(all, opts);
  const practices = opts.all ? all : practicesFor(all, where.hash);
  const name = opts.all ? "all repositories" : (where.name ?? "this folder");
  const entry = (p: Practice) => `- ${p.text}${p.when ? ` *(${p.when})*` : ""} · ${plural(p.sessions, "session")}${p.last ? `, last ${shortDate(p.last)}` : ""}`;
  const lines = [
    `# Handbook: ${name}`,
    "",
    `Learned by Reflex from past coding-agent sessions, ${new Date().toISOString().slice(0, 10)}. Each item held in at least 2 independent sessions; the count says how many.`,
    "",
  ];
  const groups: Array<[string, Practice[]]> = [
    ["Commands that work", practices.filter((p) => p.kind === "command")],
    ["Rules", practices.filter((p) => p.kind === "rule" && p.project)],
    ["Rules across repositories", practices.filter((p) => p.kind === "rule" && !p.project)],
  ];
  for (const [heading, items] of groups) {
    if (!items.length) continue;
    lines.push(`## ${heading}`, "");
    if (opts.all && heading !== "Rules across repositories") {
      const byRepo = new Map<string, Practice[]>();
      for (const p of items) byRepo.set(p.project?.name ?? "unnamed", [...(byRepo.get(p.project?.name ?? "unnamed") ?? []), p]);
      for (const [repo, ps] of byRepo) lines.push(`### ${repo}`, "", ...ps.map(entry), "");
    } else lines.push(...items.map(entry), "");
  }
  if (!practices.length) lines.push("Nothing learned yet.", "");
  out(lines.join("\n").trimEnd());
}
