// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The prompt's hold on the terminal: raw keys in, the live area painted in
// place. Each frame is one write inside synchronized output; the area's rows
// are counted as the terminal wraps them, so the next frame starts where this
// one did. Raw mode, bracketed paste and the cursor are always put back.

import { RESTORE_TERMINAL } from "../output/live";
import { cells } from "../output/width";
import type { PromptFrame } from "./view";
import { createKeyDecoder, type Key } from "./keys";

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const PASTE_ON = "\x1b[?2004h";
const ERASE_BELOW = "\x1b[J";
/** How long a lone escape waits for the rest of a sequence before it is the escape key. */
const ESCAPE_WAIT_MS = 30;

const up = (n: number): string => (n > 0 ? `\x1b[${n}A` : "");
const right = (n: number): string => (n > 0 ? `\x1b[${n}C` : "");

export interface TerminalStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface TerminalOptions {
  onKeys(keys: Key[]): void;
  onResize?(): void;
  /** Runs `restore` if the process exits while the terminal is held; returns the unsubscribe. */
  onExit?(restore: () => void): () => void;
}

export interface Terminal {
  /** Raw mode and bracketed paste on; keys go to onKeys. */
  start(): void;
  /** Replaces the live area with `frame`. */
  paint(frame: PromptFrame): void;
  /** Paints `rows` as the area's last frame and leaves them in scrollback, the cursor on the line below. */
  commit(rows: readonly string[]): void;
  /** Takes the live area off the screen, leaving the cursor where it started. */
  erase(): void;
  /** Clears the screen and scrollback; the next frame starts at the top. */
  clearScreen(): void;
  /** Raw mode off, paste off, cursor shown, keys no longer read. */
  stop(): void;
}

export function createTerminal(streams: TerminalStreams, options: TerminalOptions): Terminal {
  const { stdin, stdout } = streams;
  const decoder = createKeyDecoder();
  /** The physical row the cursor sits on, counted from the area's first row; null when nothing is painted. */
  let cursorRow: number | null = null;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let unsubscribeExit: (() => void) | null = null;

  const columns = (): number => (stdout.columns > 0 ? stdout.columns : 80);

  const deliver = (keys: Key[]): void => {
    if (keys.length > 0) options.onKeys(keys);
  };
  const onData = (chunk: Buffer | string): void => {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = null;
    deliver(decoder.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    if (decoder.pending()) {
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        deliver(decoder.flush());
      }, ESCAPE_WAIT_MS);
    }
  };
  const onResize = (): void => options.onResize?.();

  const restore = (): void => {
    stdout.write(RESTORE_TERMINAL);
    if (stdin.isTTY) stdin.setRawMode?.(false);
  };

  /** Moves to the area's first row and erases it and everything below. */
  const home = (): string => (cursorRow === null ? `\r${ERASE_BELOW}` : `${up(cursorRow)}\r${ERASE_BELOW}`);

  function layout(rows: readonly string[]): { heights: number[]; total: number } {
    const width = columns();
    const heights = rows.map((row) => Math.max(1, Math.ceil(cells(row) / width)));
    return { heights, total: heights.reduce((a, b) => a + b, 0) };
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (stdin.isTTY) stdin.setRawMode?.(true);
      stdin.setEncoding?.("utf8");
      stdin.on("data", onData);
      stdin.resume();
      stdout.on("resize", onResize);
      stdout.write(PASTE_ON);
      unsubscribeExit = options.onExit?.(restore) ?? null;
    },

    paint(frame) {
      const width = columns();
      const { heights, total } = layout(frame.rows);
      const before = heights.slice(0, frame.cursorRow).reduce((a, b) => a + b, 0);
      let row = before + Math.floor(frame.cursorCol / width);
      const col = frame.cursorCol % width;
      // A cursor just past a full-width row sits on a row the text never reached.
      const extra = row >= total ? "\r\n" : "";
      const last = row >= total ? total : total - 1;
      row = Math.min(row, last);
      stdout.write(
        SYNC_ON + HIDE_CURSOR + home() + frame.rows.join("\r\n") + extra
        + up(last - row) + "\r" + right(col) + SHOW_CURSOR + SYNC_OFF,
      );
      cursorRow = row;
    },

    commit(rows) {
      stdout.write(SYNC_ON + HIDE_CURSOR + home() + rows.map((r) => `${r}\r\n`).join("") + SHOW_CURSOR + SYNC_OFF);
      cursorRow = null;
    },

    erase() {
      if (cursorRow === null) return;
      stdout.write(home());
      cursorRow = null;
    },

    clearScreen() {
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      cursorRow = null;
    },

    stop() {
      if (!started) return;
      started = false;
      if (escapeTimer) clearTimeout(escapeTimer);
      stdin.off("data", onData);
      stdout.off("resize", onResize);
      stdin.pause();
      unsubscribeExit?.();
      restore();
    },
  };
}
