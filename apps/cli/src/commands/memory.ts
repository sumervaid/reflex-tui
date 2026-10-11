import { type MemoryWrite, cleanMemoryText, memoryTargets, removeMemory, syncMemory } from "@reflex/skills";
import { displayPath } from "@reflex/safety";
import { type MemoryEntry, Store } from "@reflex/storage";
import { c, confirm, ok, out, plural, rows, title, warn } from "../ui";

function reportWrites(writes: MemoryWrite[]): void {
  for (const w of writes) {
    if (w.skipped) warn(`${w.target.label}: ${w.skipped}`);
    else if (w.changed) ok(`${w.target.label}: ${displayPath(w.path)}`);
    else out(c.dim(`  ${w.target.label}: ${displayPath(w.path)} already up to date`));
  }
}

function find(entries: MemoryEntry[], ref: string): MemoryEntry {
  const n = Number(ref.replace(/^#/, ""));
  const e = Number.isInteger(n) && n > 0 ? entries[n - 1] : entries.find((x) => x.text === ref);
  if (!e) throw new Error(`No memory entry "${ref.slice(0, 40)}". Run \`reflex memory\` to list them.`);
  return e;
}

/** `reflex memory`: what new agent sessions will be told, and where. */
export async function memoryStatus(): Promise<void> {
  const store = new Store();
  try {
    await syncMemory(store, { mine: Boolean(store.latestScan()) });
    const { enabled } = store.memoryState();
    const entries = store.memoryEntries();
    const targets = (await memoryTargets()).filter((t) => t.detected);
    title(`Agent memory · ${enabled ? c.green("on") : c.dim("off")}`);
    out(
      enabled
        ? `Every new ${targets.map((t) => t.label).join(" and ")} session reads the active entries below.`
        : "Off: nothing is written outside Reflex's database. Turn it on with `reflex memory on`.",
    );
    rows(targets.map((t) => [t.label, displayPath(t.file)]));
    out();
    if (!entries.length) {
      out(`Nothing to remember yet. Memory comes from corrections you gave in at least 2 independent sessions${store.latestScan() ? "" : "; run `reflex scan` first"}.`);
      out(c.dim("Add your own: reflex memory add \"use pnpm, not npm\""));
      return;
    }
    entries.forEach((e, i) => {
      const meta = e.origin === "added" ? "added by you" : plural(e.sessions, "session");
      const line = `  ${String(i + 1).padStart(2)}. ${e.text} ${c.dim(`(${meta})`)}`;
      out(e.status === "forgotten" ? c.dim(`${line} forgotten`) : line);
    });
    out();
    out(c.dim("reflex memory forget <n> · remember <n> · add \"<text>\" · on · off"));
  } finally {
    store.close();
  }
}

export async function memoryOn(opts: { yes?: boolean }): Promise<void> {
  const store = new Store();
  try {
    const targets = (await memoryTargets()).filter((t) => t.detected);
    if (!targets.length) {
      warn("Neither Claude Code (~/.claude) nor Codex (~/.codex) was found on this machine.");
      return;
    }
    out("Reflex will keep a marked block in:");
    rows(targets.map((t) => [t.label, displayPath(t.file)]));
    out(c.dim("Only the text between <!-- reflex:memory:start --> and <!-- reflex:memory:end --> is Reflex's; the rest of each file is never changed."));
    if (!(await confirm("Turn agent memory on?", opts))) return;
    store.setMemoryState({ enabled: true });
    const res = await syncMemory(store, { mine: Boolean(store.latestScan()) });
    reportWrites(res.writes);
    ok(`Memory on: ${plural(res.rules, "entry", "entries")}. New sessions pick it up; it refreshes after every scan.`);
  } finally {
    store.close();
  }
}

export async function memoryOff(): Promise<void> {
  const store = new Store();
  try {
    store.setMemoryState({ enabled: false });
    reportWrites(await removeMemory());
    ok("Memory off. Reflex's block was removed; the entries stay in Reflex's database.");
  } finally {
    store.close();
  }
}

export async function memoryForget(ref: string): Promise<void> {
  const store = new Store();
  try {
    const e = find(store.memoryEntries(), ref);
    if (e.origin === "added") store.deleteMemory(e.text);
    else store.setMemoryStatus(e.text, "forgotten");
    reportWrites((await syncMemory(store, { mine: false })).writes);
    ok(`Forgot "${e.text}".`);
  } finally {
    store.close();
  }
}

export async function memoryRemember(ref: string): Promise<void> {
  const store = new Store();
  try {
    const e = find(store.memoryEntries(), ref);
    store.setMemoryStatus(e.text, "active");
    reportWrites((await syncMemory(store, { mine: false })).writes);
    ok(`Remembering "${e.text}" again.`);
  } finally {
    store.close();
  }
}

export async function memoryAdd(words: string[]): Promise<void> {
  const text = cleanMemoryText(words.join(" "));
  if (!text) throw new Error("That text is empty or looks like it contains a secret; nothing was added.");
  const store = new Store();
  try {
    store.addMemory(text);
    reportWrites((await syncMemory(store, { mine: false })).writes);
    ok(`Added "${text}".${store.memoryState().enabled ? "" : c.dim(" Memory is off; `reflex memory on` to share it with your agents.")}`);
  } finally {
    store.close();
  }
}
