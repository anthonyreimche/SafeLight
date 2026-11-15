// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Aligned tables. Cells are laid out as plain text and styled afterwards, so
// colour never moves a column.

import type { Trust } from "../types";
import { formatRange, formatTimestamp, truncateEnd, truncateStart, valueParts } from "./format";
import type { Style } from "./palette";
import type { DoctorItem, ExtensionRow, HistoryRow, PhotoRow, SearchRow, ToolRow } from "./types";

export interface Column {
  align?: "left" | "right";
  /** Spaces before this column; 2 unless set. */
  gap?: number;
  style?: (text: string, row: number) => string;
  /**
   * Gives way when the table is wider than the terminal, losing its start or
   * its end. With several such columns the rightmost gives way first.
   */
  shrink?: "start" | "end";
  /** Narrowest the shrinking column goes. Below it the column is left out. */
  min?: number;
}

const length = (text: string): number => [...text].length;

export function alignColumns(
  rows: readonly (readonly string[])[],
  columns: readonly Column[],
  style: Pick<Style, "glyphs" | "width">,
): string[] {
  const cells = rows.map((row) => [...row]);
  const count = Math.max(0, ...cells.map((row) => row.length));
  const gaps = Array.from({ length: count }, (_, i) => (i === 0 ? 0 : columns[i]?.gap ?? 2));
  const widths = Array.from({ length: count }, (_, i) => Math.max(0, ...cells.map((row) => length(row[i] ?? ""))));

  for (let i = count - 1; i >= 0; i--) {
    const column = columns[i];
    const over = widths.reduce((sum, w, at) => sum + (w > 0 ? w + gaps[at] : 0), 0) - style.width;
    if (over <= 0) break;
    if (column?.shrink === undefined || widths[i] === 0) continue;
    const room = widths[i] - over;
    const fits = room >= (column.min ?? 8);
    const cut = column.shrink === "start" ? truncateStart : truncateEnd;
    for (const row of cells) {
      if (row[i] !== undefined) row[i] = fits ? cut(row[i], room, style.glyphs) : "";
    }
    widths[i] = fits ? room : 0;
  }

  const first = widths.findIndex((w) => w > 0);
  return cells.map((row, rowIndex) => {
    let last = -1;
    row.forEach((cell, i) => { if (cell !== "" && widths[i] > 0) last = i; });
    let line = "";
    for (let i = 0; i <= last; i++) {
      if (widths[i] === 0) continue;
      const text = row[i] ?? "";
      const pad = " ".repeat(widths[i] - length(text));
      const paint = columns[i]?.style;
      const styled = paint && text !== "" ? paint(text, rowIndex) : text;
      if (i > first) line += " ".repeat(gaps[i]);
      line += columns[i]?.align === "right" ? pad + styled : i === last ? styled : styled + pad;
    }
    return line;
  });
}

const STATE_NOTE: Record<NonNullable<ToolRow["state"]>, string> = {
  "in use": "",
  idle: "idle",
  off: "off",
  "not installed": "not installed, values kept",
};

/**
 * Tools in pipeline order, one value a line: the tool's name on its first row
 * only, numbers right-aligned against their unit, the changed mark in a column
 * of its own, and the range after it.
 */
export function toolTable(rows: readonly ToolRow[], style: Style): string {
  const { palette, glyphs } = style;
  const numbers = rows.flatMap((row) => row.values.map((v) => valueParts(v.info, v.value, glyphs))).filter((parts) => parts.numeric);
  const numberWidth = Math.max(0, ...numbers.map((parts) => length(parts.text)));
  const unitWidth = Math.max(0, ...numbers.map((parts) => length(parts.unit)));

  type Entry = { heading: string } | { cells: string[]; note: string };
  const entries: Entry[] = [];
  for (const row of rows) {
    const rangesUnknown = row.values.length > 0 && row.values.every((v) => v.info.rangeUnknown);
    const notes = [row.state ? STATE_NOTE[row.state] : "", rangesUnknown ? "ranges unknown" : ""].filter((n) => n !== "");
    const ownLine = notes.length > 0;
    if (ownLine) entries.push({ heading: `${palette.heading(row.tool)}  ${palette.dim(`(${notes.join(", ")})`)}` });
    else if (row.values.length === 0) entries.push({ heading: palette.heading(row.tool) });

    row.values.forEach((v, i) => {
      const parts = valueParts(v.info, v.value, glyphs);
      const value = parts.numeric ? parts.text.padStart(numberWidth) + parts.unit.padEnd(unitWidth) : parts.text;
      const note = glyphs.fold(v.note ?? (v.info.settable ? "" : v.info.notSettableReason ?? ""));
      const range = rangesUnknown ? "" : formatRange(v.info, glyphs);
      entries.push({
        cells: [
          i === 0 && !ownLine ? row.tool : "",
          v.info.key,
          value.trimEnd(),
          v.changed ? glyphs.changed : "",
          range,
        ],
        note,
      });
    });
  }

  // A note rides after its range only where the row has room for all of it.
  const table = entries.flatMap((entry) => ("cells" in entry ? [entry] : []));
  const widest = (column: number): number => Math.max(0, ...table.map((entry) => length(entry.cells[column])));
  const room = style.width - (widest(0) + 2 + widest(1) + 2 + widest(2) + (widest(3) > 0 ? 1 + widest(3) : 0) + 2);
  for (const { cells, note } of table) {
    const full = [cells[4], note].filter((part) => part !== "").join("  ");
    if (length(full) <= room || cells[4] === "") cells[4] = full;
  }

  const lines = alignColumns(
    table.map((entry) => entry.cells),
    [
      { style: palette.heading },
      {},
      {},
      { gap: 1, style: palette.accent },
      { style: palette.dim, shrink: "end", min: 8 },
    ],
    style,
  );
  let next = 0;
  return entries.map((entry) => ("cells" in entry ? lines[next++] : entry.heading)).join("\n");
}

