import { readFile } from "node:fs/promises";
import { MIN_COMPARISON_RUNS, type WorkflowCost, measureImpact } from "@reflex/analysis";
import { type SkillRecord, Store } from "@reflex/storage";
import { c, fmtTokens, out, pct, plural, rows, shortDate, title } from "../ui";

/** Rough size of the skill file in context; real tokenizers differ. */
const CHARS_PER_TOKEN = 4;

export function describeCost(cost: WorkflowCost): string {
  if (!cost.runs) return "no runs yet";
  const parts = [plural(cost.runs, "run")];
  if (cost.runsWithTokens && cost.medianTokens !== undefined) {
    const coverage = cost.runsWithTokens < cost.runs ? c.dim(` (token data for ${cost.runsWithTokens} of ${cost.runs})`) : "";
    parts.push(`median ${c.bold(fmtTokens(cost.medianTokens))} tokens${coverage}`);
  } else {
    parts.push(c.dim("no token data"));
  }
  if (cost.medianToolCalls !== undefined) parts.push(`median ${Math.round(cost.medianToolCalls)} tool calls`);
  return parts.join(" · ");
}

function describeMix(cost: WorkflowCost): string | undefined {
  const u = cost.usage;
  if (!u) return undefined;
  return `fresh input ${fmtTokens(u.input)} · cache reads ${fmtTokens(u.cacheRead)} · cache writes ${fmtTokens(u.cacheWrite)} · output ${fmtTokens(u.output)}`;
}

function describeChange(value: number | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  const text = `${value <= 0 ? "−" : "+"}${pct(Math.abs(value))} ${what}`;
  return value <= 0 ? c.green(text) : c.yellow(text);
}

async function overheadTokens(skill: SkillRecord): Promise<number | undefined> {
  try {
    return Math.round((await readFile(skill.path, "utf8")).length / CHARS_PER_TOKEN);
  } catch {
    return undefined;
  }
}

async function renderImpact(store: Store, skill: SkillRecord, traces: ReturnType<Store["traces"]>): Promise<void> {
  const baseline = skill.baseline ?? store.suggestionBySlug(skill.suggestionSlug)?.cost;
  out(`${c.bold(skill.name)} ${c.dim(`· approved ${shortDate(skill.createdAt)}`)}`);
  if (!baseline) {
    rows([["Before the skill", c.dim(`unknown: approved before Reflex measured cost. Run \`reflex scan\`, then \`reflex approve ${skill.suggestionSlug}\` to record it.`)]], 2);
    out();
    return;
  }
  const impact = measureImpact(skill.name, baseline, traces);
  const changes = [describeChange(impact.tokenChange, "tokens"), describeChange(impact.toolCallChange, "tool calls")].filter(Boolean);
  const overhead = await overheadTokens(skill);
  const lines: Array<[string, string]> = [["Before the skill", describeCost(impact.before)]];
  const mix = describeMix(impact.before);
  if (mix) lines.push(["", c.dim(mix)]);
  lines.push(["With the skill", impact.after.runs ? describeCost(impact.after) : c.dim("no runs yet. Use the skill, then run `reflex scan` again.")]);
  lines.push([
    "Change",
    changes.length
      ? `${changes.join(" · ")} ${c.dim("(medians per run)")}`
      : c.dim(`not enough runs to compare (needs ${MIN_COMPARISON_RUNS} on each side)`),
  ]);
  if (overhead !== undefined) lines.push(["Skill overhead", `≈${fmtTokens(overhead)} tokens each time it loads ${c.dim(`(estimated at ${CHARS_PER_TOKEN} characters per token)`)}`]);
  rows(lines, 2);
  out();
}

export async function impact(name?: string): Promise<void> {
  const store = new Store();
  try {
    const skills = name ? [store.skill(name)].filter((s): s is SkillRecord => !!s) : store.skills();
    if (name && !skills.length) throw new Error(`No generated skill "${name.slice(0, 40)}". Run \`reflex skills\` to list them.`);
    if (!skills.length) {
      out("No generated skills yet. Approve a suggestion with `reflex suggest`, then come back after using it.");
      return;
    }
    const traces = store.traces();
    title("Skill impact");
    for (const skill of skills) await renderImpact(store, skill, traces);
    out(c.dim("Tokens are whole sessions as Claude Code and Codex record them, cache reads included. Cursor does not record"));
    out(c.dim("tokens, so Cursor runs only count tool calls. A run uses the skill when the agent invoked it or read its SKILL.md."));
    out(c.dim("Small samples are noisy: this measures what happened, it does not predict savings."));
  } finally {
    store.close();
  }
}
