// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What every designed component is handed: the theme, the glyphs and the room.

import { COMMAND } from "../types";
import type { Capabilities } from "./capabilities";
import { glyphSet } from "./glyphs";
import type { GlyphSet } from "./glyphs";
import type { Style } from "./palette";
import { createTheme } from "./theme";
import type { Theme } from "./theme";
import type { OutputOptions } from "./types";
import { cells } from "./width";

/** Everything a person reads sits in from the prompt by this much. */
export const MARGIN = 2;
export const MIN_COLUMNS = 40;
/** Past this the screen stops widening, so a table never runs the width of a wide window. */
export const MAX_COLUMNS = 96;

export interface Look {
  theme: Theme;
  glyphs: GlyphSet;
  /** The terminal's columns, held to 40…96. */
  columns: number;
  /** Room for content: the columns less the margin and the last column, which wraps on some terminals. */
  width: number;
  caps: Capabilities;
}

export function lookOf(caps: Capabilities, columns: number): Look {
  const held = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, columns));
  return {
    theme: createTheme({ tier: caps.tier, name: caps.theme, curly: caps.curly, links: caps.links }),
    glyphs: glyphSet(caps.glyphs),
    columns: held,
    width: held - MARGIN - 1,
    caps,
  };
}

/** The look for a stream, or null where it gets the plain text. */
export function lookFor(options: OutputOptions, stream: "stdout" | "stderr"): Look | null {
  const { caps } = options;
  return caps && caps.rich[stream] ? lookOf(caps, options.width) : null;
}

/** The four plain roles painted from the theme, for the builders both looks share. */
export function styleOf(look: Look): Style {
  const { theme } = look;
  return {
    palette: {
      enabled: true,
      heading: (text) => theme.paint("strong", text),
      accent: (text) => theme.paint("amber", text),
      dim: (text) => theme.paint("muted", text),
      error: (text) => theme.paint("lamp", text),
    },
    glyphs: look.glyphs,
    width: look.width,
  };
}

export function joinDots(parts: readonly string[], look: Look): string {
  return parts.filter((part) => part !== "").join(look.theme.paint("faint", look.glyphs.dot));
}

/** Packs styled parts into lines no wider than `width`, joined by the faint dot. */
export function flowDots(parts: readonly string[], width: number, look: Look): string[] {
  const gap = cells(look.glyphs.dot);
  const lines: string[][] = [];
  let used = 0;
  for (const part of parts) {
    if (part === "") continue;
    const size = cells(part);
    const line = lines[lines.length - 1];
    if (line && used + gap + size <= width) {
      line.push(part);
      used += gap + size;
    } else {
      lines.push([part]);
      used = size;
    }
  }
  return lines.map((line) => joinDots(line, look));
}

const ASSIGNMENT = /^([A-Za-z][\w.]*)(\+=|-=|=)(.*)$/;

/**
 * A command line in the prompt's colours, so help, hints and fixes teach the
 * highlighting: the verb strong, keys amber, operators faint, values strong,
 * options muted and <placeholders> italic.
 */
export function paintCommand(line: string, look: Look): string {
  const { theme } = look;
  let verbSeen = false;
  return line.split(" ").map((word) => {
    if (word === "" || verbSeen) return paintArgument(word, look);
    if (word === COMMAND) return theme.paint("muted", word);
    verbSeen = true;
    return theme.paint("strong", word);
  }).join(" ");
}

/** One word after the verb, in the prompt's colours. */
export function paintArgument(word: string, look: Look): string {
  const { theme } = look;
  if (word === look.glyphs.dot.trim()) return theme.paint("faint", word);
  if (/^[<[].*[\]>…]$/.test(word) || /^".*"$/.test(word)) return theme.paint("italic", word);
  if (/^--?[A-Za-z]/.test(word)) return theme.paint("muted", word);
  const assignment = ASSIGNMENT.exec(word);
  if (assignment) return theme.paint("amber", assignment[1]) + theme.paint("faint", assignment[2]) + theme.paint("strong", assignment[3]);
  return word;
}
