import type { Suggestion } from "@reflex/analysis";
import { SOURCE_IDS } from "@reflex/core";
import type { StoredSuggestion } from "@reflex/storage";
import type { Item, ItemList } from "../model";
import { toCells } from "../render/text";
import { tok } from "../views/tokens";
import { count, dayLabel } from "./labels";
import { TOOL_OF } from "./skills";

/** Sessions listed under a workflow's evidence; the rest are counted. */
const MAX_EVIDENCE = 12;

const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;

/** What Reflex found for one workflow, as the Workflows preview shows it: the evidence behind its skill. */
export function workflowMarkdown(s: Suggestion): string[] {
  const tools = SOURCE_IDS.filter((x) => s.sources[x]).map((x) => `${TOOL_OF[x]} ${s.sources[x]}`);
  const L = [`# ${s.title}`, "", s.description, ""];
  L.push(`${plural(s.instances, "independent session")} · ${plural(s.repositories.length, "repository", "repositories")} · ${tools.join(", ")}`);
  L.push(`confidence ${s.confidence.toFixed(2)} · verified in ${Math.round(s.verifiedRate * 100)}% of runs`);
  const cost: string[] = [];
  if (s.cost?.medianTokens !== undefined) cost.push(`median ${tok(s.cost.medianTokens)} tokens`);
  if (s.cost?.medianToolCalls !== undefined) cost.push(`median ${count(s.cost.medianToolCalls)} tool calls`);
  if (s.medianMinutes !== undefined) cost.push(`median ${s.medianMinutes < 120 ? `${Math.round(s.medianMinutes)} min` : `${(s.medianMinutes / 60).toFixed(1)} h`}`);
  if (cost.length) L.push(`${cost.join(" · ")} per run`);

  L.push("", "## Steps", "");
  s.steps.forEach((st, i) => {
    L.push(`${i + 1}. ${st.label}  (${Math.round(st.support * s.instances)}/${s.instances})`);
    if (st.variants?.length) L.push(`   ${st.variants.join(" · ")}`);
    if (st.examples.length) L.push(`   seen: ${st.examples.join(", ")}`);
  });
  if (s.constraints?.length) {
    L.push("", "## Recurring corrections", "");
    for (const c of s.constraints) L.push(`- ${c.text} (${plural(c.sessions, "session")})`);
  }
  if (s.notes.length) {
    L.push("", "## Uncertainty", "");
    for (const n of s.notes) L.push(`- ${n}`);
  }
  L.push("", "## Sessions", "");
  for (const e of s.evidence.slice(0, MAX_EVIDENCE)) {
    const date = e.date ? dayLabel(new Date(e.date)) : "—";
    L.push(`- ${date}  ${TOOL_OF[e.source]}  ${e.project ?? "—"}  ${e.excerpt}`);
  }
  if (s.evidence.length > MAX_EVIDENCE) L.push(`- +${count(s.evidence.length - MAX_EVIDENCE)} more (reflex evidence ${s.slug})`);
  return L.map(toCells);
}

/**
 * Every workflow the latest analysis found, rejected ones left out. A workflow installs as its
 * skill, so it is on when that skill is installed and `space` approves or installs the same skill.
 */
export function workflowItems(suggestions: StoredSuggestion[], skillOf: Map<string, string>, skills: ItemList, foundOn: string): ItemList {
  const byName = new Map(skills.items.map((i) => [i.name, i]));
  const items: Item[] = suggestions
    .filter((s) => s.status !== "rejected")
    .map((s) => {
      const skill = byName.get(toCells(skillOf.get(s.slug) ?? s.slug));
      return {
        name: toCells(s.slug),
        on: skill?.on ?? false,
        support: s.data.instances,
        updated: foundOn,
        state: "",
        steps: s.data.steps.length,
        path: skill?.path ?? "",
        markdown: workflowMarkdown(s.data),
      };
    });
  return { items, targets: skills.targets };
}
