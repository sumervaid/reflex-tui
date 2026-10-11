import * as p from "@clack/prompts";
import pc from "picocolors";

export const c = pc;

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export function out(line = ""): void {
  process.stdout.write(line + "\n");
}

export function title(text: string): void {
  out();
  out(c.bold(text));
  out();
}

export function rows(pairs: Array<[string, string]>, indent = 2): void {
  const width = Math.max(...pairs.map(([k]) => k.length));
  for (const [k, v] of pairs) out(`${" ".repeat(indent)}${c.dim(k.padEnd(width))}  ${v}`);
}

export function ok(text: string): void {
  out(`${c.green("✔")} ${text}`);
}

export function warn(text: string): void {
  out(`${c.yellow("!")} ${text}`);
}

export function fail(text: string): void {
  process.stderr.write(`${c.red("✖")} ${text}\n`);
}

export function shortDate(iso?: string): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function plural(n: number, word: string, pluralWord = word + "s"): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/**
 * Ask a yes/no question that defaults to No. `--yes` counts as explicit consent; without a TTY
 * and without `--yes` the answer is No.
 */
export async function confirm(message: string, opts: { yes?: boolean } = {}): Promise<boolean> {
  if (opts.yes) {
    out(`${c.cyan("◆")} ${message} ${c.dim("yes (--yes)")}`);
    return true;
  }
  if (!interactive()) {
    out(`${c.cyan("◆")} ${message} ${c.dim("no (not interactive; pass --yes to consent)")}`);
    return false;
  }
  const answer = await p.confirm({ message, initialValue: false, active: "Yes", inactive: "No" });
  return !p.isCancel(answer) && answer === true;
}

export async function choose<T extends string>(message: string, options: Array<{ value: T; label: string; hint?: string }>): Promise<T | undefined> {
  if (!interactive()) return undefined;
  const answer = await p.select({ message, options: options as never });
  return p.isCancel(answer) ? undefined : (answer as T);
}

/** Single-keypress choice; each option value is the key that selects it. */
export async function chooseKey<T extends string>(message: string, options: Array<{ value: T; label: string; hint?: string }>): Promise<T | undefined> {
  if (!interactive()) return undefined;
  const answer = await p.selectKey({ message, options: options as never });
  return p.isCancel(answer) ? undefined : (answer as T);
}

export async function chooseMany<T extends string>(message: string, options: Array<{ value: T; label: string; hint?: string }>): Promise<T[]> {
  if (!interactive()) return [];
  const answer = await p.multiselect({ message, options: options as never, required: false, initialValues: [] });
  return p.isCancel(answer) ? [] : (answer as T[]);
}

export async function ask(message: string, initial: string, validate: (v: string) => string | undefined): Promise<string | undefined> {
  if (!interactive()) return undefined;
  const answer = await p.text({ message, initialValue: initial, validate: (v) => validate(v ?? "") });
  return p.isCancel(answer) ? undefined : String(answer);
}

export function fileBlock(path: string, content: string): void {
  out(c.dim(`┌─ ${path}`));
  for (const line of content.trimEnd().split("\n")) out(`${c.dim("│")} ${line}`);
  out(c.dim("└─"));
}

export function spinner() {
  if (!interactive()) return { start: (m: string) => out(c.dim(m)), stop: (m: string) => out(c.dim(m)) };
  const s = p.spinner();
  return { start: (m: string) => s.start(m), stop: (m: string) => s.stop(m) };
}
