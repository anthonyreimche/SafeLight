// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The line of keys under whatever is asking: at most five, most useful first,
// dropping from the right when there isn't room.

import type { Look } from "../look";
import { cells } from "../width";

export type KeyHint = readonly [keys: string, does: string];

const MOST = 5;

export function keyHints(hints: readonly KeyHint[], width: number, look: Look): string {
  const { glyphs, theme } = look;
  const parts = hints.slice(0, MOST).map(([keys, does]) => {
    const shown = glyphs.name === "ascii" ? keys.replace("↑↓", "up/down").replace("← →", "left/right").replace("↑", "up") : keys;
    return does ? `${shown} ${theme.paint("muted", does)}` : shown;
  });
  while (parts.length > 1 && cells(parts.join(glyphs.dot)) > width) parts.pop();
  return parts.join(theme.paint("faint", glyphs.dot));
}
