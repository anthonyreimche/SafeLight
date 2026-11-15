// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Badges in two strengths. Quiet is a mark and a word; a pill is a filled
// label, kept for the two states that stop you: banned and read only.

import type { Trust } from "../../types";
import type { Look } from "../look";

export function pill(text: string, tone: "lamp" | "amber", look: Look): string {
  return look.theme.paint(tone === "lamp" ? "pill.lamp" : "pill.amber", ` ${text} `);
}

export function trustBadge(trust: Trust, look: Look): string {
  const { glyphs, theme } = look;
  switch (trust) {
    case "official":
      return `${theme.paint("lamp", glyphs.node)} official`;
    case "verified":
      return `${theme.paint("ok", glyphs.ok)} verified`;
    case "unverified":
      return theme.paint("amber", `${glyphs.warn} unverified`);
    case "banned":
      return pill("banned", "lamp", look);
  }
}
