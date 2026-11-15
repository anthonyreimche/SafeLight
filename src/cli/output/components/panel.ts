// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A rounded box with its title, and an optional note, set into the top edge.
// Only things that ask or warn get one; lists and tables are whitespace.

import type { Look } from "../look";
import { cells, clip, padEnd, stripMarkup } from "../width";

export interface PanelModel {
  /** Already styled. Dropped to plain and cut when the panel is too narrow for it. */
  title?: string;
  /** Already styled; sits at the right of the top edge. The first thing to go when narrow. */
  note?: string;
  /** Already styled, each line no wider than `width - 4`. */
  body: readonly string[];
  /** Outer width, borders included. */
  width: number;
  /** Amber when the panel is asking something. */
  tone?: "faint" | "amber";
}

export function panel(model: PanelModel, look: Look): string[] {
  const { glyphs, theme } = look;
  const [topLeft, topRight, bottomLeft, bottomRight] = glyphs.corners;
  const edge = (text: string): string => theme.paint(model.tone ?? "faint", text);
  const inner = Math.max(4, model.width - 2);

  let title = model.title ?? "";
  let note = model.note ?? "";
  const fixed = (): number => (title ? cells(title) + 3 : 0) + (note ? cells(note) + 3 : 0);
  if (note && fixed() + 1 > inner) note = "";
  if (title && fixed() + 1 > inner) title = clip(stripMarkup(title), Math.max(1, inner - 4), glyphs.ellipsis);

  const rule = glyphs.line.repeat(Math.max(1, inner - fixed()));
  const top = edge(topLeft)
    + (title ? `${edge(glyphs.line)} ${title} ` : "")
    + edge(rule)
    + (note ? ` ${note} ${edge(glyphs.line)}` : "")
    + edge(topRight);

  const side = edge(glyphs.side);
  return [
    top,
    ...model.body.map((line) => `${side} ${padEnd(line, inner - 2)} ${side}`),
    edge(bottomLeft + glyphs.line.repeat(inner) + bottomRight),
  ];
}
