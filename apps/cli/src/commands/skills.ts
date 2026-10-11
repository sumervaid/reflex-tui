import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SOURCE_LABELS } from "@reflex/core";
import { assertSlug, displayPath, isValidSlug, pathExists } from "@reflex/safety";
import { Store, paths } from "@reflex/storage";
import {
  FIX_CI_TASK,
  type InstallTarget,
  type Provenance,
  type TargetId,
  checkSkill,
  createFixCiSandbox,
  detectTargets,
  install,
  lineDiff,
  planInstall,
  renameSkill,
  runClaudeInSandbox,
} from "@reflex/skills";
import { ask, c, choose, chooseMany, confirm, fail, fileBlock, interactive, ok, out, pct, plural, rows, shortDate, spinner, title, warn } from "../ui";

async function readReflexSkill(name: string): Promise<{ path: string; content: string }> {
  assertSlug(name);
  const path = join(paths.skills(), name, "SKILL.md");
  if (!(await pathExists(path))) throw new Error(`No generated skill "${name}". Approve a suggestion first (\`reflex suggest\`).`);
  return { path, content: await readFile(path, "utf8") };
}

async function readProvenance(name: string): Promise<Provenance | undefined> {
  try {
    return JSON.parse(await readFile(join(paths.skills(), name, "provenance.json"), "utf8")) as Provenance;
  } catch {
    return undefined;
  }
}

export type InstallOptions = { target?: TargetId[]; as?: string; yes?: boolean };

/** Install a generated skill. Each target needs its own explicit consent; nothing is overwritten. */
export async function installFlow(store: Store, name: string, opts: InstallOptions): Promise<void> {
  const { content } = await readReflexSkill(name);
  const check = checkSkill(content, name);
  if (!check.ok) throw new Error(`Skill ${name} failed validation: ${check.errors.join("; ")}`);

  const targets = (await detectTargets()).filter((t) => t.detected);
  if (!targets.length) {
    warn("None of Claude Code (~/.claude), Codex (~/.codex) or Cursor (~/.cursor) was found on this machine. Nothing to install into.");
    return;
  }
  let chosen: InstallTarget[];
  if (opts.target?.length) {
    chosen = targets.filter((t) => opts.target!.includes(t.id));
    if (!chosen.length) throw new Error(`Target not available. Detected: ${targets.map((t) => t.id).join(", ")}`);
  } else if (interactive()) {
    const ids = await chooseMany(
      "Install into:",
      targets.map((t) => ({ value: t.id, label: t.label, hint: displayPath(join(t.skillsDir, name)) })),
    );
    chosen = targets.filter((t) => ids.includes(t.id));
  } else {
    out(`Choose a target explicitly: ${c.cyan(`reflex install ${name} --target claude-code`)} (or codex, cursor)`);
    return;
  }
  if (!chosen.length) {
    out("No target selected. Nothing was installed.");
    return;
  }
  for (const target of chosen) await installInto(store, target, name, opts.as ?? name, content, opts);
}

async function installInto(store: Store, target: InstallTarget, source: string, name: string, content: string, opts: InstallOptions): Promise<void> {
  let installName = name;
  let body = installName === source ? content : renameSkill(content, installName);
  for (;;) {
    const plan = await planInstall(target, installName, body);
    out();
    out(`Install ${c.bold(installName)} into ${c.bold(target.label)}?`);
    rows([
      ["Destination", plan.displayDestination],
      ["Existing file", plan.existing === undefined ? "none" : plan.identical ? "identical copy already installed" : c.yellow("a different skill with this name exists")],
    ]);
    if (plan.identical) {
      ok(`Already installed and identical. Nothing to do.`);
      return;
    }
    if (plan.existing !== undefined) {
      out(`A skill named ${installName} already exists.`);
      const choice = await choose("What should Reflex do?", [
        { value: "diff", label: "[D] Diff", hint: "show what would change" },
        { value: "rename", label: "[R] Rename", hint: "install under a different name" },
        { value: "cancel", label: "[C] Cancel" },
      ]);
      if (choice === "diff") {
        out(lineDiff(plan.existing, body));
        continue;
      }
      if (choice === "rename") {
        const next = await ask("New skill name", `${installName}-2`, (v) => (isValidSlug(v) ? undefined : "lowercase letters, digits and single hyphens"));
        if (!next) return;
        installName = next;
        body = renameSkill(content, installName);
        continue;
      }
      out("Cancelled. The existing skill was not touched.");
      return;
    }
    if (!(await confirm(`Write ${plan.displayDestination}?`, opts))) {
      out(`Skipped ${target.label}. Nothing was written.`);
      return;
    }
    const res = await install(plan, body);
    store.saveInstallation({ skill: source, target: target.id, path: res.path, installedAt: new Date().toISOString(), contentHash: res.contentHash });
    ok(`Installed ${installName} into ${target.label}: ${displayPath(res.path)}`);
    out(c.dim(`  Open a new ${target.label} session; the skill is picked up at session start.`));
    return;
  }
}

