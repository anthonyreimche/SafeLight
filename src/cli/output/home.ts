// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `safelight` shows with nothing after it: the bulb, where you are, a few
// commands to start with, then the prompt. The bulb is the only red on the
// screen. Everything else is the terminal's own foreground, faint or amber.

import { flowChunks, truncateEnd, truncateStart, wrapText } from "./format";
import { createPalette, glyphsFor, sgr } from "./palette";
import type { Style } from "./palette";
import type { HomeStatus, OutputOptions, PromptState, ReplNoteKind } from "./types";
import { COMMAND } from "../types";

const MIN_WIDTH = 40;
/** Past this the screen stops widening, so a path never runs the width of a wide window. */
const MAX_WIDTH = 96;
const COMPACT_BELOW = 60;
const MARGIN = "  ";
const GAP = "    ";
const LABEL_COLUMN = 12;
const NAME_LIMIT = 24;
const TYPED_LIMIT = 32;

type Tone = "lit" | "shade" | "base";
type Art = readonly (readonly [text: string, tone: Tone])[];

// Half blocks only: every console font has them, and two to a cell they make
// square pixels, so the globe stays round.
const BULB: Art = [
  ["  ▄▄████▄▄", "lit"],
  ["▄██████████▄", "lit"],
  ["████████████", "lit"],
  ["▀██████████▀", "lit"],
  [" ▀████████▀", "shade"],
  ["   ▀████▀", "shade"],
  ["    ████", "base"],
  ["     ▀▀", "base"],
];

const BULB_ASCII: Art = [
  ["  .-\"\"\"\"-.", "lit"],
  [" /        \\", "lit"],
  ["|          |", "lit"],
  [" \\        /", "lit"],
  ["  '.    .'", "shade"],
  ["   |====|", "base"],
  ["   |====|", "base"],
  ["    '=='", "base"],
];

const BULB_WIDTH = 12;

// The logo's #f3223f and a darker turn of it for the underside. Without 24-bit
// colour the same two steps come from the 256-colour cube.
const RED = { lit: "38;2;243;34;63", shade: "38;2;196;26;50" };
const RED_256 = { lit: "38;5;196", shade: "38;5;160" };

interface Look extends Style {
  red(text: string, tone?: "lit" | "shade"): string;
}

function lookFor(opts: OutputOptions): Look {
  const palette = createPalette(opts.colour.stdout);
  const reds = opts.trueColour ? RED : RED_256;
  return {
    palette,
    glyphs: glyphsFor(opts.unicode),
    width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, opts.width)),
    red: (text, tone = "lit") => (palette.enabled ? sgr(reds[tone], "39")(text) : text),
  };
}

