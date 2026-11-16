// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `safelight` shows with nothing after it: the bulb, where you are, a few
// commands to start with, then the prompt. The bulb is the only red on the
// screen. Everything else is the terminal's own foreground, faint or amber.

import { flowChunks, truncateEnd, truncateStart, wrapText } from "./format";
import { LOGO_ART, LOGO_ART_WIDTH, paintLogoRow } from "./logo/art";
import { createPalette, glyphsFor, sgr } from "./palette";
import type { Style } from "./palette";
import type { HomeStatus, OutputOptions, PromptState, ReplNoteKind } from "./types";
import { COMMAND } from "../types";

const MIN_WIDTH = 40;
/** Past this the screen stops widening, so a path never runs the width of a wide window. */
const MAX_WIDTH = 96;
const MARGIN = "  ";
/** The logo needs its own width, its margin and a cell to spare. */
const LOGO_FROM = LOGO_ART_WIDTH + MARGIN.length + 1;
const GAP = "    ";
const LABEL_COLUMN = 12;
const NAME_LIMIT = 24;
const TYPED_LIMIT = 32;

// The logo's #f3223f for the globe. Without 24-bit colour it comes from the
// 256-colour cube.
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

function logoRows(look: Look): string[] {
  const { palette, red } = look;
  const paint = { globe: (text: string) => red(text), shade: (text: string) => red(text, "shade"), stroke: palette.heading, caption: palette.dim };
  return LOGO_ART.map((row) => paintLogoRow(row, (part, text) => paint[part](text)));
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

/** The starter commands, each with what it does where `describe` and there is room for the widest. */
function starters(status: HomeStatus, look: Look, indent: string, describe: boolean): string[] {
  const { palette } = look;
  const list = status.project ? IN_A_PROJECT : NO_PROJECT;
  const column = Math.max(...list.map(([command]) => command.length)) + GAP.length;
  const described = describe && indent.length + 2 + column + Math.max(...list.map(([, does]) => does.length)) <= look.width;
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

  if (opts.width < LOGO_FROM) {
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

  return finish([
    "",
    ...logoRows(look).map((row) => MARGIN + row),
    "",
    `${MARGIN}${title} ${edition}`,
    "",
    ...statusLines(statusRows(status, look, width - MARGIN.length - LABEL_COLUMN), look).map((line) => MARGIN + line),
    "",
    ...section(warnings(status, look, MARGIN)),
    ...starters(status, look, MARGIN, true),
    "",
  ]);
}

/** "3 photos", or "DSC_0412 2/3" with the place left off when it is the only one open. */
export function openText(open: NonNullable<PromptState["open"]>): string {
  if (open.name === undefined) return `${open.of} ${open.of === 1 ? "photo" : "photos"}`;
  return open.of > 1 && open.at !== undefined ? `${open.name} ${open.at}/${open.of}` : open.name;
}

/**
 * The prompt: the project's name, faint, and an amber "›". Inside the project
 * it carries the folder, with photos open the working set, and "read only"
 * while Safelight has the project. While a command runs it all goes faint.
 */
export function formatPrompt(state: PromptState, opts: OutputOptions): string {
  const { palette, glyphs } = lookFor(opts);
  const mark = opts.unicode ? "›" : ">";
  const where = truncateEnd(glyphs.fold(state.projectName ?? COMMAND), NAME_LIMIT, glyphs)
    + (state.folder ? `/${truncateStart(glyphs.fold(state.folder), NAME_LIMIT, glyphs)}` : "");
  const name = [where, state.open ? `${mark} ${glyphs.fold(openText(state.open))}` : "", state.readOnly ? "(read only)" : ""]
    .filter((part) => part !== "").join(" ");
  if (state.busy) return `${palette.dim(`${name} ${glyphs.ellipsis}`)} `;
  return `${palette.dim(name)} ${palette.accent(mark)} `;
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
