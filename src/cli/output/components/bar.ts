// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The value slider bar: a ranged value drawn as where it sits. The tick is
// the default, not zero, and the heavy fill runs from the default to the
// thumb, so its length is how far the value was moved. The same bar is in
// `tools`, in a `set` result and in the prompt's footer.

import type { ValueInfo } from "../../types";
import type { Look } from "../look";
import { mixRgb } from "../theme";
import type { Rgb, TokenName } from "../theme";

/** Cells a bar gets at this many terminal columns; 0 means no bar. */
export function barCells(columns: number): number {
  if (columns >= 96) return 21;
  if (columns >= 72) return 16;
  return columns >= 50 ? 10 : 0;
}

export function hasRange(info: ValueInfo): info is ValueInfo & { min: number; max: number } {
  return info.kind === "number" && !info.rangeUnknown && info.min !== undefined && info.max !== undefined && info.max > info.min;
}

/** Where a value sits along its slider, 0…1, by the panel's own curve when it has one. */
export function sliderPosition(info: ValueInfo, value: number): number {
  if (!hasRange(info)) return 0;
  const at = info.position ? info.position(value) : (value - info.min) / (info.max - info.min);
  return Number.isFinite(at) ? Math.min(1, Math.max(0, at)) : 0;
}

/** The value the tick marks: the default when known, zero when the range spans it. */
export function sliderDefault(info: ValueInfo): number | undefined {
  if (info.default !== undefined) return info.default;
  return hasRange(info) && info.min < 0 && info.max > 0 ? 0 : undefined;
}

const TEMPERATURE: readonly Rgb[] = [[106, 165, 255], [255, 177, 74]];
const TINT: readonly Rgb[] = [[76, 201, 112], [214, 92, 214]];
const HUES: readonly Rgb[] = [[230, 70, 70], [230, 200, 60], [80, 200, 90], [70, 200, 210], [80, 110, 230], [210, 80, 210], [230, 70, 70]];

/** Sliders whose track is a colour in the app keep it here, in 24-bit colour only. */
function trackTint(info: ValueInfo): readonly Rgb[] | null {
  if (info.key === "temperature") return TEMPERATURE;
  if (info.key === "tint") return TINT;
  return /hue$/i.test(info.key) || /\.hue\./i.test(info.key) ? HUES : null;
}

function along(stops: readonly Rgb[], t: number): Rgb {
  const scaled = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const from = Math.min(stops.length - 2, Math.floor(scaled));
  return mixRgb(stops[from], stops[from + 1], scaled - from);
}

export interface BarModel {
  info: ValueInfo;
  value: number;
  /** The value before the change; drawn as a hollow thumb. */
  was?: number;
  cells: number;
}

interface Cell { glyph: string; token: TokenName }

/** One line, exactly `cells` wide (two more in ASCII, for its brackets). Empty when the value has no range. */
export function sliderBar(model: BarModel, look: Look): string {
  const { info, cells } = model;
  const { glyphs, theme } = look;
  if (!hasRange(info) || cells < 3) return "";

  // Twice the cells: where the font has half-cell fills, the thumb's own half shows in the fill beside it.
  const halves = glyphs.halfLeft !== "";
  const steps = halves ? cells * 2 - 1 : cells - 1;
  const stepOf = (value: number): number => Math.round(sliderPosition(info, value) * steps);
  const cellOf = (value: number): number => (halves ? Math.floor(stepOf(value) / 2) : stepOf(value));

  const now = cellOf(model.value);
  const base = sliderDefault(info);
  const tick = base === undefined ? undefined : cellOf(base);
  let was = model.was === undefined ? undefined : cellOf(model.was);
  // A move too small to cross a cell still shows which way it went.
  if (was === now && model.was !== undefined && model.was !== model.value) {
    const from = now + (sliderPosition(info, model.was) < sliderPosition(info, model.value) ? -1 : 1);
    if (from >= 0 && from < cells) was = from;
  }
  // At its default a value has no thumb: the tick alone says so.
  const resting = model.was === undefined && base !== undefined && model.value === base;

  const row: Cell[] = Array.from({ length: cells }, () => ({ glyph: glyphs.barTrack, token: "faint" }));
  const fill = (a: number, b: number, token: TokenName): void => {
    for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) row[i] = { glyph: glyphs.barFill, token };
  };

  if (was === undefined) {
    if (tick !== undefined) fill(tick, now, "amber");
  } else {
    // Default to the nearer thumb is the old ground; between the thumbs is what just moved.
    if (tick !== undefined) {
      const sameSide = (was - tick) * (now - tick) > 0;
      if (sameSide) fill(tick, Math.abs(was - tick) < Math.abs(now - tick) ? was : now, "amberDim");
    }
    fill(was, now, "amber");
  }

  if (halves) {
    const half = stepOf(model.value) % 2 === 0;
    const from = was ?? tick;
    if (from !== undefined && half && Math.abs(now - from) > 1) {
      const beside = now + (from < now ? -1 : 1);
      row[beside] = { glyph: from < now ? glyphs.halfLeft : glyphs.halfRight, token: row[beside].token };
    }
  }

  if (tick !== undefined) row[tick] = { glyph: glyphs.tick, token: "muted" };
  if (was !== undefined && was !== now) row[was] = { glyph: glyphs.was, token: "amberDim" };
  if (!resting) row[now] = { glyph: glyphs.thumb, token: "amber" };

  const tint = theme.tier === "truecolour" ? trackTint(info) : null;
  let line = "";
  let run = "";
  let runToken: TokenName = "faint";
  const flush = (): void => {
    line += theme.paint(runToken, run);
    run = "";
  };
  row.forEach((cell, i) => {
    if (tint && cell.token === "faint") {
      flush();
      line += theme.rgb(along(tint, i / (cells - 1)), cell.glyph, "faint");
      return;
    }
    if (cell.token !== runToken) flush();
    runToken = cell.token;
    run += cell.glyph;
  });
  flush();
  return glyphs.barEnds[0] + line + glyphs.barEnds[1];
}

/** How wide sliderBar's line is for this many cells. */
export function barWidth(cells: number, look: Look): number {
  return cells === 0 ? 0 : cells + look.glyphs.barEnds[0].length + look.glyphs.barEnds[1].length;
}