export async function installCommand(name: string, opts: InstallOptions): Promise<void> {
  const store = new Store();
  try {
    await installFlow(store, name, opts);
  } finally {
    store.close();
  }
}

export async function listSkills(): Promise<void> {
  const store = new Store();
  try {
    const skills = store.skills();
    if (!skills.length) {
      out("No generated skills yet. Approve a suggestion with `reflex suggest`.");
      return;
    }
    title(`${plural(skills.length, "skill")} generated by Reflex`);
    for (const s of skills) {
      const installs = store.installations(s.name);
      const where = installs.length ? installs.map((i) => SOURCE_LABELS[i.target as TargetId] ?? i.target).join(", ") : c.dim("not installed");
      out(`  ${c.bold(s.name.padEnd(20))} ${shortDate(s.createdAt)}  ${where}`);
      out(c.dim(`  ${" ".repeat(20)} ${displayPath(s.path)}`));
    }
    out();
  } finally {
    store.close();
  }
}

export async function showSkill(name: string): Promise<void> {
  const { path, content } = await readReflexSkill(name);
  out();
  fileBlock(displayPath(path), content);
  out();
}

export async function explain(name: string): Promise<void> {
  const { path } = await readReflexSkill(name);
  const prov = await readProvenance(name);
  if (!prov) throw new Error(`No provenance recorded for ${name}.`);
  const store = new Store();
  try {
    const suggestion = store.findSuggestion(prov.suggestion)?.data;
    title(`${name} exists because:`);
    rows([
      ["Independent sessions", `${prov.independentSessions} ${c.dim(`(${plural(prov.records, "history record")} before de-duplication)`)}`],
      ["Repositories", suggestion ? `${prov.repositories} · ${suggestion.repositories.join(", ")}` : String(prov.repositories)],
      ["Agents", Object.entries(prov.sources).map(([k, n]) => `${SOURCE_LABELS[k as TargetId] ?? k} ${n}`).join(", ")],
      ["Confidence", `${pct(prov.confidence)} ${c.dim("ranking heuristic")}`],
      ["First observed", prov.firstObserved ?? "unknown"],
      ["Most recent", prov.lastObserved ?? "unknown"],
      ["Approved", shortDate(prov.createdAt)],
    ]);
    if (suggestion) {
      out();
      out("  Steps and how many sessions showed them");
      suggestion.steps.forEach((st, i) => out(`    ${i + 1}. ${st.label.padEnd(30)} ${c.dim(`${Math.round(st.support * suggestion.instances)}/${suggestion.instances}`)}`));
      out();
      out("  Supporting sessions (local references only)");
      for (const e of suggestion.evidence) out(`    ${c.dim(shortDate(e.date))}  ${(e.project ?? "?").padEnd(14)} ${SOURCE_LABELS[e.source].padEnd(12)} ${c.dim(e.sessionId.slice(0, 24))}`);
    } else {
      out();
      out(c.dim("  The suggestion is not in the current scan; showing stored provenance only."));
      for (const ref of prov.sourceSessions) out(`    ${c.dim(ref)}`);
    }
    out();
    const installs = store.installations(name);
    out("  Installed");
    if (!installs.length) out(c.dim("    nowhere yet"));
    for (const i of installs) out(`    ${(SOURCE_LABELS[i.target as TargetId] ?? i.target).padEnd(12)} ${displayPath(i.path)} ${c.dim(shortDate(i.installedAt))}`);
    out();
    out(c.dim(`  Skill file: ${displayPath(path)} · the skill stores no transcript excerpts.`));
    out();
  } finally {
    store.close();
  }
}

