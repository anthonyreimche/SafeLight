// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Home on a terminal: the logo, then the name and the project as a card, then
// a few commands to start with. The logo's globe is the only red on the
// screen; it warms up once a session, from ember to lit: `warmth` is how far
// along it is. Where the logo doesn't fit, the compact form stands in.

import { pill } from "../components/badge";
import { panel } from "../components/panel";
import { wrapText } from "../format";
import { LOGO_ART, LOGO_ART_WIDTH, paintLogoRow } from "../logo/art";
import { MARGIN, flowDots, paintCommand } from "../look";
import type { Look } from "../look";
import type { ColourToken } from "../theme";
import type { HomeStatus } from "../types";
import { cells, clip, clipStart, indent, padEnd } from "../width";

const BULB_MARGIN = 3;
const CARD_WIDTH = 54;

/** The logo sits over the card, so it needs the wider of the two, its margin and a cell to spare. */
export const LOGO_FROM = Math.max(LOGO_ART_WIDTH, CARD_WIDTH) + BULB_MARGIN + 1;

const globeToken = (warmth: number): ColourToken => (warmth < 1 / 3 ? "ember" : warmth < 2 / 3 ? "lampShade" : "bulb");
const shadeToken = (warmth: number): ColourToken => (warmth < 2 / 3 ? "ember" : "lampShade");

/** The logo's rows, each as wide as the logo. `warmth` 0 is the ember the globe starts from, 1 is lit; the shade is a step behind. */
export function bulbRows(look: Look, warmth = 1): string[] {
  const { theme } = look;
  const tokens = { globe: globeToken(warmth), shade: shadeToken(warmth), stroke: "strong", caption: "muted" } as const;
  return LOGO_ART.map((row) => paintLogoRow(row, (part, text) => theme.paint(tokens[part], text))
    + " ".repeat(LOGO_ART_WIDTH - row.length));
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

type Starter = readonly [command: string, does: string];

const IN_A_PROJECT: readonly Starter[] = [
  ["photos", "list this project's photos"],
  ["tools <photo>", "a photo's tools and values"],
  ["set <photo> exposure=+0.5", "change a value"],
  ["help", "every command"],
];

const NO_PROJECT: readonly Starter[] = [
  ["doctor", "check this setup"],
  ["extensions", "list installed extensions"],
  ["help", "every command"],
];

const TRY_COLUMN = 6;

/** The starter commands, each with what it does where there is room for the widest. */
function starters(status: HomeStatus, look: Look): string[] {
  const { theme } = look;
  const list = status.project ? IN_A_PROJECT : NO_PROJECT;
  const column = Math.max(...list.map(([command]) => command.length)) + 4;
  const described = TRY_COLUMN + column + Math.max(...list.map(([, does]) => does.length)) <= look.width;
  return list.map(([command, does], i) =>
    (i === 0 ? `${theme.paint("muted", "Try")}   ` : "      ")
    + (described ? padEnd(paintCommand(command, look), column) + theme.paint("muted", does) : paintCommand(command, look)));
}

function statusLines(status: HomeStatus, look: Look, room: number): string[] {
  const { theme } = look;
  const { installed, updates } = status.extensions;
  return flowDots([
    status.graphics ?? theme.paint("muted", "graphics not known yet"),
    count(installed, "extension", "extensions"),
    updates === null ? "" : updates > 0 ? theme.paint("amber", count(updates, "update", "updates")) : theme.paint("muted", "up to date"),
  ], room, look);
}

function notes(status: HomeStatus, look: Look, room: number): string[] {
  if (status.settingsShared) return [];
  return wrapText("Safelight hasn't shared its settings yet. Open the app once, then come back.", room - 2)
    .map((line, i) => `${i === 0 ? look.theme.paint("amber", look.glyphs.warn) : " "} ${line}`);
}

function projectFacts(status: HomeStatus, look: Look, room: number): string[] {
  const project = status.project;
  if (!project) return [];
  return flowDots([
    count(project.photos, "photo", "photos"),
    `${project.edited} edited`,
    project.picks !== undefined ? count(project.picks, "pick", "picks") : "",
  ], room, look);
}

const READ_ONLY = "Safelight has it open, so changes here will be refused. Close it there to edit.";
const NO_PROJECT_HERE = "cd into a folder Safelight has opened, or open this one in Safelight once.";

function projectCard(status: HomeStatus, look: Look, width: number): string[] {
  const { glyphs, theme } = look;
  const inner = width - 4;
  const folder = theme.paint("muted", clipStart(status.cwd, inner, glyphs.ellipsis));
  const project = status.project;
  if (!project) {
    return panel({ title: theme.paint("strong", "No project here"), body: [...wrapText(NO_PROJECT_HERE, inner), folder], width }, look);
  }
  const readOnly = status.guiHasProjectOpen;
  return panel({
    title: theme.paint("strong", clip(glyphs.fold(project.name), inner - (readOnly ? 16 : 2), glyphs.ellipsis)),
    note: readOnly ? pill("read only", "amber", look) : undefined,
    body: [...projectFacts(status, look, inner), folder, ...(readOnly ? wrapText(READ_ONLY, inner).map((line) => theme.paint("muted", line)) : [])],
    width,
  }, look);
}

export interface HomeLayout {
  /** The whole screen, a leading and a trailing blank line included. */
  lines: string[];
  /** Where the logo sits in `lines`, for the warm-up to repaint; null in the compact form. */
  bulb: { top: number; left: number; rows: number } | null;
}

export function homeLayout(status: HomeStatus, look: Look, warmth = 1): HomeLayout {
  const { glyphs, theme } = look;
  const name = `${theme.paint("strong", "Safelight")} ${theme.paint("muted", "Unplugged")}`;
  const version = theme.paint("muted", status.version);
  const finish = (lines: readonly string[]): string[] => lines.map((line) => line.trimEnd());

  if (look.columns < LOGO_FROM) {
    const project = status.project;
    const room = look.width;
    return {
      lines: finish(indent([
        "",
        `${theme.paint("bulb", glyphs.lamp[Math.floor(glyphs.lamp.length / 2)])} ${name} ${version}`,
        "",
        ...(project
          ? [theme.paint("strong", clip(glyphs.fold(project.name), room, glyphs.ellipsis)), ...projectFacts(status, look, room)]
          : wrapText(NO_PROJECT_HERE, room)),
        theme.paint("muted", clipStart(status.cwd, room, glyphs.ellipsis)),
        ...(project && status.guiHasProjectOpen ? wrapText(READ_ONLY, room - 2).map((line, i) => `${i === 0 ? theme.paint("amber", glyphs.warn) : " "} ${line}`) : []),
        ...statusLines(status, look, room),
        ...notes(status, look, room),
        "",
        ...starters(status, look),
        "",
      ], MARGIN)),
      bulb: null,
    };
  }

  const logo = bulbRows(look, warmth);
  const room = look.columns - BULB_MARGIN - 1;
  const cardWidth = Math.min(CARD_WIDTH, room);
  const below = [
    padEnd(name, cardWidth - cells(version)) + version,
    "",
    ...projectCard(status, look, cardWidth),
    ...statusLines(status, look, room),
    ...notes(status, look, room),
  ];
  return {
    lines: finish([
      "",
      ...indent(logo, BULB_MARGIN),
      "",
      ...indent(below, BULB_MARGIN),
      "",
      ...indent(starters(status, look), MARGIN),
      "",
    ]),
    bulb: { top: 1, left: BULB_MARGIN, rows: logo.length },
  };
}
