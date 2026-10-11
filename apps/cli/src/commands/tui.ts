import { spawn } from "node:child_process";
import { SOURCE_IDS } from "@reflex/core";
import { type ScanRecord, Store } from "@reflex/storage";
import { type RescanResult, createLiveSource, runTui } from "@reflex/tui";

/**
 * Arguments that repeat the latest scan: the same window and only the sources it read, whose
 * consent was already given. Undefined when that cannot be repeated exactly (custom folders are
 * not recorded, and a scan that read nothing has no consented source).
 */
export function rescanArgs(script: string, scan: ScanRecord): string[] | undefined {
  const sources = SOURCE_IDS.filter((s) => scan.sources[s] !== undefined);
  if (scan.mode !== "local" || !sources.length) return undefined;
  return [script, "scan", "--yes", "--days", String(scan.days), ...sources.flatMap((s) => ["--source", s])];
}

function snapshot(): { scan?: ScanRecord; ids: Set<string> } {
  const store = new Store();
  try {
    const scan = store.latestScan();
    return { scan, ids: new Set(scan ? store.traces().map((t) => t.sessionId) : []) };
  } finally {
    store.close();
  }
}

/** Run `reflex scan` again in a child process (this same CLI, fixed arguments, no shell) and count new sessions. */
export async function rescanWithCli(script = process.argv[1] ?? ""): Promise<RescanResult> {
  const before = snapshot();
  const args = before.scan && rescanArgs(script, before.scan);
  if (!args) {
    const custom = before.scan?.mode === "custom";
    return { ok: false, message: custom ? "the last scan used custom folders; run `reflex scan`" : "run `reflex scan` first to choose what Reflex may read", tone: "dim" };
  }
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "ignore", shell: false });
    child.on("error", () => resolve(null));
    child.on("exit", (c) => resolve(c));
  });
  if (code !== 0) return { ok: false, message: "rescan failed; run `reflex scan` to see why", tone: "bad" };
  const after = snapshot();
  const sessions = after.scan?.sessions ?? 0;
  const added = [...after.ids].filter((id) => !before.ids.has(id)).length;
  return { ok: true, message: `rescanned: ${sessions.toLocaleString("en-US")} sessions, ${added} new`, tone: "ok", sessions, added };
}

export async function tui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("reflex tui needs an interactive terminal");
  await runTui({ source: createLiveSource({ rescan: () => rescanWithCli() }) });
}
