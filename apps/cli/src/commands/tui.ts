import { spawn } from "node:child_process";
import { SOURCE_IDS } from "@reflex/core";
import { redact } from "@reflex/safety";
import { type ScanRecord, Store } from "@reflex/storage";
import { type RescanResult, createLiveSource, runTui } from "@reflex/tui";

/** Minutes a TUI rescan may spend comparing new sessions by meaning; the rest continue next scan. */
const RESCAN_EMBED_MINUTES = 1;
/** A rescan still running after this is stopped. */
export const RESCAN_TIMEOUT_MS = 10 * 60_000;
/** How much of the child's stderr is kept to explain a failure. */
const STDERR_KEEP = 4096;

/**
 * Arguments that repeat the latest scan: the same window and only the sources it read, whose
 * consent was already given, with a short embedding budget so the TUI comes back quickly.
 * Undefined when that cannot be repeated exactly (custom folders are not recorded, and a scan
 * that read nothing has no consented source).
 */
export function rescanArgs(script: string, scan: ScanRecord): string[] | undefined {
  const sources = SOURCE_IDS.filter((s) => scan.sources[s] !== undefined);
  if (scan.mode !== "local" || !sources.length) return undefined;
  return [script, "scan", "--yes", "--days", String(scan.days), ...sources.flatMap((s) => ["--source", s]), "--embed-minutes", String(RESCAN_EMBED_MINUTES)];
}

/** The last line of a failed scan's stderr worth showing, redacted and short enough for a toast. */
export function failureReason(stderr: string): string | undefined {
  // The child runs with NO_COLOR, so its messages carry no color codes.
  const lines = stderr
    .split("\n")
    .map((l) => l.replace(/^[✖!]\s*/, "").trim())
    .filter((l) => l && !/ExperimentalWarning|--trace-warnings/.test(l));
  const last = lines.at(-1);
  if (!last) return undefined;
  const line = redact(last);
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
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

/**
 * Run `reflex scan` again in a child process (this same CLI, fixed arguments, no shell) and count
 * new sessions. A failure says why, from the end of the child's stderr; a scan still running after
 * `timeoutMs` is stopped.
 */
export async function rescanWithCli(script = process.argv[1] ?? "", timeoutMs = RESCAN_TIMEOUT_MS): Promise<RescanResult> {
  const before = snapshot();
  const args = before.scan && rescanArgs(script, before.scan);
  if (!args) {
    const custom = before.scan?.mode === "custom";
    return { ok: false, message: custom ? "the last scan used custom folders; run `reflex scan`" : "run `reflex scan` first to choose what Reflex may read", tone: "dim" };
  }
  const { code, stderr, timedOut } = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      env: { ...process.env, NO_COLOR: "1", NODE_NO_WARNINGS: "1" },
    });
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: err.message, timedOut });
    });
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve({ code: c, stderr, timedOut });
    });
  });
  if (timedOut) return { ok: false, message: `rescan stopped after ${Math.round(timeoutMs / 60_000)} min; run \`reflex scan\` to finish it`, tone: "bad" };
  if (code !== 0) {
    const reason = failureReason(stderr);
    return { ok: false, message: reason ? `rescan failed: ${reason}` : "rescan failed; run `reflex scan` to see why", tone: "bad" };
  }
  const after = snapshot();
  const sessions = after.scan?.sessions ?? 0;
  const added = [...after.ids].filter((id) => !before.ids.has(id)).length;
  return { ok: true, message: `rescanned: ${sessions.toLocaleString("en-US")} sessions, ${added} new`, tone: "ok", sessions, added };
}

export async function tui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("reflex tui needs an interactive terminal");
  await runTui({ source: createLiveSource({ rescan: () => rescanWithCli() }) });
}
