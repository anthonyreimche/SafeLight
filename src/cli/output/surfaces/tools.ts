// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `tools <photo>` on a terminal: each tool's values as key, value, slider,
// mark and range, always in those columns. Values still at their default
// recede: they are folded into one line a tool unless `all` is asked for.

import { barCells, hasRange, sliderBar } from "../components/bar";
import { hasLabel, labelDot, stars } from "../components/marks";
import { grid } from "../components/table";
import { formatMegapixels, formatRange, valueParts } from "../format";
import { joinDots, paintArgument } from "../look";
import type { Look } from "../look";
import type { PhotoHeader, ToolRow, ToolView, ValueRow } from "../types";
import { cells, clip, joinHorizontal } from "../width";

const STATE_NOTE: Record<NonNullable<ToolRow["state"]>, string> = {
  "in use": "",
  idle: "idle",
  off: "off",
  "not installed": "not installed, values kept",
};

/** Narrower than this and ranges and notes are left out. */
const RANGES_FROM = 72;
const PICTURE_FROM = 96;
const NOTE_MIN = 12;

export function photoHeaderLines(h: PhotoHeader, look: Look): string[] {
  const { theme } = look;
  const facts = [
    h.camera ?? "",
    h.megapixels !== undefined ? formatMegapixels(h.megapixels) : "",
    h.step ? `step ${h.step.at} of ${h.step.of}` : h.edited ? "edited" : "not edited",
    `process version ${h.processVersion}`,
  ].map((fact) => theme.paint("muted", look.glyphs.fold(fact)));
  const marks = [
    h.rating !== undefined ? stars(h.rating, look) : "",
    h.flag && h.flag !== "none" ? h.flag : "",
    hasLabel(h.label) ? labelDot(h.label, look) : "",
  ];
  const second = joinDots(marks, look);
  return [theme.paint("strong", h.name), joinDots(facts, look), ...(second ? [second] : []), ""];
}

const plainNote = (note: string): string => note.replace(/^\((.*)\)$/, "$1");

export function toolLines(rows: readonly ToolRow[], view: ToolView, look: Look): string[] {
  const { glyphs, theme } = look;

  if (rows.every((row) => row.values.length === 0)) {
    return grid(rows.map((row) => [row.tool, theme.paint("muted", row.state ? STATE_NOTE[row.state] : "")]));
  }

  const picture = view.picture && view.picture.length > 0 && look.columns >= PICTURE_FROM ? view.picture : null;
  const wide = look.columns >= RANGES_FROM && !picture;
  const barSize = barCells(look.columns);

  const shownOf = (row: ToolRow): ValueRow[] => (view.all ? row.values : row.values.filter((v) => v.changed));
  const numbers = rows.flatMap(shownOf).map((v) => valueParts(v.info, v.value, glyphs)).filter((parts) => parts.numeric);
  const numberWidth = Math.max(0, ...numbers.map((parts) => cells(parts.text)));
  const unitWidth = Math.max(0, ...numbers.map((parts) => cells(parts.unit)));

  const valueCell = (v: ValueRow): string => {
    const parts = valueParts(v.info, v.value, glyphs);
    const tone = v.changed ? "strong" : "muted";
    if (parts.numeric) return theme.paint(tone, parts.text.padStart(numberWidth)) + theme.paint("muted", parts.unit.padEnd(unitWidth));
    if (v.info.kind === "switch") {
      return v.value ? theme.paint("amber", `on ${glyphs.thumb}`) : theme.paint("muted", `off ${glyphs.was}`);
    }
    return theme.paint(tone, glyphs.fold(parts.text));
  };

  const rangeCell = (v: ValueRow, unknown: boolean): string => {
    if (!wide || unknown || v.info.kind === "switch") return "";
    if (v.info.kind === "choice") {
      return joinDots((v.info.choices ?? []).map((c) => (c.value === v.value ? `[${c.value}]` : theme.paint("muted", c.value))), look);
    }
    return theme.paint("muted", formatRange(v.info, glyphs));
  };

  const shown = rows.map(shownOf);
  const unknown = rows.map((row) => row.values.length > 0 && row.values.every((v) => v.info.rangeUnknown));
  const table = grid(
    shown.flatMap((values, at) => values.map((v) => [
      v.info.key,
      valueCell(v),
      v.info.settable && typeof v.value === "number" && hasRange(v.info)
        ? sliderBar({ info: v.info, value: v.value, cells: barSize }, look)
        : "",
      v.changed ? theme.paint("amber", glyphs.changed) : "",
      rangeCell(v, unknown[at]),
    ])),
    [{}, {}, {}, { gap: 2 }, {}],
  );

  const lines: string[] = [];
  let next = 0;
  rows.forEach((row, at) => {
    if (lines.length > 0) lines.push("");
    const notes = [row.state ? STATE_NOTE[row.state] : "", unknown[at] ? "ranges unknown" : ""].filter((note) => note !== "");
    const hidden = row.values.length - shown[at].length;
    const folded = hidden > 0 ? `${hidden} ${hidden === 1 ? "value" : "values"} at ${hidden === 1 ? "its default" : "their defaults"}` : "";
    const heading = theme.paint("strong", row.tool) + (notes.length > 0 ? `  ${theme.paint("muted", `(${notes.join(", ")})`)}` : "");
    if (shown[at].length === 0) {
      lines.push(folded ? `${heading}   ${theme.paint("muted", folded)}` : heading);
      return;
    }
    lines.push(heading);
    for (const v of shown[at]) {
      let line = `  ${table[next++]}`;
      const note = glyphs.fold(plainNote(v.note ?? (v.info.settable ? "" : v.info.notSettableReason ?? "")));
      const room = look.width - cells(line) - 2;
      if (note && (wide || !v.info.settable) && room >= Math.min(NOTE_MIN, cells(note))) {
        line += `  ${theme.paint("muted", clip(note, room, glyphs.ellipsis))}`;
      }
      lines.push(line);
    }
    if (folded) lines.push(`  ${theme.paint("muted", `${glyphs.ellipsis}${hidden} more at ${hidden === 1 ? "its default" : "their defaults"}`)}`);
  });

  if (!view.all && rows.some((row, at) => row.values.length > shown[at].length)) {
    lines.push("", `${paintArgument("--all", look)} ${theme.paint("muted", "lists values at their defaults too")}`);
  }
  return picture ? joinHorizontal([lines, picture], 3) : lines;
}