function withHeader(header: readonly string[], rows: readonly (readonly string[])[], keep: readonly boolean[]): string[][] {
  const pick = (row: readonly string[]): string[] => row.filter((_, i) => keep[i]);
  return [pick(header), ...rows.map(pick)];
}

/** Styles the header row faint and leaves `body` to style the rest. */
function underHeader(style: Style, body?: (text: string, row: number) => string) {
  return (text: string, row: number): string => (row === 0 ? style.palette.dim(text) : body ? body(text, row - 1) : text);
}

export function photoTable(rows: readonly PhotoRow[], style: Style): string {
  if (rows.length === 0) return "";
  const { palette, glyphs } = style;
  const blank = glyphs.none;
  const body = rows.map((r) => [
    r.name,
    r.rating > 0 ? glyphs.star.repeat(r.rating) : blank,
    r.flag === "none" ? blank : r.flag,
    r.label === "" || r.label === "none" ? blank : r.label,
    r.edited ? "edited" : blank,
    glyphs.fold(r.size ?? ""),
  ]);
  const hasSize = rows.some((r) => r.size);
  const table = withHeader(["Photo", "Rating", "Flag", "Label", "Edited", "Size"], body, [true, true, true, true, true, hasSize]);
  const quiet = underHeader(style, (text) => (text === blank ? palette.dim(text) : text));
  return alignColumns(
    table,
    [{ style: underHeader(style), shrink: "start", min: 12 }, { style: quiet }, { style: quiet }, { style: quiet }, { style: quiet }, { style: palette.dim }],
    style,
  ).join("\n");
}

function trustBadge(style: Style) {
  return (text: string): string => {
    const trust = text as Trust;
    if (trust === "banned") return style.palette.error(text);
    return trust === "unverified" ? style.palette.accent(text) : text;
  };
}

export function extensionTable(rows: readonly ExtensionRow[], style: Style): string {
  if (rows.length === 0) return "";
  const { palette } = style;
  const body = rows.map((r) => [r.name, r.id, r.version, r.enabled ? "on" : "off", r.trust, r.update ? `${r.update} available` : ""]);
  const hasUpdate = rows.some((r) => r.update);
  const table = withHeader(["Extension", "Id", "Version", "State", "Trust", "Update"], body, [true, true, true, true, true, hasUpdate]);
  return alignColumns(
    table,
    [
      { style: underHeader(style, (text, row) => (rows[row].enabled ? text : palette.dim(text))), shrink: "end", min: 12 },
      { style: palette.dim, shrink: "end", min: Infinity },
      { style: underHeader(style) },
      { style: underHeader(style, (text) => (text === "off" ? palette.dim(text) : text)) },
      { style: underHeader(style, trustBadge(style)) },
      { style: underHeader(style) },
    ],
    style,
  ).join("\n");
}

export function searchTable(rows: readonly SearchRow[], style: Style): string {
  return alignColumns(
    rows.map((r) => [r.installName, `${r.name} ${r.version}`, r.category, r.trust]),
    [{}, { shrink: "end", min: 12 }, { style: style.palette.dim }, { style: trustBadge(style) }],
    style,
  ).join("\n");
}

/** Steps past the current one were undone, so they sit back in faint. */
export function historyList(rows: readonly HistoryRow[], style: Style): string {
  const { palette, glyphs } = style;
  const currentAt = rows.findIndex((r) => r.current);
  const undone = (text: string, row: number): string => (currentAt >= 0 && row > currentAt ? palette.dim(text) : text);
  return alignColumns(
    rows.map((r) => [r.current ? glyphs.current : "", String(r.index), glyphs.fold(r.label), formatTimestamp(r.timestamp)]),
    [{ style: palette.accent }, { gap: 1, align: "right", style: undone }, { style: undone, shrink: "end", min: 12 }, { style: palette.dim }],
    style,
  ).join("\n");
}

export function doctor(items: readonly DoctorItem[], style: Style): string {
  const { palette, glyphs } = style;
  const marks: Record<DoctorItem["status"], string> = { ok: glyphs.ok, warn: "!", fail: glyphs.fail, info: "" };
  const mark = (text: string, row: number): string => {
    const status = items[row].status;
    return status === "fail" ? palette.error(text) : status === "warn" ? palette.accent(text) : palette.dim(text);
  };
  return alignColumns(
    items.map((item) => [marks[item.status], item.label, item.value]),
    [{ style: mark }, { gap: 1, style: palette.dim }, {}],
    style,
  ).join("\n");
}
