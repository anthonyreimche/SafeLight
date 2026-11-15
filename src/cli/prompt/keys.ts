// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Raw terminal bytes to keys. Covers xterm's CSI and SS3 forms, the
// cygwin-style sequences libuv makes from Windows console key events (alt as
// an escape prefix, `ESC [ 1 ~` for home), CSI u, and bracketed paste.

export type Key =
  | { kind: "text"; text: string }
  | { kind: "paste"; text: string }
  | { kind: "key"; name: string; ctrl: boolean; alt: boolean; shift: boolean };

export interface KeyDecoder {
  feed(chunk: string): Key[];
  /** After a quiet spell: what is held (a lone escape) is read as typed. */
  flush(): Key[];
  pending(): boolean;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const ARROWS: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", E: "clear", G: "clear" };
const SS3_FKEYS: Record<string, string> = { P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE: Record<string, string> = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
  11: "f1", 12: "f2", 13: "f3", 14: "f4", 15: "f5", 17: "f6", 18: "f7", 19: "f8", 20: "f9", 21: "f10", 23: "f11", 24: "f12",
};
// libuv's Windows table sends F1–F5 as `ESC [ [ A`…`E`, as the Linux console does.
const DOUBLE_BRACKET: Record<string, string> = { A: "f1", B: "f2", C: "f3", D: "f4", E: "f5" };
const CSI_U: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace" };

const named = (name: string, ctrl = false, alt = false, shift = false): Key => ({ kind: "key", name, ctrl, alt, shift });

/** xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4) (+ meta(8), read as alt). */
function withModifier(name: string, param: string | undefined): Key {
  const bits = Math.max(0, Number(param ?? "1") - 1);
  return named(name, (bits & 4) !== 0, (bits & 10) !== 0, (bits & 1) !== 0);
}

/** One control byte (below 0x20, or DEL) as a key. */
function controlKey(code: number): Key | null {
  if (code === 0x0d || code === 0x0a) return named("enter");
  if (code === 0x09) return named("tab");
  if (code === 0x7f || code === 0x08) return named("backspace");
  if (code === 0x00) return named("space", true);
  if (code >= 0x01 && code <= 0x1a) return named(String.fromCharCode(code + 0x60), true);
  return null;
}

const isFinalByte = (ch: string): boolean => ch >= "\x40" && ch <= "\x7e";

type Step = { keys: Key[]; length: number } | "more";

/** Reads the CSI sequence starting at `at` (which points at `ESC [`). */
function readCsi(buf: string, at: number): Step {
  let i = at + 2;
  if (i >= buf.length) return "more";
  if (buf[i] === "[") {
    if (i + 1 >= buf.length) return "more";
    const name = DOUBLE_BRACKET[buf[i + 1]];
    return { keys: name ? [named(name)] : [], length: 4 };
  }
  while (i < buf.length && !isFinalByte(buf[i])) i++;
  if (i >= buf.length) return "more";
  const final = buf[i];
  const params = buf.slice(at + 2, i).split(";");
  const length = i + 1 - at;
  if (final === "~") {
    const name = TILDE[params[0]];
    return { keys: name ? [withModifier(name, params[1])] : [], length };
  }
  if (final === "Z") return { keys: [named("tab", false, false, true)], length };
  if (final === "u") {
    const code = Number(params[0]);
    const name = CSI_U[code] ?? (code >= 32 ? String.fromCodePoint(code).toLowerCase() : undefined);
    return { keys: name ? [withModifier(name, params[1])] : [], length };
  }
  const arrow = ARROWS[final];
  if (arrow) return { keys: [withModifier(arrow, params.length > 1 ? params[1] : undefined)], length };
  return { keys: [], length };
}

function readSs3(buf: string, at: number): Step {
  let i = at + 2;
  while (i < buf.length && buf[i] >= "0" && buf[i] <= "9") i++;
  if (i >= buf.length) return "more";
  const modifier = buf.slice(at + 2, i) || undefined;
  const name = ARROWS[buf[i]] ?? SS3_FKEYS[buf[i]];
  return { keys: name ? [withModifier(name, modifier)] : [], length: i + 1 - at };
}

/** The key or sequence at `at`, which holds an escape. */
function readEscape(buf: string, at: number): Step {
  if (at + 1 >= buf.length) return "more";
  const next = buf[at + 1];
  if (next === "[") return readCsi(buf, at);
  if (next === "O") return readSs3(buf, at);
  if (next === "\x1b") {
    // Alt plus a key that is itself a sequence (libuv on Windows: ESC ESC [ D).
    if (at + 2 >= buf.length) return "more";
    if (buf[at + 2] !== "[" && buf[at + 2] !== "O") return { keys: [named("escape", false, true)], length: 2 };
    const inner = readEscape(buf, at + 1);
    if (inner === "more") return "more";
    return {
      keys: inner.keys.map((k) => (k.kind === "key" ? { ...k, alt: true } : k)),
      length: inner.length + 1,
    };
  }
  const code = next.charCodeAt(0);
  const control = controlKey(code);
  if (control && control.kind === "key") return { keys: [{ ...control, alt: true }], length: 2 };
  const lower = next.toLowerCase();
  return { keys: [named(lower, false, true, lower !== next)], length: 2 };
}

const foldNewlines = (text: string): string => text.replace(/\r\n?/g, "\n");

export function createKeyDecoder(): KeyDecoder {
  let held = "";
  let paste: string | null = null;

  function decode(final: boolean): Key[] {
    const keys: Key[] = [];
    const buf = held;
    held = "";
    let i = 0;
    while (i < buf.length) {
      if (paste !== null) {
        const end = buf.indexOf(PASTE_END, i);
        if (end < 0) {
          // Keep a tail that may be the start of the end marker.
          let keep = 0;
          for (let n = Math.min(PASTE_END.length - 1, buf.length - i); n > 0; n--) {
            if (PASTE_END.startsWith(buf.slice(buf.length - n))) { keep = n; break; }
          }
          paste += buf.slice(i, buf.length - keep);
          held = buf.slice(buf.length - keep);
          return keys;
        }
        keys.push({ kind: "paste", text: foldNewlines(paste + buf.slice(i, end)) });
        paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = buf[i];
      if (ch === "\x1b") {
        if (buf.startsWith(PASTE_START, i)) {
          paste = "";
          i += PASTE_START.length;
          continue;
        }
        const step = readEscape(buf, i);
        if (step === "more") {
          if (!final) {
            held = buf.slice(i);
            return keys;
          }
          keys.push(named("escape"));
          i++;
          continue;
        }
        keys.push(...step.keys);
        i += step.length;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        const control = controlKey(code);
        if (control) keys.push(control);
        i += code === 0x0d && buf[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      let end = i + 1;
      while (end < buf.length) {
        const c = buf.charCodeAt(end);
        if (c < 0x20 || c === 0x7f) break;
        end++;
      }
      keys.push({ kind: "text", text: buf.slice(i, end) });
      i = end;
    }
    return keys;
  }

  return {
    feed(chunk) {
      held += chunk;
      return decode(false);
    },
    flush() {
      if (held === "" || paste !== null) return [];
      return decode(true);
    },
    pending: () => held !== "" && paste === null,
  };
}
