import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { FrameWriter, encodeRow, safeText } from "../src/term/ansi";
import { parseHex, toXterm256, tryXterm256, xtermRgb } from "../src/term/colors";
import { InputParser, InputReader, type InputEvent } from "../src/term/input";
import { ENTER_SEQ, LEAVE_SEQ, Terminal, type TermSize } from "../src/term/terminal";
import { COLOR, type Hex, type Row, type Run } from "../src/types";

const E = "\x1b";
const run = (t: string, fg: Hex = COLOR.fg, bg: Hex | null = null, bold = false): Run => ({ t, fg, bg, bold });
// eslint-disable-next-line no-control-regex -- SGR sequences start with ESC
const stripSgr = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Compact event text: modifiers (C- M- S-), then the key name, 'char', mouse action:button@x,y or paste:text. */
function show(e: InputEvent): string {
  if (e.type === "paste") return `paste:${e.text}`;
  const m = (e.ctrl ? "C-" : "") + (e.alt ? "M-" : "") + (e.shift ? "S-" : "");
  if (e.type === "mouse") return `${m}${e.action}:${e.button}@${e.x},${e.y}`;
  return m + (e.name === "char" ? `'${e.ch}'` : e.name);
}

/** Feed the chunks in order, then flush. */
function parse(...chunks: Array<string | Uint8Array>): string[] {
  const p = new InputParser();
  const out = chunks.flatMap((c) => p.feed(c));
  return [...out, ...p.flush()].map(show);
}

const x10 = (b: number, x: number, y: number): Buffer => Buffer.from([0x1b, 0x5b, 0x4d, b + 32, x + 33, y + 33]);

describe("colors", () => {
  it("maps every design token to its documented xterm-256 index", () => {
    const want: Record<keyof typeof COLOR, number> = {
      bg: 234,
      sidebar: 235,
      bar: 236,
      sel: 237,
      ul: 237,
      key: 239,
      line: 238,
      faint: 240,
      dim: 244,
      gb: 245,
      fg: 252,
      hi: 255,
      ok: 114,
      warn: 179,
      bad: 167,
      autopilot: 22,
      match: 58,
    };
    for (const k of Object.keys(want) as Array<keyof typeof COLOR>) expect(toXterm256(COLOR[k]), k).toBe(want[k]);
  });

  it("is exact for every cube and grayscale entry", () => {
    for (let i = 16; i < 256; i++) {
      const hex = "#" + xtermRgb(i).map((v) => v.toString(16).padStart(2, "0")).join("");
      expect(toXterm256(hex), hex).toBe(i);
    }
  });

  it("picks the nearest entry otherwise, ties to the lower index", () => {
    expect(toXterm256("#7f7f7f")).toBe(244);
    expect(toXterm256("#000001")).toBe(16);
    expect(toXterm256("#ff0101")).toBe(196);
    expect(toXterm256("#d0d0d1")).toBe(252);
    expect(toXterm256("#0d0d0d")).toBe(232); // 13 is as far from gray 8 as from gray 18
    expect(toXterm256("#FFF")).toBe(231);
  });

  it("rejects strings that are not hex colors", () => {
    expect(parseHex("#abc")).toEqual([0xaa, 0xbb, 0xcc]);
    expect(tryXterm256("red")).toBeNull();
    expect(() => toXterm256("#12345")).toThrow(TypeError);
  });
});

