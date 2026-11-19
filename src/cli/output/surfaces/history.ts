// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `history <photo>` on a terminal: where the photo is, the timeline, and the
// two commands that move along it.

import { timeline } from "../components/timeline";
import { joinDots, paintCommand } from "../look";
import type { Look } from "../look";
import type { HistoryRow } from "../types";

export function historyLines(rows: readonly HistoryRow[], photo: string | undefined, now: number, look: Look): string[] {
  const { theme } = look;
  if (rows.length === 0) return [theme.paint("muted", "No steps yet.")];
  const steps = [...rows].sort((a, b) => a.index - b.index);
  const at = steps.findIndex((row) => row.current);
  const where = at >= 0 ? theme.paint("muted", `on step ${at + 1} of ${steps.length}`) : theme.paint("muted", `${steps.length} steps`);
  const lines = [joinDots([photo ? theme.paint("strong", photo) : "", where], look), "", ...timeline(steps, now, look)];

  if (photo && at >= 0) {
    const undone = steps.length - 1 - at;
    const moves = [
      at > 0 ? paintCommand(`undo ${photo}`, look) : "",
      undone > 0 ? paintCommand(`redo ${photo}${undone > 1 ? ` ${undone}` : ""}`, look) : "",
    ];
    if (moves.some((move) => move !== "")) lines.push("", joinDots(moves, look));
  }
  return lines;
}
