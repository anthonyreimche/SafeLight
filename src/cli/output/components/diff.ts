// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Before → after, one changed value a row: the old value muted, the new one
// strong, and where there is room the slider with a hollow thumb where the
// value was and a solid one where it is now.

import { valueParts } from "../format";
import type { Look } from "../look";
import type { ResultChange } from "../types";
import { hasRange, sliderBar, sliderDefault } from "./bar";
import { grid } from "./table";

export interface DiffOptions {
  /** Cells for each row's slider; 0 leaves the bars out. */
  cells: number;
  /** 0…1 along the way from before to after, for the tween; 1 is the finished row. */
  t?: number;
}

const COLUMNS = [{}, { align: "right" as const }, { gap: 1 }, { gap: 1 }, {}, { gap: 2 }];

export function valueDiff(changes: readonly ResultChange[], look: Look, options: DiffOptions): string[] {
  const { glyphs, theme } = look;
  const t = options.t ?? 1;
  const arrow = theme.paint("faint", glyphs.arrow);

  const rows = changes.map((change) => {
    const { info } = change;
    if (!info || change.after === undefined) return [glyphs.fold(change.label), "", "", glyphs.fold(change.value)];

    const numeric = typeof change.before === "number" && typeof change.after === "number";
    const shown = numeric && t < 1
      ? (change.before as number) + ((change.after as number) - (change.before as number)) * t
      : change.after;
    const after = valueParts(info, shown, glyphs);
    const landsOnDefault = typeof change.after === "number" && change.after === sliderDefault(info) && info.default !== undefined;
    const now = theme.paint(landsOnDefault ? "muted" : "strong", after.text) + theme.paint("muted", after.unit);
    const before = change.before === undefined ? "" : theme.paint("muted", valueParts(info, change.before, glyphs).text);

    const bar = numeric && options.cells > 0 && hasRange(info)
      ? sliderBar({ info, value: shown as number, was: change.before as number, cells: options.cells }, look)
      : "";
    const note = change.clamped ? theme.paint("amber", "limit") : landsOnDefault ? theme.paint("muted", "default") : "";
    return [info.key, before, before ? arrow : "", now, bar, note];
  });
  return grid(rows, COLUMNS);
}
