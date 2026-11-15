// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The live region: a few lines at the bottom that are redrawn in place while
// something is happening. Ordinary output scrolls above it, and nothing
// animated ever lands in scrollback half-drawn. Each frame is wrapped in
// synchronized output with the cursor hidden, and the terminal is always put
// back: on clear, on exit, on Ctrl+C and on a crash.

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ERASE_LINE = "\x1b[K";
const ERASE_BELOW = "\x1b[J";
const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

/** Shows the cursor, turns bracketed paste off and resets colour: what a terminal needs after anything live. */
export const RESTORE_TERMINAL = `${SHOW_CURSOR}\x1b[?2004l\x1b[0m`;

type Write = NodeJS.WriteStream["write"];

export interface LiveOptions {
  /** Wrap frames in synchronized output. */
  sync: boolean;
  /**
   * Called when something else writes to the stream while the region shows,
   * before that write lands; it should clear the region. Without it the
   * region lifts out of the way for the write and comes back after.
   */
  onIntrusion?: () => void;
}

export interface LiveRegion {
  /** Draws these lines in place of the last frame. Each must fit the terminal's width. */
  show(lines: readonly string[]): void;
  /** Takes the region off the screen. `leave` is printed where it was and stays in scrollback. */
  clear(leave?: readonly string[]): void;
  /** Runs `write` with the region lifted out of the way, then puts it back. */
  around(write: () => void): void;
  readonly showing: boolean;
}

const open = new Set<{ restore(): void }>();
let armed = false;

/** One exit handler for every region, so a crash mid-frame never leaves the cursor hidden. */
function arm(): void {
  if (armed) return;
  armed = true;
  process.once("exit", () => {
    for (const region of [...open]) region.restore();
  });
}

const up = (rows: number): string => (rows > 0 ? `\x1b[${rows}A` : "");

export function createLiveRegion(stream: NodeJS.WriteStream, options: LiveOptions): LiveRegion {
  let shown: readonly string[] = [];
  let original: Write | null = null;
  // Something else left a line unfinished (a question being asked), so the
  // region stays down until that line ends rather than draw over it.
  let displaced = false;

  const raw = (text: string): void => {
    (original ?? stream.write).call(stream, text);
  };
  const toTop = (): string => (shown.length > 0 ? `\r${up(shown.length - 1)}` : "\r");
  const frame = (lines: readonly string[]): string => {
    const body = lines.map((line) => line + ERASE_LINE).join("\n");
    const tail = lines.length < shown.length ? ERASE_BELOW : "";
    return (options.sync ? SYNC_ON : "") + HIDE_CURSOR + toTop() + body + tail + (options.sync ? SYNC_OFF : "");
  };
  const erase = (): void => {
    if (shown.length > 0) raw(toTop() + ERASE_BELOW);
    shown = [];
  };

  const handle = {
    restore(): void {
      if (options.onIntrusion) options.onIntrusion();
      region.clear();
    },
  };

  // Anything else that writes to this stream while the region shows would
  // land in the middle of it, so those writes are caught here.
  const guard = (): void => {
    if (original) return;
    original = stream.write;
    const intercepted = (...args: Parameters<Write>): boolean => {
      const write = original ?? stream.write;
      if (options.onIntrusion) {
        options.onIntrusion();
        region.clear();
        return (stream.write as (...a: Parameters<Write>) => boolean)(...args);
      }
      const text = typeof args[0] === "string" ? args[0] : "";
      const lines = shown;
      erase();
      const result = (write as (...a: Parameters<Write>) => boolean).apply(stream, args);
      displaced = !text.endsWith("\n");
      if (displaced) {
        // Whoever is typing an answer needs to see where.
        raw(SHOW_CURSOR);
      } else if (lines.length > 0) {
        raw(frame(lines));
        shown = lines;
      }
      return result;
    };
    stream.write = intercepted as Write;
    open.add(handle);
    arm();
  };
  const release = (): void => {
    if (!original) return;
    stream.write = original;
    original = null;
    open.delete(handle);
  };

  const region: LiveRegion = {
    show(lines) {
      if (lines.length === 0) {
        region.clear();
        return;
      }
      guard();
      if (displaced) return;
      raw(frame(lines));
      shown = lines;
    },
    clear(leave = []) {
      if (!original) return;
      const text = leave.map((line) => `${line}\n`).join("");
      raw((shown.length > 0 ? toTop() + ERASE_BELOW : "") + text + SHOW_CURSOR);
      shown = [];
      displaced = false;
      release();
    },
    around(write) {
      if (shown.length === 0) {
        write();
        return;
      }
      const lines = shown;
      erase();
      write();
      raw(frame(lines));
      shown = lines;
    },
    get showing() {
      return original !== null;
    },
  };
  return region;
}
