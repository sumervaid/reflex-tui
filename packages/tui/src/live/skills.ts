import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion } from "@reflex/analysis";
import { type SourceId, sha256 } from "@reflex/core";
import { displayPath, isSymlink, isValidSlug } from "@reflex/safety";
import { type InstallTarget, approveSuggestion, checkSkill, detectTargets, generateSkill, install, planInstall, uninstall } from "@reflex/skills";
import { type ScanRecord, Store, paths } from "@reflex/storage";
import type { Item, ItemList } from "../model";
import { toCells } from "../render/text";
import type { ActionResult, ToolId } from "../types";
import { dayLabel } from "./labels";

/** Previews read at most this much of a SKILL.md; Reflex writes skills of 150 lines or fewer. */
export const MAX_SKILL_BYTES = 64 * 1024;

export const TOOL_OF: Record<SourceId, ToolId> = { "claude-code": "claude", codex: "codex", cursor: "cursor" };
const toolName = (target: string): string => toCells(TOOL_OF[target as SourceId] ?? target);

/** A regular file of at most MAX_SKILL_BYTES, read without following symlinks; undefined otherwise. */
async function readCapped(file: string): Promise<string | undefined> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return undefined;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, n, buf.length - n, n);
      if (!bytesRead) break;
      n += bytesRead;
      if (n > MAX_SKILL_BYTES) return undefined;
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Reflex's own copy, `~/.reflex/skills/<name>/SKILL.md`, never through a symlinked folder. */
async function readReflexCopy(name: string): Promise<string | undefined> {
  if (!isValidSlug(name)) return undefined;
  const dir = join(paths.skills(), name);
  if ((await isSymlink(paths.skills())) || (await isSymlink(dir))) return undefined;
  return readCapped(join(dir, "SKILL.md"));
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

const toLines = (text: string): string[] => text.trimEnd().split("\n").map(toCells);
export const errorText = (e: unknown): string => toCells(e instanceof Error ? e.message : String(e));

function preview(s: Suggestion, now: Date): string[] {
  try {
    return toLines(generateSkill(s, now).content);
  } catch (e) {
    return [`no preview: ${errorText(e)}`];
  }
}

/**
 * Generated skills plus pending suggestions. New (pending) items come first in rank order, then
 * generated skills oldest first. A generated skill is retired when the latest scan no longer found
 * its suggestion; it is on when an installation record points at a file that is still there.
 */
export async function skillItems(store: Store, scan: ScanRecord | undefined, targets: InstallTarget[], now: Date): Promise<ItemList> {
  const claude = targets.find((t) => t.id === "claude-code");
  const current = store.suggestions();
  const found = new Set(current.map((s) => s.slug));
  const generated = store.skills();
  const names = new Set(generated.map((k) => k.name));
  const installs = store.installations();
  const installed = async (name: string): Promise<boolean> => {
    for (const r of installs) if (r.skill === name && (await isFile(r.path))) return true;
    return false;
  };
  const path = (name: string): string => (claude ? toCells(`${displayPath(claude.skillsDir)}/${name}/SKILL.md`) : "");
  const foundOn = scan ? dayLabel(new Date(scan.startedAt)) : dayLabel(now);

  const items: Item[] = [];
  for (const s of current) {
    if (s.status !== "pending" || names.has(s.slug)) continue;
    const name = toCells(s.slug);
    items.push({ name, on: await installed(s.slug), support: s.data.instances, updated: foundOn, state: "new", steps: s.data.steps.length, path: path(name), markdown: preview(s.data, now) });
  }
  for (const k of generated) {
    const s = store.suggestionBySlug(k.suggestionSlug);
    const text = await readReflexCopy(k.name);
    const name = toCells(k.name);
    items.push({
      name,
      on: await installed(k.name),
      support: s?.instances ?? 0,
      updated: dayLabel(new Date(k.createdAt)),
      state: found.has(k.suggestionSlug) ? "" : "retired",
      steps: s?.steps.length ?? 0,
      path: path(name),
      markdown: text === undefined ? [toCells(`could not read ${displayPath(join(paths.skills(), k.name, "SKILL.md"))}`)] : toLines(text),
    });
  }
  return { items, targets: targets.filter((t) => t.detected).map((t) => toCells(`${displayPath(t.skillsDir)}/<name>/SKILL.md`)) };
}

/**
 * Approve a pending suggestion (never replacing a Reflex copy the user edited), or take an already
 * generated skill, and install it into every detected target. An identical copy already there
 * counts as installed and is recorded; a different skill with the same name is left alone and
 * reported.
 */
export async function turnOn(name: string): Promise<ActionResult> {
  const store = new Store();
  try {
    let content: string | undefined;
    const pending = store.suggestions().find((s) => s.slug === name && s.status === "pending");
    if (store.skill(name)) {
      content = await readReflexCopy(name);
      if (content === undefined) return { ok: false, message: `could not read the SKILL.md of ${toCells(name)}`, tone: "bad" };
    } else if (pending) {
      const res = await approveSuggestion(store, pending, paths.skills(), async () => false);
      if (!res.written) return { ok: false, message: `kept ${toCells(name)}: edited since Reflex generated it`, tone: "warn" };
      content = res.skill.content;
    } else {
      return { ok: false, message: `no skill named ${toCells(name)}`, tone: "dim" };
    }
    if (!checkSkill(content, name).ok) return { ok: false, message: `${toCells(name)} failed validation; see \`reflex validate\``, tone: "bad" };

    const targets = (await detectTargets()).filter((t) => t.detected);
    if (!targets.length) return { ok: false, message: "no Claude Code, Codex or Cursor found", tone: "warn" };
    const done: string[] = [];
    const skipped: string[] = [];
    for (const t of targets) {
      const plan = await planInstall(t, name, content).catch(() => undefined);
      if (!plan || (plan.existing !== undefined && !plan.identical)) {
        skipped.push(toolName(t.id));
        continue;
      }
      if (plan.identical) {
        const known = store.installations(name).some((r) => r.target === t.id && r.path === plan.destination);
        if (!known) store.saveInstallation({ skill: name, target: t.id, path: plan.destination, installedAt: new Date().toISOString(), contentHash: sha256(content) });
        done.push(toolName(t.id));
        continue;
      }
      const res = await install(plan, content).catch(() => undefined);
      if (!res) {
        skipped.push(toolName(t.id));
        continue;
      }
      store.saveInstallation({ skill: name, target: t.id, path: res.path, installedAt: new Date().toISOString(), contentHash: res.contentHash });
      done.push(toolName(t.id));
    }
    const n = toCells(name);
    if (!done.length) return { ok: false, message: `skipped ${n} · a different skill exists in ${skipped.join(", ")}`, tone: "warn" };
    if (skipped.length) return { ok: true, message: `installed ${n} · skipped ${skipped.join(", ")} (a different skill exists)`, tone: "warn" };
    return { ok: true, message: `installed ${n}`, tone: "ok" };
  } finally {
    store.close();
  }
}

/**
 * Remove every installed copy that is still exactly what Reflex wrote and drop its record. Copies
 * edited since install stay, with their records, and are reported.
 */
export async function turnOff(name: string): Promise<ActionResult> {
  const store = new Store();
  try {
    const records = store.installations(name);
    if (!records.length) return { ok: false, message: `${toCells(name)} is not installed`, tone: "dim" };
    const targets = await detectTargets();
    const kept = new Set<string>();
    for (const r of records) {
      const t = targets.find((x) => x.id === r.target);
      const res = t ? await uninstall(t, r) : "edited";
      if (res === "edited") kept.add(toolName(r.target));
      else store.removeInstallation(r.skill, r.target, r.path);
    }
    if (kept.size) return { ok: false, message: `kept ${toCells(name)} in ${[...kept].join(", ")}: edited since install`, tone: "warn" };
    return { ok: true, message: `removed ${toCells(name)}`, tone: "dim" };
  } finally {
    store.close();
  }
}

