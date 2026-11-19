// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension as a card: its name and version in the top edge with its trust
// badge, a line or two of what it does, and the command that installs it.

import type { Trust } from "../../types";
import { wrapText } from "../format";
import { paintCommand } from "../look";
import type { Look } from "../look";
import { cells, clip, padEnd } from "../width";
import { trustBadge } from "./badge";
import { panel } from "./panel";

export interface CardModel {
  name: string;
  version?: string;
  trust: Trust;
  description?: string;
  /** Muted, at the right of the first line. Left out under 72 columns. */
  category?: string;
  /** A command line, shown in the prompt's colours. */
  command?: string;
  /** Extra body lines, already styled, after the description. */
  lines?: readonly string[];
  /** Amber when the card is the subject of a question. */
  tone?: "faint" | "amber";
}

const DESCRIPTION_LINES = 2;

export function card(model: CardModel, width: number, look: Look): string[] {
  const { glyphs, theme } = look;
  const inner = width - 4;
  const category = look.columns >= 72 && model.category ? glyphs.fold(model.category) : "";
  const room = inner - (category ? cells(category) + 3 : 0);

  const described = model.description ? wrapText(glyphs.fold(model.description), room) : [];
  const text = described.length > DESCRIPTION_LINES
    ? [...described.slice(0, DESCRIPTION_LINES - 1), clip(described.slice(DESCRIPTION_LINES - 1).join(" "), room, glyphs.ellipsis)]
    : described;
  const body = text.length === 0 && category ? [""] : [...text];
  if (category) body[0] = padEnd(body[0], inner - cells(category)) + theme.paint("muted", category);

  return panel({
    title: theme.paint("strong", clip(glyphs.fold(model.name), Math.max(8, inner - 24), glyphs.ellipsis))
      + (model.version ? `  ${theme.paint("muted", model.version)}` : ""),
    note: trustBadge(model.trust, look),
    body: [...body, ...(model.lines ?? []), ...(model.command ? [paintCommand(model.command, look)] : [])],
    width,
    tone: model.tone,
  }, look);
}
