// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `photos` on a terminal. The list has no header: five cells of stars, the
// flag, the label's dot and the edited mark explain themselves. `--grid` is
// the contact sheet.

import { hasLabel, labelDot, stars } from "../components/marks";
import { climbRows, itermCell, skipCells } from "../components/picture";
import { grid } from "../components/table";
import { joinDots } from "../look";
import type { Look } from "../look";
import type { GridCell, ItermPicture, PhotoRow } from "../types";
import { cells, clip, clipStart, padEnd } from "../width";

const NAME_MIN = 12;
/** Narrower than this the size goes; narrower than LABEL_FROM a label is its dot alone. */
const SIZE_FROM = 72;
const LABEL_FROM = 60;

const inCatalogue = (r: PhotoRow): boolean => r.state === undefined || r.state === "imported";

/** What stands in for the marks of a file the catalogue has no usable record of; `short` is for where a line has little room. */
export function stateNote(r: PhotoRow, look: Look, short = false): string {
  const { glyphs, theme } = look;
  switch (r.state) {
    case "new":
      return theme.paint("muted", `${glyphs.was} not imported`);
    case "removed":
      return theme.paint("muted", short ? "removed" : "removed from the catalogue");
    case "missing":
      return joinDots([theme.paint("amber", `${glyphs.warn} file missing`), r.edited && !short ? "edited" : ""], look);
    default:
      return "";
  }
}

export function photoList(rows: readonly PhotoRow[], look: Look): string[] {
  const { glyphs, theme } = look;
  const none = theme.paint("faint", glyphs.none);
  // The four marks are one cell of the table, so a state can take their place and the sizes still line up.
  const marked = grid(rows.filter(inCatalogue).map((r) => {
    const rejected = r.flag === "reject";
    return [
      rejected ? theme.paint("muted", glyphs.star.repeat(r.rating) + glyphs.starEmpty.repeat(Math.max(0, 5 - r.rating))) : stars(r.rating, look),
      r.flag === "none" ? none : rejected ? theme.paint("muted", r.flag) : r.flag,
      hasLabel(r.label) ? labelDot(r.label, look, look.columns >= LABEL_FROM) : none,
      r.edited ? theme.paint("amber", glyphs.changed) : none,
    ];
  }));
  let next = 0;
  const marks = rows.map((r) => [
    inCatalogue(r) ? marked[next++] : stateNote(r, look, look.columns < LABEL_FROM),
    look.columns >= SIZE_FROM ? theme.paint("muted", glyphs.fold(r.size ?? "")) : "",
  ]);
  // Everything but the name is short, so the name gives way when the line is too long.
  const taken = Math.max(0, ...grid(marks).map(cells));
  const nameRoom = Math.max(NAME_MIN, look.width - taken - 3);
  return grid(rows.map((r, i) => {
    const name = clipStart(r.name, nameRoom, glyphs.ellipsis);
    return [r.flag === "reject" || r.state === "removed" ? theme.paint("muted", name) : name, ...marks[i]];
  }));
}

export const GRID_CELL = 14;
/** As tall as a cell's picture goes: a square, at two rows to a column. */
export const GRID_ROWS = 7;
const GRID_GAP = 3;

const isIterm = (picture: GridCell["picture"]): picture is ItermPicture => picture !== undefined && "jpeg" in picture;

/** The one line under a cell's name: its marks, or how it stands with the catalogue. */
function cellMarks(cell: GridCell, look: Look): string {
  const { glyphs, theme } = look;
  if (!inCatalogue(cell)) return stateNote(cell, look, true);
  if (cell.flag === "reject") return theme.paint("muted", "reject");
  return [
    cell.rating > 0 ? stars(cell.rating, look) : "",
    hasLabel(cell.label) ? labelDot(cell.label, look, false) : "",
    cell.edited ? theme.paint("amber", glyphs.changed) : "",
  ].filter((part) => part !== "").join(" ");
}

const baseName = (name: string): string => name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");

/**
 * The contact sheet: as many 14-column cells a row as fit, a name and one line
 * of marks under each. A picture is lines of half blocks, or a JPEG that iTerm2
 * draws. That one is placed with the cursor, and the lines beside and under it
 * only step past its cells, since writing over a picture wipes it.
 */
export function photoGridLines(photos: readonly GridCell[], look: Look): string[] {
  const { glyphs } = look;
  const perRow = Math.max(1, Math.floor((look.width + GRID_GAP) / (GRID_CELL + GRID_GAP)));
  const lines: string[] = [];
  for (let from = 0; from < photos.length; from += perRow) {
    const row = photos.slice(from, from + perRow);
    if (lines.length > 0) lines.push("");
    const heights = row.map((cell) => (isIterm(cell.picture) ? cell.picture.rows : cell.picture?.length ?? 0));
    const tall = Math.max(0, ...heights);
    const placed = row.some((cell) => isIterm(cell.picture));
    if (placed) lines.push(...Array.from({ length: tall - 1 }, () => ""));

    for (let i = 0; i < tall; i++) {
      let drawn = false;
      const parts = row.map((cell, at) => {
        const top = tall - heights[at];
        const { picture } = cell;
        if (isIterm(picture)) {
          if (i !== top) return skipCells(GRID_CELL);
          drawn = true;
          return itermCell(picture, GRID_CELL);
        }
        const text = i >= top ? picture?.[i - top] ?? "" : "";
        if (text !== "") drawn = true;
        return placed && text === "" ? skipCells(GRID_CELL) : padEnd(text, GRID_CELL);
      });
      const line = drawn ? parts.join(placed ? skipCells(GRID_GAP) : " ".repeat(GRID_GAP)) : "";
      lines.push((placed && i === 0 ? climbRows(tall - 1) : "") + (placed ? line : line.trimEnd()));
    }
    for (const caption of [row.map((cell) => clip(baseName(cell.name), GRID_CELL, glyphs.ellipsis)), row.map((cell) => cellMarks(cell, look))]) {
      lines.push(caption.map((text) => padEnd(text, GRID_CELL)).join(" ".repeat(GRID_GAP)).trimEnd());
    }
  }
  return lines;
}
