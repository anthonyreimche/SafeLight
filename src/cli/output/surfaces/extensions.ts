// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extensions on a terminal. `search` is the store, so each hit is a card;
// `extensions` is a list you own, so it is a table with updates first;
// installing something unverified is the one question Safelight asks, so it
// gets the one amber panel.

import type { InstallRisk } from "../../types";
import { trustBadge } from "../components/badge";
import { card } from "../components/card";
import { keyHints } from "../components/hints";
import { grid } from "../components/table";
import { wrapText } from "../format";
import { joinDots, paintCommand } from "../look";
import type { Look } from "../look";
import { STATE_UNKNOWN_NOTE } from "../table";
import type { ExtensionRow, SearchRow } from "../types";
import { clip } from "../width";

const CARD_WIDTH = 68;
/** More hits than this and `search` goes back to a table. */
export const MOST_CARDS = 8;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function extensionLines(rows: readonly ExtensionRow[], look: Look): string[] {
  const { glyphs, theme } = look;
  const updates = rows.filter((r) => r.update).length;
  const ordered = [...rows.filter((r) => r.update), ...rows.filter((r) => !r.update)];
  const nameRoom = Math.max(12, look.width - 56);

  const table = grid(ordered.map((r) => {
    const off = r.enabled === false;
    const name = clip(glyphs.fold(r.name), nameRoom, glyphs.ellipsis);
    const version = r.update
      ? `${r.version} ${theme.paint("faint", glyphs.arrow)} ${theme.paint("amber", r.update)}`
      : off ? theme.paint("muted", r.version) : r.version;
    const state = r.enabled === null ? theme.paint("muted", "?") : off ? theme.paint("muted", "off") : "on";
    return [
      off ? theme.paint("muted", name) : name,
      version,
      state,
      trustBadge(r.trust, look),
      r.update && look.columns >= 72 ? paintCommand(`update ${r.id}`, look) : "",
    ];
  }));

  return [
    joinDots([plural(rows.length, "extension", "extensions"), updates > 0 ? theme.paint("amber", plural(updates, "update", "updates")) : ""], look),
    "",
    ...table,
    ...(rows.some((r) => r.enabled === null) ? ["", ...wrapText(STATE_UNKNOWN_NOTE, look.width).map((line) => theme.paint("muted", line))] : []),
  ];
}

export function searchCards(rows: readonly SearchRow[], look: Look): string[] {
  const width = Math.min(CARD_WIDTH, look.width);
  return [
    look.theme.paint("muted", plural(rows.length, "extension", "extensions") + " found"),
    "",
    ...rows.flatMap((r) => card({
      name: r.name,
      version: r.version,
      trust: r.trust,
      description: r.description,
      category: r.category,
      command: `install ${r.installName}`,
    }, width, look)),
  ];
}

const TRUST_LINE: Record<InstallRisk["trust"], string> = {
  official: "Made by Safelight.",
  verified: "Safelight has checked this extension.",
  unverified: "Nobody at Safelight has checked this extension. It runs with full access to your photos and files.",
  banned: "Safelight has banned this extension.",
};

/** The card an install or update question sits under: what the extension may reach, and who has checked it. */
export function installCard(risk: InstallRisk, look: Look): string[] {
  const { glyphs, theme } = look;
  const width = Math.min(CARD_WIDTH, look.width);
  const inner = width - 4;
  const may = risk.permissions.length > 0
    ? ["It may", ...risk.permissions.flatMap((p) => wrapText(glyphs.fold(p), inner - 2).map((line) => `  ${line}`))]
    : ["It asks for no special permissions."];
  return card({
    name: risk.name,
    trust: risk.trust,
    lines: [...may, "", ...wrapText(TRUST_LINE[risk.trust], inner).map((line) => theme.paint("muted", line))],
    tone: risk.trust === "unverified" ? "amber" : "faint",
  }, width, look);
}

/** "Install it?   ‹ No ›   Yes": one line, the chosen answer strong in its marks, with its keys beside it. */
export function confirmLine(question: string, yes: boolean, look: Look): string {
  const { glyphs, theme } = look;
  const [open, close] = glyphs.name === "ascii" ? ["[", "]"] : ["‹", "›"];
  const choice = (label: string, chosen: boolean): string =>
    (chosen ? theme.paint("strong", `${open} ${label} ${close}`) : theme.paint("muted", `  ${label}  `));
  const hints = keyHints([["← →", "choose"], ["enter", ""], ["y / n", ""]], look.width, look);
  return `${glyphs.fold(question)}   ${choice("No", !yes)} ${choice("Yes", yes)}        ${hints}`;
}
