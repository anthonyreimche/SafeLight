// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo's rating, flag and colour label, drawn the same way everywhere.

import type { Look } from "../look";
import type { ColourToken } from "../theme";

const STARS = 5;
const LABELS: Record<string, ColourToken> = {
  red: "label.red", yellow: "label.yellow", green: "label.green", blue: "label.blue", purple: "label.purple",
};

/** Five cells for every rating, so the column scans like the app's filmstrip. */
export function stars(rating: number, look: Look): string {
  const { glyphs, theme } = look;
  const lit = Math.min(STARS, Math.max(0, Math.round(rating)));
  return theme.paint("star", glyphs.star.repeat(lit)) + theme.paint("faint", glyphs.starEmpty.repeat(STARS - lit));
}

export const hasLabel = (label: string | undefined): label is string => label !== undefined && label !== "" && label !== "none";

/** The label's dot in its own colour; `named` adds the word, muted. */
export function labelDot(label: string, look: Look, named = true): string {
  const { glyphs, theme } = look;
  const dot = LABELS[label] ? theme.paint(LABELS[label], glyphs.node) : glyphs.node;
  return named ? `${dot} ${theme.paint("muted", label)}` : dot;
}
