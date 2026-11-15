// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `view --terminal`: each new picture is drawn over the last one, on the same
// rows, while the picture and its caption are still the last thing on screen.
// Once anything else is printed below them, the next picture starts anew.

import { DEFAULT_CELL, type CellSize } from "../terminal-image";
import type { GraphicsMode } from "../types";

const ERASE_LINE = "\x1b[2K";
const ERASE_BELOW = "\x1b[J";

/** A picture encoded for the terminal, the rows it takes, and the caption line under it. */
export interface TerminalPicture { bytes: Uint8Array; rows: number; caption: string }

export interface TerminalLive {
  show(picture: TerminalPicture): void;
  /** Something else was printed below the picture: the next one is printed anew. */
  moved(): void;
}

/** The text rows a frame takes once drawn: a block is two pixels tall, an image is as tall as its cells. */
export function pictureRows(mode: Exclude<GraphicsMode, "none">, frame: { width: number; height: number }, cell: CellSize | undefined): number {
  if (mode === "blocks") return Math.ceil(frame.height / 2);
  return Math.max(1, Math.ceil(frame.height / (cell ?? DEFAULT_CELL).height));
}

export function createTerminalLive(write: (chunk: Uint8Array | string) => void): TerminalLive {
  /** The rows the picture on screen takes, caption included; null when there is none to draw over. */
  let drawn: number | null = null;

  return {
    show(picture) {
      const rows = picture.rows + 1;
      // Every encoder ends with a newline, so the cursor is at the start of the row under the picture.
      if (drawn !== null) write(`\x1b[${drawn}A\r${drawn === rows ? "" : ERASE_BELOW}`);
      write(picture.bytes);
      write(`${ERASE_LINE}${picture.caption}\n`);
      drawn = rows;
    },
    moved() {
      drawn = null;
    },
  };
}
