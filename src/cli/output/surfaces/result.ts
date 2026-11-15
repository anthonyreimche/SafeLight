// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a change prints. One photo gets a block: its name and step, then each
// value before → after with its slider. A batch gets a line a photo and a
// summary, with no bars, because a relative change lands somewhere different
// on each.

import { barCells } from "../components/bar";
import { valueDiff } from "../components/diff";
import { flowChunks, formatBytes } from "../format";
import { joinDots } from "../look";
import type { Look } from "../look";
import type { BatchSummary, ExportedLine, ResultLine } from "../types";
import { cells, clipStart } from "../width";

/** Whether a result has anything a tween can move: a numeric before and after on a ranged value. */
export function canTween(r: ResultLine): boolean {
  return r.changes.some((c) => c.info !== undefined && typeof c.before === "number" && typeof c.after === "number" && c.before !== c.after);
}

/** One photo's result. `t` runs 0…1 for the tween; 1 is what stays in scrollback. */
export function resultBlock(r: ResultLine, look: Look, t = 1): string[] {
  const { glyphs, theme } = look;
  const head = joinDots([
    theme.paint("strong", r.photo),
    r.step !== undefined ? theme.paint("muted", `step ${r.step}`) : "",
    r.note ? theme.paint("muted", glyphs.fold(r.note)) : "",
  ], look);
  const rows = valueDiff(r.changes, look, { cells: barCells(look.columns), t });
  return [head, ...rows.map((row) => `  ${row}`)];
}

/** A batch's line for one photo: the name, what changed, the step. */
export function resultRow(r: ResultLine, look: Look): string {
  const { glyphs, theme } = look;
  const dot = theme.paint("faint", glyphs.dot);
  const changes = r.changes.map((c) => glyphs.fold(c.value ? `${c.label} ${c.value}` : c.label));
  const tail = (r.note ? `  ${theme.paint("muted", glyphs.fold(r.note))}` : "")
    + (r.step !== undefined ? `   ${theme.paint("muted", `step ${r.step}`)}` : "");
  if (changes.length === 0) return r.photo + tail;
  const under = cells(r.photo) + 3;
  const hang = look.width - under >= 30 ? under : 4;
  const lines = flowChunks(changes, glyphs.dot, look.width - hang).map((line) => line.join(dot));
  return `${r.photo}   ${lines.join(`\n${" ".repeat(hang)}`)}${tail}`;
}

export function summaryLine(s: BatchSummary, look: Look): string {
  const { glyphs, theme } = look;
  const photos = `${s.photos} ${s.photos === 1 ? "photo" : "photos"}`;
  // A bare count is the answer to a listing, not the result of a change.
  if (!s.stepEach && s.failed === 0 && s.skipped === 0) return theme.paint("muted", photos);
  const mark = s.failed > 0 ? theme.paint("amber", glyphs.warn) : theme.paint("ok", glyphs.ok);
  return `${mark} ${joinDots([
    photos,
    s.stepEach ? "1 step each" : "",
    s.failed > 0 ? theme.paint("lamp", `${s.failed} failed`) : "",
    s.skipped > 0 ? theme.paint("muted", `${s.skipped} skipped`) : "",
  ], look)}`;
}

const fileUrl = (path: string): string => `file://${/^[A-Za-z]:/.test(path) ? "/" : ""}${encodeURI(path.replace(/\\/g, "/"))}`;

/** A finished export: the file, as a link where the terminal follows them, then its facts. */
export function exportedLine(e: ExportedLine, look: Look): string {
  const { glyphs, theme } = look;
  const facts = [`${e.width}${glyphs.times}${e.height}`, e.colourSpace, formatBytes(e.bytes)];
  const room = Math.max(16, look.width - 2 - facts.reduce((sum, fact) => sum + fact.length + 3, 0));
  const shown = clipStart(e.path, room, glyphs.ellipsis);
  const path = /^([A-Za-z]:[\\/]|\/)/.test(e.path) ? theme.link(fileUrl(e.path), shown) : shown;
  return `${theme.paint("ok", glyphs.ok)} ${path}   ${facts.map((fact) => theme.paint("muted", fact)).join("   ")}`;
}
