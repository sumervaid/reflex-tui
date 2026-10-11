import { COLOR, type Row } from "../types";
import { FrameWriter } from "./ansi";
import { ESC_TIMEOUT_MS, InputReader, type InputEvent } from "./input";

/** The input side of a terminal: process.stdin, or a fake in tests. */
export interface TermInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  off(event: "data", fn: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The output side of a terminal: process.stdout, or a fake in tests. */
export interface TermOutput {
  columns?: number;
  rows?: number;
  write(s: string): unknown;
  on(event: "resize", fn: () => void): unknown;
  off(event: "resize", fn: () => void): unknown;
}

/** The parts of `process` the terminal hooks to restore itself on exit and fatal signals. */
export interface ProcessLike {
  pid: number;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  off(event: string, fn: (...args: unknown[]) => void): unknown;
  kill(pid: number, signal: string): unknown;
}

export type TermSize = { w: number; h: number };

export type TerminalOptions = {
  input?: TermInput;
  output?: TermOutput;
  proc?: ProcessLike;
  /** How long a lone ESC waits for the rest of a sequence (default 40 ms). */
  escMs?: number;
};

/** Modes the TUI turns on, in this order. */
export const ENTER_SEQ = [
  "\x1b[?1049h", // alternate screen
  "\x1b[?25l", // hide the cursor
  "\x1b[?7l", // no autowrap: a row that is too wide is clipped instead of scrolling the screen
  "\x1b[?1000h", // mouse clicks and wheel
  "\x1b[?1006h", // reported as SGR (no coordinate limit)
  "\x1b[?2004h", // bracketed paste
].join("");

/** The same modes turned off in reverse order, with the colors reset before leaving the alternate screen. */
export const LEAVE_SEQ = ["\x1b[?2004l", "\x1b[?1006l", "\x1b[?1000l", "\x1b[?7h", "\x1b[0m", "\x1b[?25h", "\x1b[?1049l"].join("");

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type Signal = (typeof SIGNALS)[number];

/** After a child process returns the terminal, a SIGINT it caused may still be on its way to us. */
const SIGINT_GRACE_MS = 250;

/** Run `fn`, ignoring errors: restoring the terminal must go on even when one step fails (closed TTY). */
const safe = (fn: () => unknown): void => {
  try {
    fn();
  } catch {
    // ignored on purpose
  }
};

/**
 * The full-screen terminal: raw mode, alternate screen, hidden cursor, mouse and bracketed paste
 * while started, input as events, frames drawn with row diffing. It restores the user's terminal
 * on `stop()`, on process exit, on SIGINT/SIGTERM/SIGHUP (then re-raises the signal) and on a
 * crash: uncaught exceptions and unhandled rejections are seen through `uncaughtExceptionMonitor`,
 * which does not change how Node handles them.
 */
export class Terminal {
  private readonly input: TermInput;
  private readonly output: TermOutput;
  private readonly proc: ProcessLike;
  private readonly escMs: number;
  private readonly writer: FrameWriter;
  private reader: InputReader | null = null;
  private readonly inputFns = new Set<(e: InputEvent) => void>();
  private readonly resizeFns = new Set<(s: TermSize) => void>();
  private hooks: Array<[string, (...args: unknown[]) => void]> = [];
  private started = false;
  private entered = false;
  private suspended = false;
  private graceUntil = 0;
  private last: Row[] | null = null;

  constructor(o: TerminalOptions = {}) {
    this.input = o.input ?? process.stdin;
    this.output = o.output ?? process.stdout;
    this.proc = o.proc ?? process;
    this.escMs = o.escMs ?? ESC_TIMEOUT_MS;
    this.writer = new FrameWriter((s) => this.write(s), COLOR.bg);
  }

  /** Started and not handed to a child process. */
  get active(): boolean {
    return this.started && !this.suspended;
  }

  /** Take over the terminal. Safe to call twice. */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.hook();
      this.enter();
      this.output.on("resize", this.handleResize);
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  /** Give the terminal back exactly as it was. Idempotent; never throws. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.suspended = false;
    safe(() => this.output.off("resize", this.handleResize));
    this.leave();
    this.unhook();
  }

  /** Subscribe to key, mouse and paste events. Returns the unsubscribe function. */
  onInput(fn: (e: InputEvent) => void): () => void {
    this.inputFns.add(fn);
    return () => this.inputFns.delete(fn);
  }

  /** Subscribe to size changes. The next frame repaints fully. Returns the unsubscribe function. */
  onResize(fn: (size: TermSize) => void): () => void {
    this.resizeFns.add(fn);
    return () => this.resizeFns.delete(fn);
  }

  /** Columns and rows (80x24 when the output does not say). */
  size(): TermSize {
    return { w: this.output.columns || 80, h: this.output.rows || 24 };
  }

  /** Draw a frame, writing only the rows that changed. Kept and drawn later while not active. */
  render(rows: Row[]): void {
    this.last = rows;
    if (this.active) this.writer.render(rows);
  }

  /** Repaint every row on the next `render` (e.g. after something else wrote to the screen). */
  invalidate(): void {
    this.writer.invalidate();
  }

  /**
   * Hand the terminal to `fn` (which runs a child process with inherited stdio), then take it
   * back and repaint the last frame. Works with a sync or an async `fn`; prefer `spawnSync`, so
   * Node does not read keys meant for the child. Ctrl-C in the child does not stop the TUI.
   */
  suspend<T>(fn: () => T): T {
    if (!this.active) return fn();
    const before = this.size();
    this.suspended = true;
    this.leave();
    const back = (): void => {
      this.suspended = false;
      this.graceUntil = Date.now() + SIGINT_GRACE_MS;
      if (!this.started) return; // stopped while the child ran
      this.enter();
      const now = this.size();
      if (now.w !== before.w || now.h !== before.h) this.handleResize();
      else if (this.last) this.writer.render(this.last);
    };
    let r: T;
    try {
      r = fn();
    } catch (e) {
      back();
      throw e;
    }
    if (r instanceof Promise) return r.finally(back) as unknown as T;
    back();
    return r;
  }

  private write(s: string): void {
    this.output.write(s);
  }

  private enter(): void {
    this.entered = true;
    this.input.setRawMode?.(true);
    this.write(ENTER_SEQ);
    this.writer.invalidate();
    this.reader = new InputReader((e) => this.dispatch(e), this.escMs);
    this.input.on("data", this.handleData);
    this.input.resume();
  }

  private leave(): void {
    if (!this.entered) return;
    this.entered = false;
    safe(() => this.input.off("data", this.handleData));
    safe(() => this.input.pause());
    this.reader?.dispose();
    this.reader = null;
    safe(() => this.write(LEAVE_SEQ));
    safe(() => this.input.setRawMode?.(false));
  }

  private hook(): void {
    const add = (event: string, fn: (...args: unknown[]) => void): void => {
      this.proc.on(event, fn);
      this.hooks.push([event, fn]);
    };
    add("exit", () => this.stop());
    add("uncaughtExceptionMonitor", () => this.stop());
    for (const sig of SIGNALS) add(sig, () => this.handleSignal(sig));
  }

  private unhook(): void {
    for (const [event, fn] of this.hooks) safe(() => this.proc.off(event, fn));
    this.hooks = [];
  }

  private handleSignal(sig: Signal): void {
    // A child run by `suspend` shares the terminal; its Ctrl-C reaches us too.
    if (sig === "SIGINT" && (this.suspended || Date.now() < this.graceUntil)) return;
    this.stop();
    // Our listeners are gone, so the re-raised signal has its default effect (or the app's handlers run).
    safe(() => this.proc.kill(this.proc.pid, sig));
  }

  private dispatch(e: InputEvent): void {
    if (!this.active) return;
    for (const fn of [...this.inputFns]) fn(e);
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    this.reader?.feed(chunk);
  };

  private readonly handleResize = (): void => {
    this.writer.invalidate();
    if (!this.active) return;
    const s = this.size();
    for (const fn of [...this.resizeFns]) fn(s);
  };
}
