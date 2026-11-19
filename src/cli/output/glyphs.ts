// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The three glyph sets. "full" is any modern terminal font; "basic" is what
// Consolas and Lucida Console carry (WGL4: square corners, no stars, ticks or
// heavy lines); "ascii" is for the Linux console and anything that says dumb.

import type { Glyphs } from "./palette";

export type GlyphSetName = "full" | "basic" | "ascii";

export interface GlyphSet extends Glyphs {
  name: GlyphSetName;
  corners: readonly [topLeft: string, topRight: string, bottomLeft: string, bottomRight: string];
  line: string;
  side: string;
  barFill: string;
  barTrack: string;
  /** Half a cell of fill ending on the left / starting on the right; empty where the font has none. */
  halfLeft: string;
  halfRight: string;
  thumb: string;
  was: string;
  tick: string;
  /** Wraps the ASCII bar, which has no colour to set it off. */
  barEnds: readonly [string, string];
  warn: string;
  starEmpty: string;
  arrow: string;
  prompt: string;
  /** The working lamp. One frame where colour does the breathing. */
  lamp: readonly string[];
  /** The bar at the left of a selected row. */
  selected: string;
  node: string;
  nodeHere: string;
  nodeUndone: string;
  stem: string;
  stemUndone: string;
  /** The left edge of an error card and its last corner. */
  errorBar: string;
  errorEnd: string;
  /** A folder tree: a child, the last child, and the line past a child that has more below it. */
  branch: string;
  branchLast: string;
  trunk: string;
}

const same = (text: string): string => text;

const FOLDS: readonly (readonly [RegExp, string])[] = [
  [/…/g, "..."], [/[−–—]/g, "-"], [/·/g, "-"], [/×/g, "x"], [/[✱★]/g, "*"], [/[“”]/g, '"'], [/[‘’]/g, "'"], [/→/g, "->"],
];

const FULL: GlyphSet = {
  name: "full",
  ellipsis: "…", changed: "✱", minus: "−", dot: " · ", times: "×", star: "★", none: "·",
  current: "●", ok: "✓", fail: "✕", barDone: "━", barLeft: "─",
  fold: same,
  corners: ["╭", "╮", "╰", "╯"], line: "─", side: "│",
  barFill: "━", barTrack: "─", halfLeft: "╸", halfRight: "╺",
  thumb: "●", was: "○", tick: "┼", barEnds: ["", ""],
  warn: "!", starEmpty: "·", arrow: "→", prompt: "›",
  lamp: ["●"], selected: "▌",
  node: "●", nodeHere: "◉", nodeUndone: "○", stem: "│", stemUndone: "┆",
  errorBar: "│", errorEnd: "╰",
  branch: "├─", branchLast: "└─", trunk: "│",
};

const BASIC: GlyphSet = {
  ...FULL,
  name: "basic",
  changed: "*", star: "*", ok: "√", fail: "x",
  barDone: "═",
  corners: ["┌", "┐", "└", "┘"],
  barFill: "═", halfLeft: "", halfRight: "",
  prompt: ">", lamp: ["·", "•", "●", "•"],
  nodeHere: "●", stemUndone: ":", errorEnd: "└",
  fold: (text) => text.replace(/[✱★]/g, "*"),
};

const ASCII: GlyphSet = {
  name: "ascii",
  ellipsis: "...", changed: "*", minus: "-", dot: " - ", times: "x", star: "*", none: "-",
  current: ">", ok: "ok", fail: "x", barDone: "=", barLeft: "-",
  fold: (text) => FOLDS.reduce((folded, [from, to]) => folded.replace(from, to), text),
  corners: ["+", "+", "+", "+"], line: "-", side: "|",
  barFill: "=", barTrack: "-", halfLeft: "", halfRight: "",
  thumb: "o", was: ".", tick: "|", barEnds: ["[", "]"],
  warn: "!", starEmpty: "-", arrow: "->", prompt: ">",
  lamp: [".", "o", "O", "o"], selected: ">",
  node: "o", nodeHere: "@", nodeUndone: ".", stem: "|", stemUndone: ":",
  errorBar: "|", errorEnd: "`",
  branch: "|--", branchLast: "\\--", trunk: "|",
};

const SETS: Record<GlyphSetName, GlyphSet> = { full: FULL, basic: BASIC, ascii: ASCII };

export function glyphSet(name: GlyphSetName): GlyphSet {
  return SETS[name];
}
