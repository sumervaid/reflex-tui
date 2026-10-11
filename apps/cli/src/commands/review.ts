import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_LABELS, sha256 } from "@reflex/core";
import { analyze, type Suggestion } from "@reflex/analysis";
import { displayPath, excerpt, pathExists } from "@reflex/safety";
import { type StoredSuggestion, Store, paths } from "@reflex/storage";
import { generateSkill, storeGenerated } from "@reflex/skills";
import { c, chooseKey, confirm, fileBlock, interactive, ok, out, pct, plural, rows, shortDate, title } from "../ui";
import { installFlow } from "./skills";

const sourceSummary = (s: Suggestion) =>
  Object.entries(s.sources)
    .map(([k, n]) => `${SOURCE_LABELS[k as keyof typeof SOURCE_LABELS] ?? k} ${n}`)
    .join(", ");

export function renderSuggestion(entry: StoredSuggestion): void {
  const s = entry.data;
  const status = entry.status === "pending" ? "" : c.dim(` · ${entry.status}`);
  out(c.dim(`Suggested workflow #${entry.rank} · ${s.slug}`) + status);
  out();
  out(`  ${c.bold(s.title)}`);
  out();
  rows(
    [
      ["Observed", `${plural(s.instances, "independent session")} · ${plural(s.repositories.length, "repository", "repositories")} · ${sourceSummary(s)}`],
      ["Consolidated", `${plural(s.records, "history record")} (copies, resumes and retries counted once)`],
      ["Confidence", `${c.bold(pct(s.confidence))} ${c.dim("ranking heuristic, not a probability")}`],
      ["Window", `${shortDate(s.firstSeen)} → ${shortDate(s.lastSeen)}`],
    ],
    2,
  );
  out();
  out("  Typical workflow");
  const width = Math.max(...s.steps.map((st) => st.label.length));
  s.steps.forEach((st, i) => {
    const seen = Math.round(st.support * s.instances);
    const variants = st.variants ? c.dim(`  ${st.variants.join(" · ")}`) : "";
    out(`    ${String(i + 1).padStart(2)}. ${st.label.padEnd(width)}  ${c.dim(`${seen}/${s.instances}`)}${variants}`);
  });
  if (s.notes.length) {
    out();
    out("  Uncertainty");
    for (const n of s.notes) out(c.dim(`    · ${n}`));
  }
  out();
}

export function renderEvidence(s: Suggestion): void {
  title(`Evidence for ${s.slug} · ${plural(s.instances, "independent session")}`);
  out(c.dim("Excerpts are redacted and truncated. Raw transcripts never leave their original files."));
  out();
  for (const e of s.evidence) {
    const agent = SOURCE_LABELS[e.source];
    out(`${c.bold(shortDate(e.date))} · ${e.project ?? "unknown project"} · ${c.dim(agent)}`);
    out(`  "${excerpt(e.excerpt, 170)}"`);
    out(`  ${c.dim("Actions:")} ${e.actions.slice(0, 8).join(c.dim(" → "))}`);
    const outcome = e.verified ? c.green("checks passed after the change") : c.yellow("no passing check observed");
    const dupes = e.duplicates ? c.dim(` · ${plural(e.duplicates, "duplicate record")} folded in`) : "";
    out(`  ${c.dim("Outcome:")} ${outcome}${dupes}`);
    out(`  ${c.dim("Source:")}  ${c.dim(e.sourceFile)}`);
    out();
  }
}

export function renderShow(entry: StoredSuggestion): void {
  renderSuggestion(entry);
  const s = entry.data;
  out("  What the skill would contain");
  out(c.dim(`    ${s.description}`));
  out(c.dim(`    ${s.whenToUse}`));
  out();
  s.steps.forEach((st, i) => {
    out(`    ${i + 1}. ${st.instruction}`);
    if (st.examples.length) out(c.dim(`       seen: ${st.examples.join(", ")}`));
  });
  out();
  out("  Completion criteria");
  for (const cc of s.completion) out(`    - ${cc}`);
  out();
  rows(
    [
      ["Common request terms", s.topTerms.join(", ") || "none"],
      ["Cluster cohesion", `${pct(s.cohesion)} mean hybrid similarity between sessions`],
      ["Verified outcomes", `${pct(s.verifiedRate)} of sessions ended with a passing check`],
      ["Median session length", s.medianMinutes ? `${Math.round(s.medianMinutes)} min (from transcript timestamps)` : "unknown"],
    ],
    2,
  );
  out();
}

function requireScan(store: Store): void {
  if (!store.latestScan()) throw new Error("No scan yet. Run `reflex scan --days 7` first.");
}

function findOrThrow(store: Store, ref: string): StoredSuggestion {
  const s = store.findSuggestion(ref);
  if (!s) throw new Error(`No suggestion "${ref.slice(0, 40)}". Run \`reflex suggest\` to list them.`);
  return s;
}