describe("encodeRow", () => {
  it("sets fg and bg on the first run, paints bg null as the screen bg and resets at the end", () => {
    expect(encodeRow([run("ab")])).toBe(`${E}[38;5;252;48;5;234mab${E}[0m`);
    expect(encodeRow([run("ab")], COLOR.bar)).toBe(`${E}[38;5;252;48;5;236mab${E}[0m`);
    expect(encodeRow([])).toBe("");
  });

  it("emits only the attributes that change", () => {
    expect(encodeRow([run("A", COLOR.hi, null, true), run("b", COLOR.hi)])).toBe(`${E}[1;38;5;255;48;5;234mA${E}[22mb${E}[0m`);
    expect(encodeRow([run("a"), run("b", COLOR.fg, COLOR.sel)])).toBe(`${E}[38;5;252;48;5;234ma${E}[48;5;237mb${E}[0m`);
    expect(encodeRow([run("a", COLOR.fg, COLOR.sel), run("b", COLOR.ok)])).toBe(`${E}[38;5;252;48;5;237ma${E}[38;5;114;48;5;234mb${E}[0m`);
    expect(encodeRow([run("a", COLOR.dim), run("b", COLOR.dim, null, true), run("c", COLOR.dim, null, true)])).toBe(
      `${E}[38;5;244;48;5;234ma${E}[1mbc${E}[0m`,
    );
  });

  it("does not switch between colors that map to the same index, or between bg null and the screen bg", () => {
    expect(encodeRow([run("a", "#d0d0d0"), run("b", "#d0d0d1"), run("c", COLOR.fg, COLOR.bg)])).toBe(`${E}[38;5;252;48;5;234mabc${E}[0m`);
  });

  it("replaces control characters with ? one for one", () => {
    const evil = `a${E}[2J\x07\x9b\x7f\x00z`;
    const out = encodeRow([run(evil)]);
    expect(stripSgr(out)).toBe("a?[2J????z");
    expect(stripSgr(out)).not.toContain(E);
    expect(safeText(evil).length).toBe(evil.length);
  });
});

describe("FrameWriter", () => {
  const rows = (...t: string[]): Row[] => t.map((s) => [run(s)]);

  it("paints the first frame fully, then only the rows that changed", () => {
    let out = "";
    const fw = new FrameWriter((s) => (out += s));
    const first = fw.render(rows("aaa", "bbb", "ccc"));
    expect(first.startsWith(`${E}[?2026h`) && first.endsWith(`${E}[?2026l`)).toBe(true);
    expect(first).toContain(`${E}[2J`);
    for (const y of [1, 2, 3]) expect(first).toContain(`${E}[${y};1H`);
    expect(fw.render(rows("aaa", "bbb", "ccc"))).toBe("");
    const second = fw.render(rows("aaa", "bXb", "ccc"));
    expect(second).toBe(`${E}[?2026h${E}[2;1H${encodeRow([run("bXb")])}${E}[?2026l`);
    expect(out).toBe(first + second);
  });

  it("repaints fully after a size change or invalidate()", () => {
    const fw = new FrameWriter(() => {});
    fw.render(rows("aaa", "bbb"));
    const taller = fw.render(rows("aaa", "bbb", "ccc"));
    expect(taller).toContain(`${E}[2J`);
    expect(taller).toContain(`${E}[1;1H`);
    expect(fw.render(rows("aaaa", "bbbb", "cccc"))).toContain(`${E}[2J`);
    fw.invalidate();
    const again = fw.render(rows("aaaa", "bbbb", "cccc"));
    expect(again).toContain(`${E}[2J`);
    expect(again).toContain(`${E}[3;1H`);
  });

  it("pads a short row so no stale cells stay behind", () => {
    const fw = new FrameWriter(() => {});
    const out = fw.render([[run("abcd")], [run("ab")]]);
    expect(stripSgr(out)).toContain(`${E}[2;1Hab  `);
  });
});

