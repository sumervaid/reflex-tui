// Terminal input: raw bytes to key, mouse and paste events. The parser works on bytes so it can
// resume anywhere a chunk was split (inside an escape sequence or a UTF-8 character) and so legacy
// mouse reports with high coordinates decode. Anything it does not understand is dropped whole:
// unknown sequences never leak their bytes as typed characters.

export type KeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "tab"
  | "backtab"
  | "escape"
  | "backspace"
  | "delete"
  | "insert"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "space"
  /** Printable text; `ch` holds the character. */
  | "char"
  /** Ctrl plus a letter, e.g. "ctrl-c", "ctrl-d", "ctrl-l". */
  | `ctrl-${string}`;

/**
 * A key press. `ch` is set only for "char" (the character) and "space" (" "). Alt+key arrives as
 * the key with `alt` set; modifiers on arrows and editing keys come from the terminal's encoding.
 */
export type KeyEvent = { type: "key"; name: KeyName; ch?: string; ctrl: boolean; alt: boolean; shift: boolean };

export type MouseAction = "press" | "release" | "wheelup" | "wheeldown" | "move";

/**
 * A mouse report (SGR 1006, or legacy X10). `x`/`y` are 0-based screen cells. `button` is 0 left,
 * 1 middle, 2 right, 3 none (a move with no button held, an X10 release), 4/5 wheel up/down.
 */
export type MouseEvent = { type: "mouse"; action: MouseAction; button: number; x: number; y: number; ctrl: boolean; alt: boolean; shift: boolean };

/** A bracketed paste. Line breaks are "\n"; other control characters are kept, so sanitize before display. */
export type PasteEvent = { type: "paste"; text: string };

export type InputEvent = KeyEvent | MouseEvent | PasteEvent;

/** How long a lone ESC waits for the rest of an escape sequence before it counts as the Escape key. */
export const ESC_TIMEOUT_MS = 40;
/** A paste whose end marker never arrives is closed after this much silence. */
export const PASTE_TIMEOUT_MS = 1000;
/** Pasted bytes beyond this are dropped. */
const MAX_PASTE = 1 << 20;

const PASTE_END = "\x1b[201~";
const REPLACEMENT = String.fromCharCode(0xfffd);

const SS3: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", M: "enter" };
const CSI_FINAL: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "backtab" };
const CSI_TILDE: Record<number, KeyName> = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

type Mods = { ctrl?: boolean; alt?: boolean; shift?: boolean; ch?: string };

const key = (name: KeyName, o: Mods = {}): KeyEvent => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...o });

/** xterm modifier parameter ("5" in CSI 1;5A): 1 + shift(1) + alt(2) + ctrl(4) + meta(8). */
function modifiers(param: string | undefined): Mods {
  const m = Number(param) - 1;
  if (!(m > 0)) return {};
  return { shift: (m & 1) !== 0, alt: (m & 10) !== 0, ctrl: (m & 4) !== 0 };
}

function mouse(b: number, x: number, y: number, release: boolean): MouseEvent | undefined {
  if (b < 0 || x < 0 || y < 0 || b & 128) return undefined; // malformed, or extra buttons 8-11
  const mods = { shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0 };
  const low = b & 3;
  let action: MouseAction;
  let button = low;
  if (b & 64) {
    if (low > 1) return undefined; // horizontal wheel
    action = low === 0 ? "wheelup" : "wheeldown";
    button = 4 + low;
  } else if (b & 32) action = "move";
  else if (release || low === 3) action = "release";
  else action = "press";
  return { type: "mouse", action, button, x, y, ...mods };
}

const isInt = (v: number | undefined): v is number => v !== undefined && Number.isInteger(v);

/** Length of the longest tail of `s` (from `from` on) that is a proper prefix of `m`. */
function partialTail(s: string, from: number, m: string): number {
  for (let k = Math.min(m.length - 1, s.length - from); k > 0; k--) if (s.endsWith(m.slice(0, k))) return k;
  return 0;
}

/** `n` bytes consumed and the event they made, if any; null when the bytes so far are an incomplete sequence. */
type Step = { n: number; ev?: InputEvent | undefined } | null;

