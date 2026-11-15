// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The whole look of `safelight` in four roles. Bold and faint follow the terminal's
// own foreground, so they read on dark and light backgrounds alike; the amber
// and the red are the only two hues.

export interface Palette {
  readonly enabled: boolean;
  /** Bold: a screen's title and a table's tool names. */
  heading(text: string): string;
  /** Safelight amber: a changed value's mark, a warning, the current step. */
  accent(text: string): string;
  /** Faint: ranges, notes, separators, labels. */
  dim(text: string): string;
  /** Red: errors and nothing else. */
  error(text: string): string;
}

// 256-colour 166 is an amber dark enough for a white background (3.7:1) and
// bright enough for a black one (5.6:1). The 16-colour yellow is neither.
const AMBER = "38;5;166";

export const sgr = (open: string, close: string) => (text: string): string =>
  text === "" ? "" : `\x1b[${open}m${text}\x1b[${close}m`;

const same = (text: string): string => text;

export function createPalette(enabled: boolean): Palette {
  if (!enabled) return { enabled, heading: same, accent: same, dim: same, error: same };
  return {
    enabled,
    heading: sgr("1", "22"),
    accent: sgr(AMBER, "39"),
    dim: sgr("2", "22"),
    error: sgr("31", "39"),
  };
}

const STYLE = /\x1b\[[0-9;]*m/g;

export function stripStyle(text: string): string {
  return text.replace(STYLE, "");
}

/** Columns a string takes once its styling is removed. */
export function visibleWidth(text: string): number {
  return [...stripStyle(text)].length;
}

export interface Glyphs {
  ellipsis: string;
  /** Marks a value that isn't at its default. */
  changed: string;
  minus: string;
  /** Joins the parts of one line, spaces included. */
  dot: string;
  times: string;
  star: string;
  /** An empty table cell. */
  none: string;
  /** The step a photo is on. */
  current: string;
  ok: string;
  fail: string;
  barDone: string;
  barLeft: string;
  /** Rewrites text a command supplied into what this terminal can show. */
  fold(text: string): string;
}

const UNICODE: Glyphs = {
  ellipsis: "…", changed: "✱", minus: "−", dot: " · ", times: "×", star: "★", none: "·",
  current: "●", ok: "✓", fail: "×", barDone: "━", barLeft: "─",
  fold: same,
};

const FOLDS: readonly (readonly [RegExp, string])[] = [
  [/…/g, "..."], [/[−–—]/g, "-"], [/·/g, "-"], [/×/g, "x"], [/[✱★]/g, "*"], [/[“”]/g, '"'], [/[‘’]/g, "'"],
];

const ASCII: Glyphs = {
  ellipsis: "...", changed: "*", minus: "-", dot: " - ", times: "x", star: "*", none: "-",
  current: ">", ok: "ok", fail: "x", barDone: "=", barLeft: "-",
  fold: (text) => FOLDS.reduce((folded, [from, to]) => folded.replace(from, to), text),
};

export function glyphsFor(unicode: boolean): Glyphs {
  return unicode ? UNICODE : ASCII;
}

/** What every builder needs: the roles, the glyphs and the room. */
export interface Style {
  palette: Palette;
  glyphs: Glyphs;
  width: number;
}
