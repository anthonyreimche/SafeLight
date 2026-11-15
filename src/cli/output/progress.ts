// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one progress line: a label, a count and a thin bar, redrawn in place on
// stderr and gone when the work is done.

import { truncateEnd } from "./format";
import { visibleWidth } from "./palette";
import type { Style } from "./palette";
import type { ProgressState } from "./types";

const BAR_CELLS = 20;
/** Narrower than this and the bar is left out. */
const BAR_FROM_WIDTH = 60;

export function progressText(p: ProgressState, style: Style): string {
  const { palette, glyphs, width } = style;
  const total = Math.max(0, Math.floor(p.total));
  const done = Math.min(Math.max(0, Math.floor(p.done)), total);
  const count = total > 0 ? `${String(done).padStart(String(total).length)}/${total}` : "";
  const withBar = total > 0 && width >= BAR_FROM_WIDTH;
  // One column stays free: a line that reaches the last column wraps on some terminals.
  const room = width - 1 - (count ? count.length + 2 : 0) - (withBar ? BAR_CELLS + 2 : 0);
  const parts = [truncateEnd(glyphs.fold(p.label), Math.max(8, room), glyphs)];
  if (count) parts.push(palette.dim(count));
  if (withBar) {
    const filled = Math.round((done / total) * BAR_CELLS);
    parts.push(palette.accent(glyphs.barDone.repeat(filled)) + palette.dim(glyphs.barLeft.repeat(BAR_CELLS - filled)));
  }
  return parts.join("  ");
}

export interface ProgressWriter {
  show(text: string): void;
  /** Wipes the line. Safe to call when none is showing. */
  clear(): void;
}

/** Redraws with `\r` and spaces only, so it also works where escape codes don't. */
export function createProgressWriter(stream: NodeJS.WriteStream): ProgressWriter {
  let showing = 0;
  return {
    show(text: string) {
      if (stream.isTTY !== true) return;
      const size = visibleWidth(text);
      stream.write(`\r${text}${" ".repeat(Math.max(0, showing - size))}`);
      showing = size;
    },
    clear() {
      if (showing === 0) return;
      stream.write(`\r${" ".repeat(showing)}\r`);
      showing = 0;
    },
  };
}