describe("InputParser", () => {
  it("decodes keys", () => {
    expect(parse(`${E}[A${E}[B${E}[C${E}[D`)).toEqual(["up", "down", "right", "left"]);
    expect(parse(`${E}OA${E}OB${E}OC${E}OD`)).toEqual(["up", "down", "right", "left"]);
    expect(parse("\r", "\n")).toEqual(["enter", "enter"]);
    expect(parse("\t", `${E}[Z`)).toEqual(["tab", "S-backtab"]);
    expect(parse("\x7f\x08")).toEqual(["backspace", "backspace"]);
    expect(parse(`${E}[3~${E}[H${E}[F${E}[1~${E}[4~${E}OH${E}OF${E}[7~${E}[8~${E}[5~${E}[6~${E}[2~`)).toEqual([
      "delete",
      "home",
      "end",
      "home",
      "end",
      "home",
      "end",
      "home",
      "end",
      "pageup",
      "pagedown",
      "insert",
    ]);
    expect(parse(" ")).toEqual(["space"]);
    expect(parse("\x03\x04\x0c")).toEqual(["C-ctrl-c", "C-ctrl-d", "C-ctrl-l"]);
    expect(parse("a1/Q~")).toEqual(["'a'", "'1'", "'/'", "'Q'", "'~'"]);
    expect(parse(`${E}x${E}\r${E}\x7f`)).toEqual(["M-'x'", "M-enter", "M-backspace"]);
    expect(parse(`${E}[1;5A${E}[1;2B${E}[1;3C${E}[3;5~`)).toEqual(["C-up", "S-down", "M-right", "C-delete"]);
  });

  it("gives space and characters a ch, and control keys none", () => {
    const p = new InputParser();
    expect(p.feed(" ")[0]).toEqual({ type: "key", name: "space", ch: " ", ctrl: false, alt: false, shift: false });
    expect(p.feed("j")[0]).toEqual({ type: "key", name: "char", ch: "j", ctrl: false, alt: false, shift: false });
    expect(p.feed("\x0a")[0]).toEqual({ type: "key", name: "enter", ctrl: false, alt: false, shift: false });
    expect(p.feed("\x0b")[0]).toEqual({ type: "key", name: "ctrl-k", ctrl: true, alt: false, shift: false });
  });

  it("treats a lone ESC as Escape only when no more input can follow", () => {
    const p = new InputParser();
    expect(p.feed(E)).toEqual([]);
    expect(p.pending).toBe(true);
    expect(p.feed("[A").map(show)).toEqual(["up"]);
    expect(p.feed(E)).toEqual([]);
    expect(p.flush().map(show)).toEqual(["escape"]);
    expect(p.pending).toBe(false);
    expect(parse(E + E)).toEqual(["escape", "escape"]);
    expect(parse(E + "[")).toEqual(["M-'['"]);
    expect(parse(E + "O")).toEqual(["M-'O'"]);
  });

  it("decodes printable UTF-8 split at any byte", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const bytes = Buffer.from("é中" + emoji, "utf8");
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(parse(bytes.subarray(0, cut), bytes.subarray(cut))).toEqual(["'é'", "'中'", `'${emoji}'`]);
    }
  });

  it("decodes SGR mouse reports to 0-based cells with modifiers", () => {
    expect(parse(`${E}[<0;10;5M${E}[<0;10;5m`)).toEqual(["press:0@9,4", "release:0@9,4"]);
    expect(parse(`${E}[<2;1;1M${E}[<1;1;1M`)).toEqual(["press:2@0,0", "press:1@0,0"]);
    expect(parse(`${E}[<64;3;4M${E}[<65;3;4M`)).toEqual(["wheelup:4@2,3", "wheeldown:5@2,3"]);
    expect(parse(`${E}[<35;7;8M${E}[<32;7;8M`)).toEqual(["move:3@6,7", "move:0@6,7"]);
    expect(parse(`${E}[<16;2;2M${E}[<4;2;2M${E}[<8;2;2M`)).toEqual(["C-press:0@1,1", "S-press:0@1,1", "M-press:0@1,1"]);
    expect(parse(`${E}[<0;300;100M`)).toEqual(["press:0@299,99"]);
    expect(parse(`${E}[<66;1;1M${E}[<0;0;0M${E}[<128;1;1M`)).toEqual([]);
  });

  it("decodes legacy X10 mouse reports without leaking their bytes", () => {
    expect(parse(x10(0, 9, 4), x10(3, 9, 4), x10(64, 0, 0))).toEqual(["press:0@9,4", "release:3@9,4", "wheelup:4@0,0"]);
    expect(parse(x10(0, 150, 40))).toEqual(["press:0@150,40"]);
  });

  it("delivers a bracketed paste as one event, escape sequences inside included", () => {
    expect(parse(`${E}[200~hello\r\nworld ${E}[A q\r${E}[201~x`)).toEqual([`paste:hello\nworld ${E}[A q\n`, "'x'"]);
    const seq = `${E}[200~a${E}[2Jb${E}[201~`;
    for (let cut = 0; cut <= seq.length; cut++) expect(parse(seq.slice(0, cut), seq.slice(cut))).toEqual([`paste:a${E}[2Jb`]);
  });

  it("closes a paste whose end marker never comes on flush", () => {
    const p = new InputParser();
    expect(p.feed(`${E}[200~abc`)).toEqual([]);
    expect(p.pasting).toBe(true);
    expect(p.flush().map(show)).toEqual(["paste:abc"]);
    expect(p.feed("q").map(show)).toEqual(["'q'"]);
  });

  it("drops sequences it does not understand without leaking bytes", () => {
    expect(parse(`${E}[?1;2c${E}[12;40R${E}OP${E}[15~${E}[201~${E}[I${E}[O${E}[>0;276;0c${E}[E`)).toEqual([]);
    expect(parse(Buffer.from([0xff, 0xfe, 0x80, 0xc2, 0x9b, 0x00, 0x1c, 0xed, 0xa0, 0x80, 0xc0, 0xaf]))).toEqual([]);
    expect(parse(Buffer.from([0xc3, 0x28]))).toEqual(["'('"]);
    expect(parse(`${E}[1${E}[A`)).toEqual(["up"]);
    expect(parse(`${E}[1;2`)).toEqual([]);
    expect(parse(`${E}[<0;5`)).toEqual([]);
  });

  it("gives the same events however the input is split", () => {
    const all = Buffer.concat([
      Buffer.from(`a${E}[A${E}OB\r\n${E}[<0;10;5M${E}[200~p${E}[1~q${E}[201~é中${E}[1;5C${E}x \x7f${E}[3~${E}[?1;2c`, "utf8"),
      x10(0, 120, 3),
      Buffer.from("z", "utf8"),
    ]);
    const whole = parse(all);
    expect(whole).toEqual([
      "'a'",
      "up",
      "down",
      "enter",
      "enter",
      "press:0@9,4",
      `paste:p${E}[1~q`,
      "'é'",
      "'中'",
      "C-right",
      "M-'x'",
      "space",
      "backspace",
      "delete",
      "press:0@120,3",
      "'z'",
    ]);
    for (let cut = 0; cut <= all.length; cut++) expect(parse(all.subarray(0, cut), all.subarray(cut)), `cut ${cut}`).toEqual(whole);
    expect(parse(...[...all].map((b) => Uint8Array.of(b)))).toEqual(whole);
  });
});