export async function suggest(opts: { all?: boolean; interactive?: boolean }): Promise<void> {
  const store = new Store();
  try {
    requireScan(store);
    const traces = store.traces();
    const analysis = analyze(traces);
    store.saveSuggestions(store.latestScan()!.id, analysis.suggestions);
    const list = store.suggestions();
    const visible = list.filter((s) => opts.all || s.status !== "rejected");

    if (!list.length) {
      title("No repeated workflows found");
      out(`Reflex looked at ${plural(traces.length, "session")} and found no behavior repeated in at least 3 independent sessions.`);
      out("It does not manufacture suggestions from one-off tasks.");
      out();
      out(`Try a longer history window: ${c.cyan("reflex scan --days 30")}`);
      return;
    }

    title(`${plural(visible.length, "repeated workflow")} found in ${plural(traces.length, "session")}`);
    for (const entry of visible) renderSuggestion(entry);
    const hidden = list.length - visible.length;
    if (hidden) out(c.dim(`${plural(hidden, "rejected suggestion")} hidden (use --all to show).`));

    const pending = visible.filter((s) => s.status === "pending");
    if (opts.interactive === false || !interactive() || !pending.length) {
      out(`Review: ${c.cyan("reflex evidence 1")} · ${c.cyan("reflex approve 1")} · ${c.cyan("reflex reject 1")}`);
      return;
    }
    for (const entry of pending) {
      const done = await reviewLoop(store, entry);
      if (done === "quit") break;
    }
  } finally {
    store.close();
  }
}

async function reviewLoop(store: Store, entry: StoredSuggestion): Promise<"next" | "quit"> {
  for (;;) {
    const action = await chooseKey(`#${entry.rank} ${entry.data.title}`, [
      { value: "a", label: "Approve", hint: "generate a skill in ~/.reflex/skills" },
      { value: "e", label: "Evidence", hint: "show the sessions behind this" },
      { value: "r", label: "Reject", hint: "don't suggest this again" },
      { value: "s", label: "Skip for now" },
      { value: "q", label: "Quit" },
    ]);
    if (!action || action === "q") return "quit";
    if (action === "s") return "next";
    if (action === "e") {
      renderEvidence(entry.data);
      continue;
    }
    if (action === "r") {
      store.setStatus(entry.slug, "rejected");
      ok(`Rejected ${entry.slug}. It won't be suggested again unless you run \`reflex suggest --all\`.`);
      return "next";
    }
    await approveEntry(store, entry, {});
    return "next";
  }
}

export async function approveEntry(store: Store, entry: StoredSuggestion, opts: { yes?: boolean; noInstall?: boolean }): Promise<void> {
  const skill = generateSkill(entry.data);
  const dir = join(paths.skills(), skill.name);
  const file = join(dir, "SKILL.md");
  const previous = store.skill(skill.name);
  if (await pathExists(file)) {
    const current = await readFile(file, "utf8");
    const editedByUser = !previous || previous.contentHash !== sha256(current);
    if (editedByUser && !(await confirm(`${displayPath(file)} was edited after Reflex generated it. Replace it with a fresh version?`, opts))) {
      out("Kept the existing file. Nothing was changed.");
      return;
    }
  }
  const path = await storeGenerated(paths.skills(), skill.name, skill.content, JSON.stringify(skill.provenance, null, 2) + "\n");
  store.saveSkill({ name: skill.name, suggestionSlug: entry.slug, path, createdAt: skill.provenance.createdAt, contentHash: skill.contentHash });
  store.setStatus(entry.slug, "approved");

  out();
  ok(`Approved. Generated ${c.bold(displayPath(path))} ${c.dim(`(${skill.content.trimEnd().split("\n").length} lines)`)}`);
  out(c.dim("Generation only writes to Reflex's own folder. Nothing was installed into Claude Code, Codex or Cursor."));
  out();
  fileBlock(displayPath(path), skill.content);
  out();
  if (opts.noInstall) return;
  if (interactive() && !opts.yes) await installFlow(store, skill.name, {});
  else out(`Install it explicitly: ${c.cyan(`reflex install ${skill.name}`)}`);
}

export async function show(ref: string): Promise<void> {
  const store = new Store();
  try {
    renderShow(findOrThrow(store, ref));
  } finally {
    store.close();
  }
}

export async function evidence(ref: string): Promise<void> {
  const store = new Store();
  try {
    renderEvidence(findOrThrow(store, ref).data);
  } finally {
    store.close();
  }
}

export async function approve(ref: string, opts: { yes?: boolean; install?: boolean }): Promise<void> {
  const store = new Store();
  try {
    const entry = findOrThrow(store, ref);
    renderSuggestion(entry);
    if (!(await confirm(`Generate a skill from "${entry.data.title}"?`, opts))) {
      out("Not approved. Nothing was written.");
      return;
    }
    await approveEntry(store, entry, { yes: opts.yes, noInstall: opts.install === false });
  } finally {
    store.close();
  }
}

export async function reject(ref: string): Promise<void> {
  const store = new Store();
  try {
    const entry = findOrThrow(store, ref);
    store.setStatus(entry.slug, "rejected");
    ok(`Rejected ${entry.slug}. It won't be suggested again (see \`reflex suggest --all\`).`);
  } finally {
    store.close();
  }
}
