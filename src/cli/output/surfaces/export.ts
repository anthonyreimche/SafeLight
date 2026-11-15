// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The frames of the live region while work is in progress. With items (an
// export) it is three lines: the lamp beside the photo being rendered, a
// blank, and the bar with its count and time left. Without, one line.

import { elapsedText, lamp, lampLine } from "../components/lamp";
import { PROGRESS_CELLS, progressBar, progressCount, progressFraction } from "../components/progress";
import { formatBytes, wrapText } from "../format";
import { joinDots } from "../look";
import type { Look } from "../look";
import type { ExportSummary, ProgressState } from "../types";
import { cells, clip } from "../width";
import { someNames } from "./library";

const BAR_MIN = 8;
const INLINE_BAR = 24;

/** A job with more items than this keeps only its last few finished rows on screen while it runs. */
export const ROWS_ALL_UP_TO = 30;
export const ROWS_KEPT = 5;

/** `kept` are finished rows that ride above the lamp row instead of scrolling away. */
export function progressFrame(p: ProgressState, now: number, since: number, look: Look, kept: readonly string[] = []): string[] {
  const { glyphs, theme } = look;
  const elapsed = Math.max(0, now - (p.startedAt ?? since));
  const count = progressCount(p, now, look);
  const measured = p.bytes !== undefined || p.total > 0;

  if (!p.items) {
    const head = lampLine(clip(p.label, Math.max(12, look.width - cells(count) - INLINE_BAR - 16), glyphs.ellipsis), elapsed, look);
    if (!measured) return [head];
    const room = Math.min(INLINE_BAR, look.width - cells(head) - cells(count) - 6);
    const bar = room >= BAR_MIN && (p.bytes === undefined || p.bytes.total !== null) ? `${progressBar(progressFraction(p), room, look)}   ` : "";
    return [`${head}   ${bar}${count}`];
  }

  const working = p.items.filter((item) => item.state === "working");
  const first = working[0];
  const more = working.length > 1 ? theme.paint("muted", `  +${working.length - 1} more`) : "";
  const doing = glyphs.fold(p.label).replace(/(\.\.\.|…)$/, "") + glyphs.ellipsis;
  const head = first
    ? `${lamp(elapsed, look)} ${clip(first.name, Math.max(12, look.width - cells(doing) - 20), glyphs.ellipsis)}   ${theme.paint("muted", doing)}${more}`
    : lampLine(p.label, elapsed, look);

  const room = Math.min(PROGRESS_CELLS, look.width - cells(count) - 3);
  const bar = room >= BAR_MIN ? `${progressBar(progressFraction(p), room, look)}   ` : "";
  return [...kept, head, "", bar + count];
}

/** What replaces the live region when an export ends: what was written and where, then what failed. */
export function exportSummaryLines(s: ExportSummary, look: Look): string[] {
  const { glyphs, theme } = look;
  const lines: string[] = [];
  if (s.exported > 0 || s.failed.length === 0) {
    lines.push(`${theme.paint("ok", glyphs.ok)} ${joinDots([
      `${s.exported} exported${s.folder ? ` to ${clip(s.folder, Math.max(12, look.width - 44), glyphs.ellipsis)}` : ""}`,
      s.bytes !== undefined ? theme.paint("muted", formatBytes(s.bytes)) : "",
      s.ms !== undefined ? theme.paint("muted", elapsedText(s.ms)) : "",
    ], look)}`);
  }
  if (s.failed.length > 0) {
    const [only] = s.failed;
    const what = s.failed.length === 1 ? `${only.name} ${only.error}` : someNames(s.failed.map((photo) => photo.name));
    const pad = " ".repeat(glyphs.fail.length);
    wrapText(glyphs.fold(`${s.failed.length} failed: ${what}`), look.width - pad.length - 1)
      .forEach((line, i) => lines.push(`${i === 0 ? theme.paint("lamp", glyphs.fail) : pad} ${line}`));
  }
  return lines;
}

/** The line `working` shows while its task runs. */
export function workingFrame(label: string, elapsedMs: number, look: Look): string[] {
  return [lampLine(clip(label, look.width - 14, look.glyphs.ellipsis), elapsedMs, look)];
}
