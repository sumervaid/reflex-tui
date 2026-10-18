import { spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import {
  type ArmStats,
  type BenchResult,
  type KindGuess,
  type KindStats,
  MAX_EXPLORE,
  ROUTABLE_SOURCES,
  ROUTE_MIN_SUPPORT,
  type RouteDecision,
  type RouteRun,
  TASK_KINDS,
  benchSummary,
  chooseRoute,
  classifyRequest,
  linkRuns,
  pickArm,
  requestDocument,
  routingTable,
  trials,
  typicalCost,
} from "@reflex/analysis";
import { PRICES_CHECKED, SOURCE_LABELS, type SourceId, type WorkflowTrace, costOf, unknownModels } from "@reflex/core";
import { agentLaunch, displayPath, ensureDir } from "@reflex/safety";
import { benchTools, cloneRepo, hasUncommitted, headCommit, removeCopy, repoRoot, runClaudeBench, runUserCommand } from "@reflex/skills";
import { Store, paths } from "@reflex/storage";
import { requestVectors } from "../embeddings";
import { c, chooseKey, confirm, interactive, ok, out, plural, rows, spinner, title, warn } from "../ui";

type Routable = "claude-code" | "codex";
const CLI: Record<Routable, string> = { "claude-code": "claude", codex: "codex" };
/** Model names Reflex passes to an agent's `--model`: what transcripts record, nothing a shell would read. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const CODEX_MODEL = /^(gpt|o\d|codex)/i;

const onPath = (cmd: string): boolean => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, cmd)));
const unique = (traces: WorkflowTrace[]): WorkflowTrace[] => [...new Map(traces.map((t) => [t.sessionId, t])).values()];
const usd = (n: number | undefined): string => (n === undefined ? "—" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const fixes = (f: number): string => `${f.toFixed(2)} fixes/request`;
const label = (s: SourceId): string => SOURCE_LABELS[s];

function describeGuess(g: KindGuess): string {
  if (!g.kind) return c.dim("unknown: no similar past session and no telling words");
  if (g.via === "words") return `${g.kind.name} ${c.dim("(guessed from your words: no similar past session)")}`;
  return `${g.kind.name} ${c.dim(`(${plural(g.neighbors, "similar past session")}, ${Math.round(g.confidence * 100)}% agree)`)}`;
}

function describeMode(d: RouteDecision, settings: { explore: number }): string {
  switch (d.mode) {
    case "pick":
      return `the router's pick: the cheapest model that needed fixing about as rarely as the most reliable one`;
    case "learning":
      return `still learning: the model with the most sessions of this kind (cheapest on a tie); models need ${ROUTE_MIN_SUPPORT}+ sessions before they can be compared`;
    case "explore":
      return `exploring (${Math.round(settings.explore * 100)}% of runs, chosen at random): trying a model you have used least on this kind of task, so the comparison is fair`;
    default:
      return `no priced sessions of this kind yet, so the tool's own default model`;
  }
}

function armLine(a: ArmStats, picked: boolean): string {
  const tag = picked ? c.green(" ← pick") : a.sessions < ROUTE_MIN_SUPPORT ? c.dim(" (too few sessions)") : "";
  return `${a.model.padEnd(26)} ${c.dim(label(a.source).padEnd(12))} ${plural(a.sessions, "session").padEnd(12)} ${usd(a.usd).padStart(7)}  ${c.dim(fixes(a.friction))}${tag}`;
}

function availableSources(tool?: SourceId): Routable[] {
  if (tool && !ROUTABLE_SOURCES.includes(tool)) throw new Error(`${label(tool)} can't be routed: it records no tokens to compare and its editor takes no model from outside.`);
  const wanted = (tool ? [tool] : ROUTABLE_SOURCES) as Routable[];
  const found = wanted.filter((s) => onPath(CLI[s]));
  if (!found.length) throw new Error(tool ? `The \`${CLI[tool as Routable]}\` command was not found on PATH.` : "Neither `claude` nor `codex` was found on PATH.");
  return found;
}

export type RunOptions = { tool?: SourceId; model?: string; dryRun?: boolean; yes?: boolean; ask?: boolean };

/** "about $0.41 a session": what this model usually costs you here, from history only. */
function costHint(d: RouteDecision, table: KindStats[]): string {
  if (!d.model) return "";
  const here = d.arms.find((a) => a.source === d.source && a.model === d.model);
  if (here) return c.dim(` · about ${usd(here.usd)} a session on this kind of task`);
  const any = typicalCost(table, d.source, d.model);
  return any ? c.dim(` · about ${usd(any.usd)} a session across your tasks`) : "";
}

/** One keypress after the agent exits; Enter skips, so nothing is recorded by accident. */
async function askOutcome(runId: number): Promise<void> {
  const answer = await chooseKey("Did it get the job done?", [
    { value: "s", label: "skip" },
    { value: "y", label: "yes" },
    { value: "n", label: "no" },
  ]);
  if (answer !== "y" && answer !== "n") return;
  const store = new Store();
  try {
    store.setRouteRunOutcome(runId, answer === "y" ? "done" : "not-done");
  } finally {
    store.close();
  }
}

/** `reflex run <request>`: classify the request, pick the tool and model, and start the agent on it. */
export async function runRouted(words: string[], opts: RunOptions): Promise<void> {
  const request = words.join(" ").trim();
  if (!request) throw new Error("Say what the task is: reflex run \"fix the failing CI job\"");
  if (opts.model && !MODEL_NAME.test(opts.model)) throw new Error("That model name has characters Reflex won't pass to an agent.");
  const store = new Store();
  let run: RouteRun | undefined;
  let runId = 0;
  try {
    const tool = opts.tool ?? (opts.model ? (CODEX_MODEL.test(opts.model) ? "codex" : "claude-code") : undefined);
    const sources = availableSources(tool);
    const traces = unique(store.traces());
    const settings = store.routerSettings();
    const meaning = await requestVectors(requestDocument(request), traces, store);
    const guess = classifyRequest(request, traces, meaning ?? {});
    const table = routingTable(traces);
    let decision = chooseRoute(guess, table, { sources, settings, random: () => randomInt(1_000_000) / 1_000_000 });
    if (opts.model) decision = { ...decision, source: sources[0]!, model: opts.model, randomized: false };

    title("Reflex run");
    rows([
      ["Task", describeGuess(guess)],
      ["Start", `${c.bold(label(decision.source))} on ${c.bold(decision.model ?? "its default model")}${costHint(decision, table)}`],
      ["Why", opts.model ? "you named the model" : describeMode(decision, settings)],
    ]);
    if (!store.latestScan()) out(c.dim("\n  No scan yet: run `reflex scan` so the router can learn from your history."));
    if (decision.arms.length) {
      out();
      out(c.dim(`  Your sessions of this kind (average per session, at API list prices of ${PRICES_CHECKED}):`));
      for (const a of decision.arms.slice(0, 5)) out(`    ${armLine(a, a === decision.pick && decision.mode !== "default")}`);
    }
    out();
    if (opts.dryRun) return;
    const go = settings.autopilot && !opts.model ? (out(c.dim("  Autopilot is on: starting without asking.")), true) : await confirm(`Start ${label(decision.source)} on ${decision.model ?? "its default model"}?`, opts);
    if (!go) return;
    const nativeId = decision.source === "claude-code" ? randomUUID() : undefined;
    run = {
      at: new Date().toISOString(),
      source: decision.source,
      model: decision.model,
      kind: guess.kind?.key,
      mode: opts.model ? "manual" : decision.mode,
      randomized: decision.randomized,
      nativeId,
      project: basename(process.cwd()),
    };
    runId = store.saveRouteRun(run);
  } finally {
    store.close();
  }
  if (!run) return;
  const model = run.model ? ["--model", run.model] : [];
  const args = run.source === "claude-code" ? [...model, "--session-id", run.nativeId!, request] : [...model, request];
  const launch = agentLaunch(CLI[run.source as Routable], args);
  const res = spawnSync(launch.command, launch.args, { stdio: "inherit", windowsVerbatimArguments: launch.windowsVerbatimArguments });
  if (res.error) throw new Error(`Could not start ${CLI[run.source as Routable]}: ${res.error.message}`);
  process.exitCode = res.status ?? 0;
  if (opts.ask !== false && interactive()) await askOutcome(runId);
}

/** `reflex route`: the router's picks, settings, randomized trials and bench results. */
export async function routeStatus(): Promise<void> {
  const store = new Store();
  try {
    const settings = store.routerSettings();
    const traces = unique(store.traces());
    const table = routingTable(traces);
    title("Router");
    rows([
      ["Autopilot", settings.autopilot ? `${c.green("on")} ${c.dim("· reflex run starts on the pick without asking")}` : `off ${c.dim("· reflex run asks first · reflex route autopilot on")}`],
      [
        "Exploration",
        settings.explore
          ? `${c.green(`${Math.round(settings.explore * 100)}% of runs`)}${settings.protect.length ? c.dim(` · never on ${settings.protect.join(", ")}`) : ""}`
          : `off ${c.dim("· reflex route explore 10 tries another model on 10% of runs, at random")}`,
      ],
    ]);
    out();
    if (!table.length) {
      out(c.dim("  No priced Claude Code or Codex sessions in the last scan. Run `reflex scan` first; Cursor records no tokens."));
      out();
    }
    for (const k of table) {
      const p = pickArm(k.arms);
      const verdict = p.learning ? c.dim("LEARNING") : p.arm === k.arms[0] ? "KEEP" : c.green("SWITCH");
      out(`${c.bold(k.kind.name)} ${c.dim(`· ${plural(k.sessions, "session")}`)}  ${verdict}`);
      for (const a of k.arms.slice(0, 5)) out(`  ${armLine(a, a === p.arm && !p.learning)}`);
      out();
    }

    const runs = store.routeRuns();
    const linked = linkRuns(runs, traces);
    const tr = trials(linked);
    out(c.bold("Randomized trials"));
    if (!tr.length) out(c.dim(`  none yet${runs.length ? ` (${plural(runs.length, "routed run")}, none with exploration on)` : ""}. Turn on exploration, then use reflex run.`));
    for (const t of tr) {
      out(`  ${t.kind.name} ${c.dim(`· ${plural(t.runs, "run")}`)}`);
      for (const a of t.arms) {
        const measured = a.measured ? `${usd(a.usd).padStart(7)}  ${c.dim(fixes(a.friction!))}` : c.dim("not scanned yet");
        const answered = a.rated ? `  ${a.done}/${a.rated} got it done` : c.dim("  no answers yet");
        out(`    ${a.model.padEnd(26)} ${(a.explored ? "explored" : "picked").padEnd(9)} ${plural(a.runs, "run").padEnd(8)} ${measured}${answered}`);
      }
    }
    out();
    const bench = benchSummary(store.benchResults());
    out(c.bold("Bench"));
    if (!bench.length) out(c.dim('  none yet. reflex bench "<task>" --models a b --check "<test command>"'));
    for (const b of bench) {
      out(`  ${b.kind?.name ?? "Unclassified"} ${c.dim(`· ${plural(b.batches, "task")}`)}`);
      for (const a of b.arms) out(`    ${a.model.padEnd(26)} ${`${a.passed}/${a.runs} passed`.padEnd(12)} ${usd(a.usd).padStart(7)}  ${c.dim(`${Math.round(a.durationMs / 1000)}s`)}`);
    }
    out();
    out(c.dim(`Costs are API list prices of ${PRICES_CHECKED} for whole sessions. Trials compare only runs where the exploration coin`));
    out(c.dim("was flipped, so both sides saw the same mix of tasks. Small samples are noisy: this shows what happened, it does not predict."));
    const unknown = unknownModels(traces.map((t) => t.usageByModel));
    if (unknown.length) {
      const list = unknown.map((m) => `${m.model} (${plural(m.sessions, "session")})`).join(", ");
      warn(`Unknown model, left out of every cost above: ${list}. Add its price in ~/.reflex/prices.json.`);
    }
  } finally {
    store.close();
  }
}

export async function routeAutopilot(state: string): Promise<void> {
  if (state !== "on" && state !== "off") throw new Error("Use: reflex route autopilot on|off");
  const store = new Store();
  try {
    store.setRouterSettings({ ...store.routerSettings(), autopilot: state === "on" });
    if (state === "on") ok("Autopilot on: `reflex run` starts on the router's pick without asking. Nothing else changes.");
    else ok("Autopilot off: `reflex run` shows the pick and asks first.");
  } finally {
    store.close();
  }
}

export async function routeExplore(value: string, opts: { protect?: string[] }): Promise<void> {
  const off = value === "off" || value === "0";
  const percent = Number(value.replace(/%$/, ""));
  if (!off && (!Number.isFinite(percent) || percent <= 0 || percent > MAX_EXPLORE * 100))
    throw new Error(`Use a percentage from 1 to ${MAX_EXPLORE * 100}, or off: reflex route explore 10`);
  const keys = TASK_KINDS.map((k) => k.key);
  const bad = (opts.protect ?? []).filter((k) => !keys.includes(k));
  if (bad.length) throw new Error(`Unknown kind of task: ${bad.join(", ")}. Kinds: ${keys.join(", ")}`);
  const store = new Store();
  try {
    const s = store.routerSettings();
    store.setRouterSettings({ ...s, explore: off ? 0 : percent / 100, protect: opts.protect ?? s.protect });
    if (off) ok("Exploration off: reflex run always uses the pick.");
    else {
      ok(`Exploration on: about ${percent}% of reflex runs, chosen at random, try another model you already use with that tool.`);
      const p = opts.protect ?? s.protect;
      out(c.dim(`  ${p.length ? `Never on: ${p.join(", ")}.` : "Protect kinds of task you never want explored with --protect review ci."} \`reflex route\` shows the results.`));
    }
  } finally {
    store.close();
  }
}

export type BenchOptions = { models: string[]; check: string; setup?: string; runs: string; timeout: string; keep?: boolean; yes?: boolean };

/** `reflex bench <task>`: the same task, models side by side, each in a fresh copy of the repository, scored by your check. */
export async function bench(words: string[], opts: BenchOptions): Promise<void> {
  const task = words.join(" ").trim();
  if (!task) throw new Error('Say what the task is: reflex bench "make the date parser accept ISO weeks" --models sonnet opus --check "pnpm test"');
  const models = [...new Set(opts.models)];
  for (const m of models) {
    if (!MODEL_NAME.test(m)) throw new Error(`"${m.slice(0, 40)}" is not a model name Reflex will pass to an agent.`);
    if (CODEX_MODEL.test(m)) throw new Error(`Bench runs Claude Code models only for now; "${m}" looks like a Codex model.`);
  }
  if (!models.length) throw new Error("Name at least one model: --models sonnet opus");
  const runs = Number(opts.runs);
  const minutes = Number(opts.timeout);
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error("--runs must be a whole number from 1 to 10.");
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error("--timeout is minutes per run, from 1 to 120.");
  if (!opts.check.trim()) throw new Error('--check needs the command that decides pass or fail, e.g. --check "pnpm test"');
  if (!onPath("claude")) throw new Error("The `claude` CLI was not found on PATH.");
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("Run reflex bench inside a git repository: each run starts from a fresh copy of it.");

  const store = new Store();
  try {
    const traces = unique(store.traces());
    const kind = classifyRequest(task, traces).kind;
    const { tools, agentCanRunCheck } = benchTools(opts.check);
    const benchRoot = join(paths.home(), "bench");
    const total = runs * models.length;
    const table = routingTable(traces);
    const typical = models.map((m) => ({ m, cost: typicalCost(table, "claude-code", m) }));
    const known = typical.filter((x) => x.cost);
    const estimate = known.reduce((a, x) => a + x.cost!.usd * runs, 0);
    const unknown = typical.filter((x) => !x.cost).map((x) => x.m);
    title("Reflex bench");
    rows([
      ["Repository", `${displayPath(root)} ${c.dim(`at ${headCommit(root) ?? "HEAD"}, committed state only`)}`],
      ["Task kind", kind?.name ?? c.dim("unclassified")],
      ["Models", models.join(", ")],
      ["Runs", `${plural(total, "run")} ${c.dim(`(${runs} per model, ${minutes} min limit each)`)}`],
      ["Setup", opts.setup ? `\`${opts.setup}\` in each copy` : c.dim("none")],
      ["Pass when", `\`${opts.check}\` exits 0 in the copy after the agent finishes`],
      ["Copies", `${displayPath(benchRoot)} ${c.dim(opts.keep ? "(kept)" : "(deleted after each run)")}`],
      [
        "Estimated cost",
        known.length
          ? `about ${usd(estimate)} ${c.dim(`(your average session on each model at API list prices of ${PRICES_CHECKED}; this task may differ)`)}`
          : c.dim("unknown: no sessions on these models in the last scan"),
      ],
    ]);
    if (unknown.length && known.length) out(c.dim(`  No history for ${unknown.join(", ")}, so it is not in the estimate.`));
    out();
    if (hasUncommitted(root)) warn("This repository has uncommitted changes; copies start from the last commit without them.");
    if (!agentCanRunCheck) warn("The check has shell syntax, so the agent can't run it itself; Reflex still runs it to score each copy.");
    out(c.dim("  Each run is a full non-persistent Claude Code session on your account: project settings only, no MCP servers,"));
    out(c.dim(`  edits accepted, Bash limited to git status/diff/log, ls and the check. It uses tokens or plan limits ${plural(total, "time")}.`));
    out(c.dim("  Your repository is only read: copies are separate clones with no remote, so nothing is pushed back."));
    out();
    if (!(await confirm(`Start ${plural(total, "run")}?`, opts))) return;

    await ensureDir(paths.home(), 0o700);
    await ensureDir(benchRoot, 0o700);
    const batch = randomUUID().slice(0, 8);
    const timeoutMs = minutes * 60_000;

    const baseline = join(benchRoot, `${batch}-before`);
    cloneRepo(root, baseline);
    try {
      if (opts.setup && !runUserCommand(baseline, opts.setup, timeoutMs)) throw new Error(`The setup command failed in a fresh copy: \`${opts.setup}\`. Fix it, then run bench again.`);
      if (runUserCommand(baseline, opts.check, timeoutMs))
        warn("The check already passes before any change, so pass/fail can't tell the models apart. Cost and time still compare.");
    } finally {
      await removeCopy(benchRoot, baseline);
    }

    const results: BenchResult[] = [];
    for (let i = 0; i < runs; i++) {
      // Rotate the order so no model always goes first.
      const order = models.map((_, j) => models[(i + j) % models.length]!);
      for (const model of order) {
        const dir = join(benchRoot, `${batch}-${model.replace(/[^A-Za-z0-9.-]/g, "_")}-${i + 1}`);
        cloneRepo(root, dir);
        const spin = spinner();
        try {
          if (opts.setup && !runUserCommand(dir, opts.setup, timeoutMs)) throw new Error(`The setup command failed in a fresh copy: \`${opts.setup}\`.`);
          spin.start(`${model} · run ${i + 1} of ${runs} · working…`);
          const r = await runClaudeBench(dir, task, model, tools, timeoutMs);
          const pass = !r.timedOut && runUserCommand(dir, opts.check, timeoutMs);
          const listed = r.usage ? costOf({ [model]: r.usage }).cost?.usd : undefined;
          const result: BenchResult = {
            at: new Date().toISOString(),
            batch,
            source: "claude-code",
            model,
            kind: kind?.key,
            project: basename(root),
            pass,
            usd: listed ?? r.reportedUsd,
            turns: r.turns,
            durationMs: r.durationMs,
            timedOut: r.timedOut,
          };
          store.saveBenchResult(result);
          results.push(result);
          spin.stop(
            `${model} · run ${i + 1}: ${pass ? c.green("passed") : c.red(r.timedOut ? "timed out" : "failed")} · ${usd(result.usd)} · ${Math.round(r.durationMs / 1000)}s${r.turns ? ` · ${plural(r.turns, "turn")}` : ""}`,
          );
        } catch (e) {
          spin.stop(`${model} · run ${i + 1}: could not run`);
          throw e;
        } finally {
          if (!opts.keep) await removeCopy(benchRoot, dir);
        }
      }
    }
    out();
    for (const b of benchSummary(results))
      for (const a of b.arms) out(`  ${a.model.padEnd(26)} ${`${a.passed}/${a.runs} passed`.padEnd(12)} ${usd(a.usd).padStart(7)}  ${c.dim(`${Math.round(a.durationMs / 1000)}s average`)}`);
    out();
    out(c.dim("Saved. `reflex route` shows bench results next to the router's picks."));
  } finally {
    store.close();
  }
}
