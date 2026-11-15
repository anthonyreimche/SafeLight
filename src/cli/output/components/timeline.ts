// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo's history as a timeline, oldest at the top so the newest step sits
// nearest the prompt. Steps past the current one were undone: a dashed stem
// and hollow nodes say so, and that the next change drops them.

import type { Look } from "../look";
import type { HistoryRow } from "../types";
import { clip } from "../width";
import { grid } from "./table";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** "Today", "Yesterday", "Nov 12", or "Nov 12, 2025" for another year; empty when the time isn't known. */
export function dayName(ms: number, now: number): string {
  if (!(ms > 0)) return "";
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

function clockTime(ms: number): string {
  if (!(ms > 0)) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function timeline(rows: readonly HistoryRow[], now: number, look: Look): string[] {
  const { glyphs, theme } = look;
  const steps = [...rows].sort((a, b) => a.index - b.index);
  const currentAt = steps.findIndex((row) => row.current);
  const labelRoom = Math.max(12, look.width - 30);

  const table = grid(steps.map((row, i) => {
    const undone = currentAt >= 0 && i > currentAt;
    const label = clip(glyphs.fold(row.label), labelRoom, glyphs.ellipsis);
    if (row.current) {
      return [theme.paint("amber", glyphs.nodeHere), String(row.index), theme.paint("strong", label), theme.paint("muted", clockTime(row.timestamp)), theme.paint("amber", "you are here")];
    }
    const tone = undone ? "faint" : "muted";
    return [
      theme.paint(tone, undone ? glyphs.nodeUndone : glyphs.node),
      undone ? theme.paint("muted", String(row.index)) : String(row.index),
      undone ? theme.paint("muted", label) : label,
      theme.paint("muted", clockTime(row.timestamp)),
    ];
  }), [{}, { gap: 2, align: "right" }, { gap: 2 }, {}, {}]);

  const lines: string[] = [];
  let day = "";
  steps.forEach((row, i) => {
    const name = dayName(row.timestamp, now);
    const firstUndone = currentAt >= 0 && i === currentAt + 1;
    if (name !== day) {
      if (lines.length > 0) lines.push(theme.paint(firstUndone ? "faint" : "muted", firstUndone ? glyphs.stemUndone : glyphs.stem));
      if (name) lines.push(theme.paint("muted", name));
      day = name;
    } else if (firstUndone) {
      lines.push(theme.paint("faint", glyphs.stemUndone));
    }
    lines.push(table[i]);
  });
  return lines;
}