describe("InputReader", () => {
  it("turns a lone ESC into Escape after 40 ms of silence, and stops after dispose", () => {
    vi.useFakeTimers();
    try {
      const got: string[] = [];
      const r = new InputReader((e) => got.push(show(e)));
      r.feed(E);
      vi.advanceTimersByTime(39);
      expect(got).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(got).toEqual(["escape"]);
      r.feed(E);
      vi.advanceTimersByTime(20);
      r.feed("[B");
      vi.advanceTimersByTime(100);
      expect(got).toEqual(["escape", "down"]);
      r.feed(`${E}[200~slow`);
      vi.advanceTimersByTime(500);
      expect(got).toEqual(["escape", "down"]);
      r.feed(" paste");
      vi.advanceTimersByTime(1000);
      expect(got).toEqual(["escape", "down", "paste:slow paste"]);
      r.feed(E);
      r.dispose();
      vi.advanceTimersByTime(100);
      r.feed("x");
      expect(got).toEqual(["escape", "down", "paste:slow paste"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeIn extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  flowing = false;
  setRawMode(m: boolean): this {
    this.raw.push(m);
    return this;
  }
  resume(): this {
    this.flowing = true;
    return this;
  }
  pause(): this {
    this.flowing = false;
    return this;
  }
}

class FakeOut extends EventEmitter {
  columns = 120;
  rows = 40;
  data = "";
  write(s: string): boolean {
    this.data += s;
    return true;
  }
}

class FakeProc extends EventEmitter {
  pid = 4242;
  kills: Array<[number, string]> = [];
  kill(pid: number, sig: string): boolean {
    this.kills.push([pid, sig]);
    return true;
  }
}

const HOOKED = ["exit", "uncaughtExceptionMonitor", "SIGINT", "SIGTERM", "SIGHUP"];

function setup() {
  const input = new FakeIn();
  const output = new FakeOut();
  const proc = new FakeProc();
  const term = new Terminal({ input, output, proc });
  const events: string[] = [];
  term.onInput((e) => events.push(show(e)));
  const hooks = (): number => HOOKED.reduce((a, e) => a + proc.listenerCount(e), 0);
  return { input, output, proc, term, events, hooks };
}

const frame = (...t: string[]): Row[] => t.map((s) => [run(s)]);

describe("Terminal", () => {
  it("takes over the terminal on start and gives it back in reverse order on stop", () => {
    const { input, output, term, proc, hooks } = setup();
    term.start();
    expect(input.raw).toEqual([true]);
    expect(input.flowing).toBe(true);
    expect(output.data).toBe(ENTER_SEQ);
    for (const m of ["?1049h", "?25l", "?1000h", "?1006h", "?2004h"]) expect(output.data).toContain(`${E}[${m}`);
    expect(HOOKED.map((e) => proc.listenerCount(e))).toEqual([1, 1, 1, 1, 1]);
    expect(input.listenerCount("data")).toBe(1);
    expect(output.listenerCount("resize")).toBe(1);
    expect(term.active).toBe(true);

    output.data = "";
    term.stop();
    expect(output.data).toBe(LEAVE_SEQ);
    const at = ["?2004l", "?1006l", "?1000l", "?25h", "?1049l"].map((m) => output.data.indexOf(`${E}[${m}`));
    expect(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]!))).toBe(true);
    expect(input.raw).toEqual([true, false]);
    expect(input.flowing).toBe(false);
    expect(hooks()).toBe(0);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("resize")).toBe(0);

    term.stop();
    expect(output.data).toBe(LEAVE_SEQ);
    term.start();
    term.start();
    expect(hooks()).toBe(5);
    term.stop();
    expect(hooks()).toBe(0);
  });

  it("delivers parsed input and draws frames with row diffing", () => {
    const { input, output, term, events } = setup();
    term.start();
    input.emit("data", Buffer.from(`j${E}[A${E}[<0;5;3M`));
    expect(events).toEqual(["'j'", "up", "press:0@4,2"]);
    output.data = "";
    term.render(frame("ab", "cd"));
    expect(output.data).toContain(`${E}[2J`);
    expect(output.data).toContain(`${E}[2;1H`);
    output.data = "";
    term.render(frame("ab", "cd"));
    expect(output.data).toBe("");
    term.render(frame("ab", "cX"));
    expect(output.data).toBe(`${E}[?2026h${E}[2;1H${encodeRow([run("cX")])}${E}[?2026l`);
    term.stop();
    output.data = "";
    term.render(frame("zz", "zz"));
    input.emit("data", "k");
    expect(output.data).toBe("");
    expect(events).toEqual(["'j'", "up", "press:0@4,2"]);
  });

  it("reports resizes and repaints fully after one", () => {
    const { output, term } = setup();
    const sizes: TermSize[] = [];
    term.onResize((s) => sizes.push(s));
    term.start();
    expect(term.size()).toEqual({ w: 120, h: 40 });
    term.render(frame("ab"));
    output.columns = 100;
    output.rows = 30;
    output.emit("resize");
    expect(sizes).toEqual([{ w: 100, h: 30 }]);
    output.data = "";
    term.render(frame("ab"));
    expect(output.data).toContain(`${E}[2J`);
    term.stop();
  });

  it("suspends for a child process, then restores and repaints the last frame", () => {
    const { input, output, term, events, hooks } = setup();
    term.start();
    term.render(frame("one", "two"));
    output.data = "";
    const r = term.suspend(() => {
      expect(term.active).toBe(false);
      expect(input.raw.at(-1)).toBe(false);
      expect(output.data).toBe(LEAVE_SEQ);
      expect(input.listenerCount("data")).toBe(0);
      input.emit("data", "q"); // the child's keys are not ours
      term.render(frame("uno", "dos"));
      expect(output.data).toBe(LEAVE_SEQ);
      return 7;
    });
    expect(r).toBe(7);
    expect(term.active).toBe(true);
    expect(input.raw.at(-1)).toBe(true);
    expect(output.data.startsWith(LEAVE_SEQ + ENTER_SEQ)).toBe(true);
    expect(output.data).toContain(`${E}[2J`);
    expect(stripSgr(output.data)).toContain(`${E}[2;1Hdos`);
    input.emit("data", "x");
    expect(events).toEqual(["'x'"]);
    expect(hooks()).toBe(5);
    term.stop();
    expect(hooks()).toBe(0);
  });

  it("restores after an async child and after a child that throws", async () => {
    const { input, term } = setup();
    term.start();
    const v = await term.suspend(async () => {
      await Promise.resolve();
      expect(term.active).toBe(false);
      return "done";
    });
    expect(v).toBe("done");
    expect(term.active).toBe(true);
    expect(input.raw).toEqual([true, false, true]);
    expect(() =>
      term.suspend(() => {
        throw new Error("spawn failed");
      }),
    ).toThrow("spawn failed");
    expect(term.active).toBe(true);
    expect(input.raw.at(-1)).toBe(true);
    term.stop();
  });

  it("reports a resize that happened while suspended", () => {
    const { output, term } = setup();
    const sizes: TermSize[] = [];
    term.onResize((s) => sizes.push(s));
    term.start();
    term.suspend(() => {
      output.columns = 90;
      output.emit("resize");
      expect(sizes).toEqual([]);
    });
    expect(sizes).toEqual([{ w: 90, h: 40 }]);
    term.stop();
  });

  it("restores on fatal signals and re-raises them, but ignores Ctrl-C meant for a child", () => {
    const { input, output, term, proc, hooks } = setup();
    term.start();
    term.suspend(() => {
      proc.emit("SIGINT");
      expect(proc.kills).toEqual([]);
    });
    proc.emit("SIGINT"); // delivered just after the child returned
    expect(proc.kills).toEqual([]);
    expect(term.active).toBe(true);
    proc.emit("SIGTERM");
    expect(proc.kills).toEqual([[4242, "SIGTERM"]]);
    expect(term.active).toBe(false);
    expect(hooks()).toBe(0);
    expect(input.raw.at(-1)).toBe(false);
    expect(output.data.endsWith(LEAVE_SEQ)).toBe(true);

    for (const sig of ["SIGINT", "SIGHUP"]) {
      const s = setup();
      s.term.start();
      s.proc.emit(sig);
      expect(s.proc.kills).toEqual([[4242, sig]]);
      expect(s.output.data.endsWith(LEAVE_SEQ)).toBe(true);
      expect(s.hooks()).toBe(0);
    }
  });

  it("restores on process exit and on a crash without changing how Node handles it", () => {
    for (const [event, args] of [
      ["exit", [0]],
      ["uncaughtExceptionMonitor", [new Error("boom"), "unhandledRejection"]],
    ] as const) {
      const s = setup();
      s.term.start();
      s.proc.emit(event, ...args);
      expect(s.output.data.endsWith(LEAVE_SEQ)).toBe(true);
      expect(s.input.raw).toEqual([true, false]);
      expect(s.hooks()).toBe(0);
      expect(s.proc.kills).toEqual([]);
    }
  });

  it("undoes a failed start", () => {
    const { input, term, hooks } = setup();
    input.setRawMode = () => {
      throw new Error("EIO");
    };
    expect(() => term.start()).toThrow("EIO");
    expect(hooks()).toBe(0);
    expect(term.active).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });
});