function bulbRows(look: Look): string[] {
  const art = look.glyphs === glyphsFor(true) ? BULB : BULB_ASCII;
  return art.map(([text, tone]) => {
    const ink = text.trimStart();
    const painted = tone === "base" ? look.palette.dim(ink) : look.red(ink, tone);
    return " ".repeat(text.length - ink.length) + painted + " ".repeat(BULB_WIDTH - text.length);
  });
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

interface StatusRow { label: string; value: string[] }

function statusRows(status: HomeStatus, look: Look, room: number): StatusRow[] {
  const { palette, glyphs } = look;
  const dot = palette.dim(glyphs.dot);
  const flow = (parts: readonly string[], paint: (part: string, at: number) => string): string[] => {
    let at = 0;
    return flowChunks(parts, glyphs.dot, room).map((line) => line.map((part) => paint(part, at++)).join(dot));
  };

  const project = status.project;
  const projectValue = project
    ? flow(
      [truncateEnd(glyphs.fold(project.name), room, glyphs), count(project.photos, "photo", "photos"), `${project.edited} edited`],
      (part, at) => (at === 0 ? part : palette.dim(part)),
    )
    : wrapText("no project here: cd into a folder Safelight opened", room);

  const { installed, updates } = status.extensions;
  const extensions = [`${installed} installed`];
  if (updates !== null) extensions.push(updates > 0 ? count(updates, "update", "updates") : "up to date");

  return [
    { label: "Project", value: projectValue },
    { label: "Folder", value: [palette.dim(truncateStart(status.cwd, room, glyphs))] },
    { label: "Graphics", value: [status.graphics ?? palette.dim("not known yet")] },
    {
      label: "Extensions",
      value: flow(extensions, (part, at) => (at === 0 ? part : updates ? palette.accent(part) : palette.dim(part))),
    },
  ];
}

function statusLines(rows: readonly StatusRow[], look: Look): string[] {
  return rows.flatMap((row) => row.value.map(
    (line, i) => (i === 0 ? look.palette.dim(row.label) + " ".repeat(LABEL_COLUMN - row.label.length) : " ".repeat(LABEL_COLUMN)) + line,
  ));
}

function warnings(status: HomeStatus, look: Look, indent: string): string[] {
  const notes: string[] = [];
  if (status.project && status.guiHasProjectOpen) {
    notes.push("Safelight has this project open, so changes here will be refused. Close it there to edit.");
  }
  if (!status.settingsShared) {
    notes.push("Safelight hasn't shared its settings yet. Open the app once, then come back.");
  }
  return notes.flatMap((note) => wrapText(note, look.width - indent.length - 2).map(
    (line, i) => `${indent}${i === 0 ? look.palette.accent("!") : " "} ${line}`,
  ));
}

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

function starters(status: HomeStatus, look: Look, indent: string, described: boolean): string[] {
  const { palette } = look;
  const list = status.project ? IN_A_PROJECT : NO_PROJECT;
  const column = Math.max(...list.map(([command]) => command.length)) + GAP.length;
  return [
    indent + palette.dim("Try"),
    ...list.map(([command, does]) => `${indent}  ${described ? command.padEnd(column) + palette.dim(does) : command}`),
    `${indent}  exit ${palette.dim("to leave")}`,
  ];
}

function finish(lines: readonly string[]): string {
  return `${lines.map((line) => line.trimEnd()).join("\n")}\n`;
}

/** The banner, status and a few starter commands, ending with a newline. */
export function formatHome(status: HomeStatus, opts: OutputOptions): string {
  const look = lookFor(opts);
  const { palette, width } = look;
  const title = palette.heading("Safelight");
  const edition = palette.dim(`Unplugged ${status.version}`);
  const section = (lines: readonly string[]): string[] => (lines.length > 0 ? [...lines, ""] : []);

  if (opts.width < COMPACT_BELOW) {
    const lamp = look.red(opts.unicode ? "●" : "(o)");
    return finish([
      "",
      `${lamp} ${title} ${edition}`,
      "",
      ...statusLines(statusRows(status, look, width - LABEL_COLUMN), look),
      "",
      ...section(warnings(status, look, "")),
      ...starters(status, look, "", false),
      "",
    ]);
  }

  const beside = MARGIN.length + BULB_WIDTH + GAP.length;
  const text = ["", title, edition, "", ...statusLines(statusRows(status, look, width - beside - LABEL_COLUMN), look)];
  const bulb = bulbRows(look);
  const banner = Array.from({ length: Math.max(bulb.length, text.length) }, (_, i) =>
    MARGIN + (bulb[i] ?? " ".repeat(BULB_WIDTH)) + GAP + (text[i] ?? ""));

  return finish([
    "",
    ...banner,
    "",
    ...section(warnings(status, look, MARGIN)),
    ...starters(status, look, MARGIN, true),
    "",
  ]);
}

/** The prompt: the project's name, faint, and an amber "›". While a command runs it all goes faint. */
export function formatPrompt(state: PromptState, opts: OutputOptions): string {
  const { palette, glyphs } = lookFor(opts);
  const name = truncateEnd(glyphs.fold(state.projectName ?? COMMAND), NAME_LIMIT, glyphs);
  if (state.busy) return `${palette.dim(`${name} ${glyphs.ellipsis}`)} `;
  return `${palette.dim(name)} ${palette.accent(opts.unicode ? "›" : ">")} `;
}

/** One-line notices at the prompt, without a newline. `text` is the line typed, for "unknown". */
export function formatReplNote(kind: ReplNoteKind, opts: OutputOptions, text?: string): string {
  const { palette, glyphs } = lookFor(opts);
  switch (kind) {
    case "interrupt":
      return palette.dim("Type exit or press Ctrl+D to leave.");
    case "bye":
      return palette.dim("Bye.");
    case "cancelled":
      return palette.dim("Cancelled.");
    case "unknown": {
      const typed = text?.trim();
      const what = typed ? `"${truncateEnd(glyphs.fold(typed), TYPED_LIMIT, glyphs)}" isn't a command.` : "That isn't a command.";
      return `${what} ${palette.dim("Type help to see them all.")}`;
    }
  }
}
