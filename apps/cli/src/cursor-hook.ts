import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, isSymlink, pathExists, replaceOwnedFile, writeNewFile } from "@reflex/safety";
import { paths } from "@reflex/storage";

/** The Cursor events whose payload carries the turn's token counts. `stop` fires once per turn; `afterAgentResponse` is the fallback. */
export const HOOK_EVENTS = ["stop", "afterAgentResponse"] as const;
const SCRIPT_NAME = "cursor-usage.mjs";

/** Cursor's user-level hooks file. */
export const cursorHooksFile = (): string => process.env.REFLEX_CURSOR_HOOKS_FILE ?? join(homedir(), ".cursor", "hooks.json");
export const hookScript = (): string => join(paths.hooks(), SCRIPT_NAME);

/**
 * The hook Cursor runs: reads the event from stdin, writes one line with ids, model and token
 * counts to the usage log, and nothing else. It never writes the prompt or the answer, never
 * blocks the agent (always prints `{}` and exits 0), and makes no network calls.
 */
export function hookSource(logPath: string): string {
  return `// Written by Reflex (reflex cursor-usage on). Records token counts per Cursor agent turn; never text.
import { appendFileSync } from "node:fs";
const LOG = ${JSON.stringify(logPath)};
const ID = /^[A-Za-z0-9-]{1,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\\/-]{0,79}$/;
const id = (v) => (typeof v === "string" && ID.test(v) ? v : undefined);
const model = (v) => (typeof v === "string" && MODEL.test(v) ? v : undefined);
const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined);
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { if (raw.length < 8000000) raw += c; });
process.stdin.on("end", () => {
  try {
    const p = JSON.parse(raw);
    const event = p.hook_event_name;
    const rec = {
      v: 1,
      at: new Date().toISOString(),
      event,
      conversation_id: id(p.conversation_id),
      generation_id: id(p.generation_id),
      model: model(p.model_id) ?? model(p.model),
      input_tokens: n(p.input_tokens),
      output_tokens: n(p.output_tokens),
      cache_read_tokens: n(p.cache_read_tokens),
      cache_write_tokens: n(p.cache_write_tokens),
    };
    const counted = rec.input_tokens !== undefined || rec.output_tokens !== undefined;
    if ((event === "stop" || event === "afterAgentResponse") && rec.conversation_id && rec.generation_id && counted) {
      appendFileSync(LOG, JSON.stringify(rec) + "\\n", { mode: 0o600 });
    }
  } catch {}
  process.stdout.write("{}");
});
`;
}

/** The command Cursor runs: this machine's Node and the script, both absolute, single-quoted for the shell. */
export function hookCommand(node = process.execPath, script = hookScript()): string {
  for (const p of [node, script]) if (p.includes("'")) throw new Error(`Reflex can't quote the path ${p} for a hook command.`);
  return `'${node}' '${script}'`;
}

type HookEntry = { command?: unknown; [k: string]: unknown };
type HooksFile = { version?: unknown; hooks?: Record<string, unknown>; [k: string]: unknown };

const ours = (e: unknown): boolean => typeof (e as HookEntry)?.command === "string" && ((e as HookEntry).command as string).includes(`${SCRIPT_NAME}'`);

async function readHooks(file: string): Promise<{ data: HooksFile; raw?: string }> {
  if (await isSymlink(file)) throw new Error(`${file} is a symlink; Reflex won't write through it. Add the hook entry yourself (see reflex cursor-usage status).`);
  if (!(await pathExists(file))) return { data: { version: 1, hooks: {} } };
  const raw = await readFile(file, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON; Reflex won't overwrite it. Fix it, then run this again.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} is not a hooks object; Reflex won't overwrite it.`);
  return { data: data as HooksFile, raw };
}

/** Which of Reflex's hook entries are in Cursor's hooks file. Never throws. */
export async function hookStatus(file = cursorHooksFile()): Promise<{ events: string[]; error?: string }> {
  try {
    const { data } = await readHooks(file);
    const hooks = data.hooks ?? {};
    return { events: HOOK_EVENTS.filter((e) => Array.isArray(hooks[e]) && (hooks[e] as unknown[]).some(ours)) };
  } catch (e) {
    return { events: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function writeHooks(file: string, data: HooksFile, raw: string | undefined): Promise<string | undefined> {
  let backup: string | undefined;
  if (raw !== undefined) {
    const dir = join(paths.home(), "backups");
    await ensureDir(paths.home(), 0o700);
    await ensureDir(dir, 0o700);
    backup = join(dir, `cursor-hooks-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeNewFile(backup, raw, 0o600);
  }
  await ensureDir(join(file, ".."), 0o755);
  await replaceOwnedFile(file, JSON.stringify(data, null, 2) + "\n", 0o644);
  return backup;
}

/**
 * Write the hook script and add Reflex's entries to Cursor's hooks file. Every other key and hook
 * is kept as it was; the previous file is copied to `~/.reflex/backups` first.
 */
export async function installHook(file = cursorHooksFile()): Promise<{ added: string[]; backup?: string }> {
  await ensureDir(paths.home(), 0o700);
  await ensureDir(paths.hooks(), 0o700);
  await replaceOwnedFile(hookScript(), hookSource(paths.cursorUsage()), 0o700);
  const { data, raw } = await readHooks(file);
  const hooks = { ...(data.hooks ?? {}) };
  const command = hookCommand();
  const added: string[] = [];
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    if (list.some(ours)) {
      // Refresh the command (Node may have moved since it was installed).
      hooks[event] = list.map((e) => (ours(e) ? { ...(e as HookEntry), command } : e));
      continue;
    }
    hooks[event] = [...list, { command, timeout: 5 }];
    added.push(event);
  }
  const backup = await writeHooks(file, { ...data, version: data.version ?? 1, hooks }, raw);
  return { added, backup };
}

/** Remove Reflex's entries from Cursor's hooks file; everything else stays. The recorded counts are kept. */
export async function removeHook(file = cursorHooksFile()): Promise<{ removed: string[]; backup?: string }> {
  if (!(await pathExists(file))) return { removed: [] };
  const { data, raw } = await readHooks(file);
  const hooks = { ...(data.hooks ?? {}) };
  const removed: string[] = [];
  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const list = hooks[event] as unknown[];
    const kept = list.filter((e) => !ours(e));
    if (kept.length === list.length) continue;
    removed.push(event);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!removed.length) return { removed };
  const backup = await writeHooks(file, { ...data, hooks }, raw);
  return { removed, backup };
}
