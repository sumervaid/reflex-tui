import { spawnSync } from "node:child_process";
import type { TuiData } from "../model";
import { S, toRow } from "../render/text";
import { compose } from "../shell";
import { Terminal } from "../term/terminal";
import type { ActionResult, DataSource, Frame, ResumeCommand, Row, Toast, UiState, ViewId } from "../types";
import { QUERY_DEBOUNCE_MS, TOAST_MS, clampUi, initialUi, reduce, withToast, type AppEvent, type Effect } from "./state";

/** What the app needs from a terminal (tests pass a fake). */
export type Screen = Pick<Terminal, "start" | "stop" | "onInput" | "onResize" | "size" | "render" | "invalidate" | "suspend">;

export type RunOptions = {
  source: DataSource;
  /** Defaults to a `Terminal` on the process's stdin and stdout. */
  terminal?: Screen;
  /** Wall clock for the top bar. */
  now?: () => Date;
  /** A frozen top-bar clock, "HH:MM:SS" (previews and tests). */
  clock?: string;
  initialView?: ViewId;
  /** Fields that override the initial UI state, e.g. the design state for the real-terminal golden check. */
  initialUi?: Partial<UiState>;
};

export const MIN_W = 80;
export const MIN_H = 24;

const hhmmss = (d: Date): string => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");

/** The screen below the minimum size: one centered dim line, no hit regions. */
export function tooSmall(W: number, H: number): Frame {
  const msg = `Reflex AI needs at least ${MIN_W}×${MIN_H} (now ${W}×${H})`;
  const pad = " ".repeat(Math.max(0, Math.floor((W - msg.length) / 2)));
  const rows: Row[] = [];
  for (let y = 0; y < H; y++) rows.push(toRow(y === Math.floor(H / 2) ? [S(pad), S(msg, "dim")] : [], W));
  return { rows, hits: [] };
}

/**
 * Run the TUI until the user quits: draw on every change (coalesced), tick the clock, expire toasts,
 * and carry out the reducer's effects against `source` one at a time while the screen keeps
 * responding. On an error the terminal is restored before the promise rejects.
 */
export function runTui(opts: RunOptions): Promise<void> {
  const { source } = opts;
  const term: Screen = opts.terminal ?? new Terminal();
  const clockNow = (): string => opts.clock ?? hhmmss((opts.now ?? (() => new Date()))());

  return new Promise<void>((resolve, reject) => {
    let data: TuiData | undefined;
    let ui: UiState = { ...initialUi(opts.initialView ?? "dashboard", clockNow()), ...opts.initialUi };
    let frame: Frame | undefined;
    let done = false;
    let queued = false;
    let shownToast: Toast | null = null;
    let toastTimer: ReturnType<typeof setTimeout> | undefined;
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    let clockTimer: ReturnType<typeof setInterval> | undefined;
    let chain: Promise<void> = Promise.resolve();

    const finish = (err?: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(toastTimer);
      clearTimeout(queryTimer);
      clearInterval(clockTimer);
      try {
        term.stop();
      } catch (e) {
        if (err === undefined) err = e;
      }
      if (err === undefined) resolve();
      else reject(err);
    };
    const guard =
      <A extends unknown[]>(fn: (...a: A) => void) =>
      (...a: A): void => {
        try {
          fn(...a);
        } catch (e) {
          finish(e);
        }
      };

    const draw = guard((): void => {
      queued = false;
      if (done || !data) return;
      const { w, h } = term.size();
      frame = w < MIN_W || h < MIN_H ? tooSmall(w, h) : compose(w, h, data, ui);
      term.render(frame.rows);
    });
    const schedule = (): void => {
      if (queued || done) return;
      queued = true;
      queueMicrotask(draw);
    };

    const setUi = (next: UiState): void => {
      ui = next;
      if (ui.toast !== shownToast) {
        shownToast = ui.toast;
        clearTimeout(toastTimer);
        const t = ui.toast;
        if (t) toastTimer = setTimeout(guard(() => t === ui.toast && setUi({ ...ui, toast: null })), TOAST_MS);
      }
      schedule();
    };
    const toast = (r: ActionResult): void => setUi(withToast(ui, r.message, r.tone));

    const reload = async (): Promise<void> => {
      const prev = data;
      data = await source.load();
      setUi(clampUi(ui, data, prev));
    };
    /** Source actions run one at a time, in order; input keeps being handled meanwhile. */
    const act = (fn: () => Promise<void>): void => {
      chain = chain.then(() => (done ? undefined : fn())).catch((e: unknown) => finish(e));
    };
    const resume = async (c: ResumeCommand): Promise<void> => {
      let error: Error | undefined;
      await term.suspend(() => {
        error = spawnSync(c.cmd, c.args, { stdio: "inherit", cwd: c.cwd }).error;
      });
      term.invalidate();
      await reload();
      if (error) toast({ ok: false, message: `could not start ${c.cmd}: ${error.message}`, tone: "bad" });
      else if (c.done) toast({ ok: true, message: c.done, tone: "ok" });
    };

    const run = (e: Effect): void => {
      switch (e.type) {
        case "quit":
          return finish();
        case "debounce":
          clearTimeout(queryTimer);
          queryTimer = setTimeout(() => dispatch({ type: "query" }), QUERY_DEBOUNCE_MS);
          return;
        case "rescan":
          return act(async () => {
            const r = await source.rescan();
            await reload();
            setUi(withToast({ ...ui, scanning: false }, r.message, r.tone));
          });
        case "toggle":
          return act(async () => {
            const r = await source.toggleItem(e.kind, e.name, e.on);
            await reload();
            toast(r);
          });
        case "autopilot":
          return act(async () => {
            const r = await source.setAutopilot(e.on);
            await reload();
            toast(r);
          });
        case "memory":
          return act(async () => {
            const r = source.setMemory ? await source.setMemory(e.on) : { ok: false, message: "memory is not available yet", tone: "dim" as const };
            await reload();
            toast(r);
          });
        case "resume":
          return act(async () => {
            const r = source.resume(e.sessionId, e.turn);
            if ("cmd" in r) await resume(r);
            else toast(r);
          });
      }
    };

    const dispatch = guard((ev: AppEvent): void => {
      if (done) return;
      if (!data) {
        // Still loading: only quitting works.
        if (ev.type === "key" && (ev.name === "ctrl-c" || ev.ch === "q")) finish();
        return;
      }
      const { w, h } = term.size();
      const r = reduce(ui, ev, { data, w, h, frame });
      setUi(r.ui);
      r.effects.forEach(run);
    });

    try {
      term.onInput(dispatch);
      term.onResize(guard(schedule));
      term.start();
    } catch (e) {
      finish(e);
      return;
    }
    source.load().then(
      (d) => {
        if (done) return;
        data = d;
        setUi(clampUi(ui, d));
        if (opts.clock === undefined) clockTimer = setInterval(guard(() => {
          const c = clockNow();
          if (c !== ui.clock) setUi({ ...ui, clock: c });
        }), 1000);
      },
      (e: unknown) => finish(e),
    );
  });
}