export async function validate(name: string, opts: { run?: boolean; yes?: boolean }): Promise<void> {
  const { path, content } = await readReflexSkill(name);
  title(`Validating ${name}`);

  const check = checkSkill(content, name);
  out("Static checks");
  out(`  ${check.ok ? c.green("✔") : c.red("✖")} ${displayPath(path)}  ${c.dim(`${check.lines} lines · ${check.steps} steps`)}`);
  for (const e of check.errors) out(c.red(`      ${e}`));
  for (const w of check.warnings) out(c.yellow(`      ${w}`));

  out();
  out("Installed copies");
  let anyInstalled = false;
  for (const t of await detectTargets()) {
    const file = join(t.skillsDir, name, "SKILL.md");
    if (!(await pathExists(file))) {
      out(c.dim(`  · ${t.label.padEnd(12)} not installed`));
      continue;
    }
    anyInstalled = true;
    const installed = await readFile(file, "utf8");
    const same = installed === content;
    const ic = checkSkill(installed, name);
    out(`  ${ic.ok ? c.green("✔") : c.red("✖")} ${t.label.padEnd(12)} ${displayPath(file)} ${c.dim(same ? "identical to Reflex copy" : "differs from Reflex copy")}`);
  }
  if (!anyInstalled) out(c.dim(`  Install with: reflex install ${name}`));

  out();
  out("Fresh-task check");
  if (name !== "fix-ci" && !name.startsWith("fix-ci-")) {
    out("  Open a new Claude Code, Codex or Cursor agent session in a repository where this workflow applies and give it a matching task.");
    out("  In Claude Code, the transcript shows Skill(" + name + ") when the skill is used.");
    return;
  }

  const sandbox = await createFixCiSandbox(join(paths.home(), "validation"), name, content);
  out(`  Created a fresh repository with a CI failure none of the historical sessions saw:`);
  out(`    ${displayPath(sandbox.dir)}`);
  out(c.dim("  The skill is installed project-locally there (.claude/skills), so your own config is untouched."));
  out();
  out("  Manual check:");
  out(`    cd ${displayPath(sandbox.dir)} && claude`);
  out(`    > ${FIX_CI_TASK}`);
  out();

  if (!opts.run) {
    out(c.dim(`  Or let Reflex run it: reflex validate ${name} --run`));
    return;
  }
  if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) {
    fail("The `claude` CLI was not found on PATH.");
    return;
  }
  out("  Reflex will start a non-persistent Claude Code session in that folder with the fixed prompt above,");
  out("  restricted tools (read, edit, npm test, git status/diff/log) and project-only settings. It uses your Claude account.");
  if (!(await confirm("Run the fresh session now?", opts))) return;

  const spin = spinner();
  spin.start("Claude Code is working on the fresh task…");
  const run = await runClaudeInSandbox(sandbox, name);
  spin.stop(run.timedOut ? "Timed out." : "Session finished.");
  out();
  rows([
    ["Skill invoked", run.skillUsed ? c.green(`yes · Skill(${name})`) : c.yellow("no")],
    ["Commands run", run.commands.length ? run.commands.slice(0, 8).join(c.dim(" → ")) : "none"],
    ["Files edited", run.editedFiles.join(", ") || "none"],
    ["Tests now pass", run.testsPass ? c.green("yes (node --test)") : c.red("no")],
  ]);
  if (run.finalMessage) {
    out();
    out(c.dim("  Final message:"));
    for (const line of run.finalMessage.split("\n").slice(0, 14)) out(c.dim(`    ${line}`));
  }
  out();
  if (run.skillUsed && run.testsPass) ok(`${name} worked on a new task.`);
  else warn("The fresh session did not both use the skill and fix the task. See the output above.");
}
