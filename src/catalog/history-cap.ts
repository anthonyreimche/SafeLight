// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An edit history grows by one snapshot per commit and is stored whole, so it is
// bounded: the seed, which every reset and "Original" view goes back to, plus a
// window of the entries around the cursor.

import { historyCursor } from "./history-cursor";
import type { EditState } from "./types";

/** `edit` with at most `cap` entries after its seed (stack[0], always kept). The
 *  window kept ends at the newest entry when that holds the cursor; else it starts
 *  at the cursor, so the redo tail just after it stays. The cursor stays on the
 *  snapshot it was on. A cap below 1 keeps 1; a fraction rounds down; Infinity or
 *  NaN bounds nothing. `edit` itself when nothing is dropped. */
export function compactHistory(edit: EditState, cap: number): EditState {
  const length = edit.stack.length;
  const size = Math.max(Math.floor(cap), 1);
  if (Number.isNaN(cap) || length - 1 <= size) return edit;
  const cursor = historyCursor(edit.currentIndex, length);
  const start = Math.max(Math.min(cursor, length - size), 1);
  return {
    ...edit,
    stack: [edit.stack[0], ...edit.stack.slice(start, start + size)],
    currentIndex: cursor === 0 ? 0 : cursor - start + 1,
  };
}