/**
 * Streaming input parser. `feed` returns the events that are complete; an incomplete tail (a lone
 * ESC, half an escape sequence or UTF-8 character, an open paste) waits for the next chunk.
 * `flush` resolves the tail: a lone ESC is the Escape key, an open paste ends, the rest is dropped.
 */
export class InputParser {
  /** Unparsed bytes, one char per byte (latin1). */
  private buf = "";
  /** Bytes of the paste in progress, or null outside a paste. */
  private paste: string | null = null;

  /** Something waits for more input or a `flush`. */
  get pending(): boolean {
    return this.buf.length > 0 || this.paste !== null;
  }

  /** Inside a bracketed paste. */
  get pasting(): boolean {
    return this.paste !== null;
  }

  feed(chunk: Uint8Array | string): InputEvent[] {
    this.buf += (typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)).toString("latin1");
    return this.drain(false);
  }

  flush(): InputEvent[] {
    return this.drain(true);
  }

  reset(): void {
    this.buf = "";
    this.paste = null;
  }

  private drain(final: boolean): InputEvent[] {
    const out: InputEvent[] = [];
    const s = this.buf;
    let i = 0;
    while (i < s.length || (final && this.paste !== null)) {
      if (this.paste !== null) {
        const end = s.indexOf(PASTE_END, i);
        if (end >= 0) {
          this.addPaste(s.slice(i, end));
          i = end + PASTE_END.length;
          out.push(this.endPaste());
          continue;
        }
        if (final) {
          this.addPaste(s.slice(i));
          i = s.length;
          out.push(this.endPaste());
          break;
        }
        // Keep a possibly split end marker for the next chunk.
        const keep = partialTail(s, i, PASTE_END);
        this.addPaste(s.slice(i, s.length - keep));
        i = s.length - keep;
        break;
      }
      const st = this.step(s, i, final);
      if (!st) break;
      i += st.n;
      if (st.ev) out.push(st.ev);
    }
    this.buf = s.slice(i);
    return out;
  }

  private addPaste(bytes: string): void {
    const p = this.paste ?? "";
    this.paste = p.length >= MAX_PASTE ? p : (p + bytes).slice(0, MAX_PASTE);
  }

  private endPaste(): PasteEvent {
    const text = Buffer.from(this.paste ?? "", "latin1")
      .toString("utf8")
      .replace(/\r\n?/g, "\n");
    this.paste = null;
    return { type: "paste", text };
  }

  private step(s: string, i: number, final: boolean): Step {
    const c = s.charCodeAt(i);
    if (c === 0x1b) return this.esc(s, i, final);
    // Raw-mode terminals send \r for Enter; \n is Ctrl-J. Both are Enter, one byte each, so the
    // result never depends on where a chunk was split.
    if (c === 0x0d || c === 0x0a) return { n: 1, ev: key("enter") };
    if (c === 0x09) return { n: 1, ev: key("tab") };
    if (c === 0x7f || c === 0x08) return { n: 1, ev: key("backspace") };
    if (c === 0x20) return { n: 1, ev: key("space", { ch: " " }) };
    if (c >= 0x01 && c <= 0x1a) return { n: 1, ev: key(`ctrl-${String.fromCharCode(c + 0x60)}`, { ctrl: true }) };
    if (c < 0x20) return { n: 1 }; // NUL and Ctrl+\ ] ^ _
    if (c < 0x7f) return { n: 1, ev: key("char", { ch: s[i]! }) };
    return this.utf8(s, i, final);
  }

  private utf8(s: string, i: number, final: boolean): Step {
    const c = s.charCodeAt(i);
    const len = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    if (!len) return { n: 1 }; // stray continuation byte, raw C1 byte or invalid lead byte
    for (let k = 1; k < len; k++) {
      if (i + k >= s.length) return final ? { n: k } : null;
      if ((s.charCodeAt(i + k) & 0xc0) !== 0x80) return { n: k }; // broken: drop it, resume at this byte
    }
    const ch = Buffer.from(s.slice(i, i + len), "latin1").toString("utf8");
    const cp = ch.codePointAt(0) ?? 0;
    if (ch.includes(REPLACEMENT) || (cp >= 0x80 && cp <= 0x9f)) return { n: len }; // overlong, surrogate or C1
    return { n: len, ev: key("char", { ch }) };
  }

  private esc(s: string, i: number, final: boolean): Step {
    if (i + 1 >= s.length) return final ? { n: 1, ev: key("escape") } : null;
    const c1 = s[i + 1];
    if (c1 === "[") return this.csi(s, i, final);
    if (c1 === "O") return this.ss3(s, i, final);
    if (c1 === "\x1b") return { n: 1, ev: key("escape") };
    // ESC + key is Alt+key.
    const st = this.step(s, i + 1, final);
    if (!st) return null;
    if (st.ev?.type === "key") st.ev.alt = true;
    return { n: st.n + 1, ev: st.ev };
  }

  private ss3(s: string, i: number, final: boolean): Step {
    const altO = { n: 2, ev: key("char", { ch: "O", alt: true }) };
    if (i + 2 >= s.length) return final ? altO : null;
    const f = s.charCodeAt(i + 2);
    if (f < 0x40 || f > 0x7e) return altO;
    const name = SS3[s[i + 2]!];
    return { n: 3, ev: name ? key(name) : undefined };
  }

  private csi(s: string, i: number, final: boolean): Step {
    let j = i + 2;
    if (s[j] === "M") {
      // Legacy X10 mouse: ESC [ M then button, x, y as single bytes offset by 32.
      if (s.length < j + 4) return final ? { n: s.length - i } : null;
      const ev = mouse(s.charCodeAt(j + 1) - 32, s.charCodeAt(j + 2) - 33, s.charCodeAt(j + 3) - 33, false);
      return { n: j + 4 - i, ev };
    }
    for (; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      // Not a parameter or intermediate byte: the sequence is broken; drop it and resume here.
      if (c < 0x20 || c > 0x3f) return { n: j - i };
    }
    if (j >= s.length) {
      if (!final) return null;
      return j === i + 2 ? { n: 2, ev: key("char", { ch: "[", alt: true }) } : { n: s.length - i };
    }
    return { n: j + 1 - i, ev: this.csiEvent(s.slice(i + 2, j), s[j]!) };
  }

  private csiEvent(p: string, f: string): InputEvent | undefined {
    if (p.startsWith("<")) {
      if (f !== "M" && f !== "m") return undefined;
      const [b, x, y] = p.slice(1).split(";").map(Number);
      if (!isInt(b) || !isInt(x) || !isInt(y)) return undefined;
      return mouse(b, x - 1, y - 1, f === "m");
    }
    if (!/^[\d;]*$/.test(p)) return undefined; // private replies (device attributes, ...) we never asked for
    const parts = p.split(";");
    const mods = modifiers(parts[1]);
    if (f === "~") {
      const code = Number(parts[0]);
      if (code === 200) {
        this.paste = "";
        return undefined;
      }
      const name = CSI_TILDE[code];
      return name ? key(name, mods) : undefined;
    }
    const name = CSI_FINAL[f];
    if (!name) return undefined;
    return key(name, f === "Z" ? { ...mods, shift: true } : mods);
  }
}

/**
 * Feeds stream chunks to an `InputParser` and hands each event to `emit`. A lone ESC becomes the
 * Escape key after `escMs` without more input; an unterminated paste is closed after `pasteMs`.
 */
export class InputReader {
  readonly parser = new InputParser();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly emit: (e: InputEvent) => void,
    private readonly escMs = ESC_TIMEOUT_MS,
    private readonly pasteMs = PASTE_TIMEOUT_MS,
  ) {}

  feed(chunk: Uint8Array | string): void {
    if (this.disposed) return;
    this.cancel();
    const events = this.parser.feed(chunk);
    if (this.parser.pending) {
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.deliver(this.parser.flush());
        },
        this.parser.pasting ? this.pasteMs : this.escMs,
      );
      this.timer.unref?.();
    }
    this.deliver(events);
  }

  /** Stop delivering events and drop anything pending. */
  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.parser.reset();
  }

  private deliver(events: InputEvent[]): void {
    for (const e of events) {
      if (this.disposed) return;
      this.emit(e);
    }
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
