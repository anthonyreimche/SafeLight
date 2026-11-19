// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The progress bar: thin, a half-cell head, ember at its tail and lamp red at
// its head, like a filament heating along its length. Beside it a count and,
// once two items are done, about how long is left. Never a percentage.

import { formatBytes } from "../format";
import type { Look } from "../look";
import type { ProgressState } from "../types";

export const PROGRESS_CELLS = 48;

export function progressBar(fraction: number, cells: number, look: Look): string {
  const { glyphs, theme } = look;
  const halves = Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * cells * 2);
  const full = Math.floor(halves / 2);
  const head = halves % 2 === 1 && glyphs.halfLeft !== "" ? glyphs.halfLeft : "";
  const lit = full + (head ? 1 : 0);
  // Cells that come out the same colour are painted as one run.
  const SLOT = "\u0000";
  const runs: { paint: string; text: string }[] = [];
  for (let i = 0; i < lit; i++) {
    const paint = theme.blend("ember", "lamp", lit > 1 ? i / (lit - 1) : 1, SLOT);
    const last = runs[runs.length - 1];
    const glyph = i < full ? glyphs.barFill : head;
    if (last && last.paint === paint) last.text += glyph;
    else runs.push({ paint, text: glyph });
  }
  const bar = runs.map((run) => run.paint.replace(SLOT, run.text)).join("");
  return glyphs.barEnds[0] + bar + theme.paint("faint", glyphs.barTrack.repeat(cells - lit)) + glyphs.barEnds[1];
}

const RECENT = 5;

/** Milliseconds left, from the mean of the last five finished items; null until two are done. */
export function remainingMs(p: ProgressState, now: number): number | null {
  const left = Math.max(0, p.total - p.done);
  if (left === 0) return null;
  const timed = (p.items ?? []).filter((item) => item.state === "done" && item.ms !== undefined).slice(-RECENT);
  if (timed.length >= 2) return (timed.reduce((sum, item) => sum + (item.ms ?? 0), 0) / timed.length) * left;
  if (p.startedAt !== undefined && p.done >= 2) return ((now - p.startedAt) / p.done) * left;
  return null;
}

/** "about 40 s", "about 3 min": rounded, because it is a guess. */
export function aboutText(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 55) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `about ${Math.max(1, Math.round(seconds / 60))} min`;
}

/** "37 of 78 · about 40 s left", or "412 KB of 1.1 MB" for a download. */
export function progressCount(p: ProgressState, now: number, look: Look): string {
  const { glyphs, theme } = look;
  if (p.bytes) {
    return p.bytes.total === null ? formatBytes(p.bytes.done) : `${formatBytes(p.bytes.done)} of ${formatBytes(p.bytes.total)}`;
  }
  if (!(p.total > 0)) return "";
  const left = remainingMs(p, now);
  const count = `${Math.min(p.done, p.total)} of ${p.total}`;
  return left === null ? count : count + theme.paint("faint", glyphs.dot) + theme.paint("muted", `${aboutText(left)} left`);
}

export function progressFraction(p: ProgressState): number {
  if (p.bytes) return p.bytes.total ? p.bytes.done / p.bytes.total : 0;
  return p.total > 0 ? p.done / p.total : 0;
}
