import { readFile } from "node:fs/promises";
import { displayPath, pathExists } from "@reflex/safety";
import { Store, paths } from "@reflex/storage";
import { HOOK_EVENTS, assertHookSupported, cursorHooksFile, hookCommand, hookScript, hookStatus, installHook, removeHook } from "../cursor-hook";
import { c, confirm, ok, out, plural, rows, title, warn } from "../ui";

/** What the hook has recorded so far: turns, conversations, the latest time. Counts only. */
async function recorded(): Promise<{ turns: number; conversations: Set<string>; latest?: string }> {
  const conversations = new Set<string>();
  let turns = 0;
  let latest: string | undefined;
  try {
    for (const line of (await readFile(paths.cursorUsage(), "utf8")).split("\n")) {
      try {
        const r = JSON.parse(line) as { conversation_id?: string; at?: string; event?: string };
        if (r.event !== "stop" || !r.conversation_id) continue;
        turns++;
        conversations.add(r.conversation_id);
        if (r.at && (!latest || r.at > latest)) latest = r.at;
      } catch {
        continue;
      }
    }
  } catch {
    /* nothing recorded yet */
  }
  return { turns, conversations, latest };
}

/** `reflex cursor-usage`: whether the hook is on, and what it has recorded. */
export async function cursorUsageStatus(): Promise<void> {
  const file = cursorHooksFile();
  const status = await hookStatus(file);
  const rec = await recorded();
  title("Cursor token usage");
  const on = status.events.length === HOOK_EVENTS.length;
  rows([
    ["Hook", on ? `${c.green("on")} ${c.dim(`· ${displayPath(file)} (${status.events.join(", ")})`)}` : status.events.length ? c.yellow(`partly on (${status.events.join(", ")})`) : `off ${c.dim("· reflex cursor-usage on")}`],
    ["Recorded", rec.turns ? `${plural(rec.turns, "turn")} in ${plural(rec.conversations.size, "chat")}${rec.latest ? c.dim(` · latest ${rec.latest.slice(0, 16).replace("T", " ")} UTC`) : ""}` : c.dim("nothing yet")],
    ["Log", displayPath(paths.cursorUsage())],
  ]);
  if (status.error) warn(status.error);
  if (on && !(await pathExists(hookScript()))) warn("The hook script is missing; run reflex cursor-usage on again.");
  const store = new Store();
  try {
    if (store.latestScan() && rec.conversations.size) {
      const priced = store.traces().filter((t) => t.source === "cursor" && t.usage).length;
      out();
      out(`  ${plural(priced, "Cursor chat")} in the last scan ${priced === 1 ? "has" : "have"} token counts. ${c.dim("reflex scan picks up new turns.")}`);
    }
  } finally {
    store.close();
  }
  out();
  out(c.dim("Cursor saves no token usage in its transcripts; its hooks receive it at the end of each agent turn. Only chats from when"));
  out(c.dim("the hook is on get counts. Cursor's command-line agent in -p mode sends no end-of-turn hook, so those runs have none."));
}

/** `reflex cursor-usage on`: add the hook to Cursor's hooks file, after asking. */
export async function cursorUsageOn(opts: { yes?: boolean }): Promise<void> {
  assertHookSupported();
  const file = cursorHooksFile();
  title("Record Cursor token usage");
  out("  Cursor sends each agent turn's token counts to its hooks. Reflex adds one hook that writes only the chat and turn");
  out("  ids, the model and the four token counts to a local file. Never your prompt or the answer; no network.");
  out();
  rows([
    ["Hooks file", `${displayPath(file)} ${c.dim(`(adds ${HOOK_EVENTS.join(" and ")}; your other hooks stay as they are; a backup goes to ~/.reflex/backups)`)}`],
    ["Runs", c.dim(hookCommand().replace(/'/g, ""))],
    ["Writes to", displayPath(paths.cursorUsage())],
  ]);
  out();
  if (!(await confirm(`Add the hook to ${displayPath(file)}?`, opts))) return;
  const { added, backup } = await installHook(file);
  ok(added.length ? `Hook on (${added.join(", ")}). Cursor reloads hooks.json by itself; new turns are recorded from now on.` : "Hook was already on; its command is refreshed.");
  if (backup) out(c.dim(`  Previous hooks file: ${displayPath(backup)}`));
  out(c.dim("  reflex scan attaches the counts to your Cursor chats. reflex cursor-usage off removes the hook."));
}

/** `reflex cursor-usage off`: remove Reflex's entries; what was recorded stays until `reflex reset`. */
export async function cursorUsageOff(): Promise<void> {
  const { removed, backup } = await removeHook();
  if (!removed.length) ok("The hook was not on.");
  else ok(`Hook off (removed ${removed.join(", ")} from ${displayPath(cursorHooksFile())}).`);
  if (backup) out(c.dim(`  Previous hooks file: ${displayPath(backup)}`));
  out(c.dim(`  Recorded counts stay in ${displayPath(paths.cursorUsage())}; reflex reset deletes them.`));
}
