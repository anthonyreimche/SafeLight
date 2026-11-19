// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { formatHome, formatPrompt, formatReplNote, resolveOutputOptions } from "./index";
import type { HomeStatus, OutputOptions } from "./index";
import { LOGO_ART, LOGO_ART_WIDTH } from "./logo/art";
import { stripStyle, visibleWidth } from "./palette";

interface Look { colour?: boolean; unicode?: boolean; trueColour?: boolean }

const at = (width: number, look: Look = {}): OutputOptions => ({
  colour: { stdout: look.colour ?? false, stderr: look.colour ?? false },
  unicode: look.unicode ?? true,
  width,
  trueColour: look.trueColour,
  verbosity: "normal",
});

const screen = (...lines: string[]): string => `${lines.join("\n")}\n`;

const ROOT = String.raw`D:\Photos\2026\Iceland 2026`;
const IN_PROJECT: HomeStatus = {
  version: "3.3.0",
  cwd: String.raw`${ROOT}\Day 3 glacier lagoon\selects`,
  project: { root: ROOT, name: "Iceland 2026", photos: 412, edited: 87 },
  guiHasProjectOpen: false,
  graphics: "d3d11",
  settingsShared: true,
  extensions: { installed: 14, updates: 2 },
};
const NOWHERE: HomeStatus = {
  version: "3.3.0",
  cwd: String.raw`C:\Users\sam`,
  project: null,
  guiHasProjectOpen: false,
  graphics: null,
  settingsShared: false,
  extensions: { installed: 0, updates: null },
};

const B = "\x1b[1m";
const D = "\x1b[2m";
const N = "\x1b[22m";
const AMBER = "\x1b[38;5;166m";
const FG = "\x1b[39m";
const BRAND = "\x1b[38;2;243;34;63m";
const BRAND_SHADE = "\x1b[38;2;196;26;50m";
const RED = "\x1b[38;5;196m";
const RED_SHADE = "\x1b[38;5;160m";

const LOGO_LINES = LOGO_ART.map((row) => (row === "" ? "" : `  ${row}`));
/** One column short of the logo, its margin and a cell to spare. */
const NARROW = LOGO_ART_WIDTH + 2;

describe("formatHome", () => {
  it("draws the logo exactly as drawn, then the title and status at 80 columns", () => {
    expect(formatHome(IN_PROJECT, at(80))).toBe(screen(
      "",
      ...LOGO_LINES,
      "",
      "  Safelight Unplugged 3.3.0",
      "",
      "  Project     Iceland 2026 · 412 photos · 87 edited",
      String.raw`  Folder      D:\Photos\2026\Iceland 2026\Day 3 glacier lagoon\selects`,
      "  Graphics    d3d11",
      "  Extensions  14 installed · 2 updates",
      "",
      "  Try",
      "    photos                       list this project's photos",
      "    tools <photo>                a photo's tools and values",
      "    set <photo> exposure=+0.5    change a value",
      "    help                         every command",
      "    exit to leave",
      "",
    ));
  });

  it("draws the same logo where Unicode won't arrive: it is ASCII already", () => {
    const text = formatHome(IN_PROJECT, at(80, { unicode: false }));
    expect(text.split("\n").slice(1, 1 + LOGO_LINES.length)).toEqual(LOGO_LINES);
    expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("shortens a long folder from the left to fit, and nothing else moves", () => {
    const deep = { ...IN_PROJECT, cwd: `${ROOT}\\${"deeper\\".repeat(12)}selects` };
    const folderAt = LOGO_LINES.length + 5;
    const narrow = formatHome(deep, at(80)).split("\n");
    expect(narrow[folderAt]).toMatch(/^ {2}Folder {6}….*\\selects$/);
    expect(visibleWidth(narrow[folderAt])).toBeLessThanOrEqual(80);
    const wide = formatHome(deep, at(120)).split("\n");
    expect(wide.filter((_, i) => i !== folderAt)).toEqual(narrow.filter((_, i) => i !== folderAt));
  });

  it("leaves the logo out where it doesn't fit", () => {
    expect(formatHome(IN_PROJECT, at(LOGO_ART_WIDTH + 3))).toContain(LOGO_LINES[0]);
    expect(formatHome(IN_PROJECT, at(LOGO_ART_WIDTH + 2)).split("\n")[1]).toBe("● Safelight Unplugged 3.3.0");
  });

  it("stacks under a one-line lamp where the logo doesn't fit", () => {
    expect(formatHome(IN_PROJECT, at(NARROW))).toBe(screen(
      "",
      "● Safelight Unplugged 3.3.0",
      "",
      "Project     Iceland 2026 · 412 photos",
      "            87 edited",
      String.raw`Folder      …ay 3 glacier lagoon\selects`,
      "Graphics    d3d11",
      "Extensions  14 installed · 2 updates",
      "",
      "Try",
      "  photos",
      "  tools <photo>",
      "  set <photo> exposure=+0.5",
      "  help",
      "  exit to leave",
      "",
    ));
    expect(formatHome(IN_PROJECT, at(NARROW, { unicode: false }))).toBe(screen(
      "",
      "(o) Safelight Unplugged 3.3.0",
      "",
      "Project     Iceland 2026 - 412 photos",
      "            87 edited",
      String.raw`Folder      ...3 glacier lagoon\selects`,
      "Graphics    d3d11",
      "Extensions  14 installed - 2 updates",
      "",
      "Try",
      "  photos",
      "  tools <photo>",
      "  set <photo> exposure=+0.5",
      "  help",
      "  exit to leave",
      "",
    ));
  });

  it("says where to go when the folder is in no project, and that the app hasn't shared its settings", () => {
    expect(formatHome(NOWHERE, at(80))).toBe(screen(
      "",
      ...LOGO_LINES,
      "",
      "  Safelight Unplugged 3.3.0",
      "",
      "  Project     no project here: cd into a folder Safelight opened",
      String.raw`  Folder      C:\Users\sam`,
      "  Graphics    not known yet",
      "  Extensions  0 installed",
      "",
      "  ! Safelight hasn't shared its settings yet. Open the app once, then come back.",
      "",
      "  Try",
      "    doctor        check this setup",
      "    extensions    list installed extensions",
      "    help          every command",
      "    exit to leave",
      "",
    ));
    expect(formatHome(NOWHERE, at(NARROW, { unicode: false }))).toBe(screen(
      "",
      "(o) Safelight Unplugged 3.3.0",
      "",
      "Project     no project here: cd into a",
      "            folder Safelight opened",
      String.raw`Folder      C:\Users\sam`,
      "Graphics    not known yet",
      "Extensions  0 installed",
      "",
      "! Safelight hasn't shared its settings",
      "  yet. Open the app once, then come",
      "  back.",
      "",
      "Try",
      "  doctor",
      "  extensions",
      "  help",
      "  exit to leave",
      "",
    ));
  });

  it("warns when Safelight has the project open", () => {
    const text = formatHome({ ...IN_PROJECT, guiHasProjectOpen: true, extensions: { installed: 1, updates: 0 } }, at(80));
    expect(text).toContain([
      "  Extensions  1 installed · up to date",
      "",
      "  ! Safelight has this project open, so changes here will be refused. Close it",
      "    there to edit.",
      "",
      "  Try",
    ].join("\n"));
    expect(formatHome({ ...NOWHERE, guiHasProjectOpen: true }, at(80))).not.toContain("has this project open");
  });

  it("counts one photo and one update in the singular", () => {
    const text = formatHome({ ...IN_PROJECT, project: { root: ROOT, name: "Roll 12", photos: 1, edited: 0 }, extensions: { installed: 3, updates: 1 } }, at(80));
    expect(text).toContain("Roll 12 · 1 photo · 0 edited");
    expect(text).toContain("3 installed · 1 update\n");
  });

  it("paints the globe in the brand red with its shade, the lettering and base bold and the caption dim, with amber only for the update", () => {
    const text = formatHome(IN_PROJECT, at(80, { colour: true, trueColour: true }));
    expect(text).toContain(`${BRAND}---${FG}${BRAND_SHADE}..........${FG}`);
    expect(text).toContain(`${B}##+######${N}`);
    expect(text).toContain(`${B}/___/\\_,_/_/${N}`);
    expect(text).toContain(`${D}u${N} ${D}n${N}`);
    expect(text).toContain(`${AMBER}2 updates${FG}`);
    const belowLogo = text.split("\n").slice(1 + LOGO_LINES.length).join("\n");
    expect(belowLogo).not.toContain(BRAND);
    expect(belowLogo).not.toContain(BRAND_SHADE);
  });

  it("falls back to the 256-colour reds", () => {
    const text = formatHome(IN_PROJECT, at(80, { colour: true }));
    expect(text).toContain(`${RED}---${FG}${RED_SHADE}..........${FG}`);
    expect(text).not.toContain("38;2;");
    expect(formatHome(IN_PROJECT, at(NARROW, { colour: true })).split("\n")[1])
      .toBe(`${RED}●${FG} ${B}Safelight${N} ${D}Unplugged 3.3.0${N}`);
  });

  it("marks a warning in amber and leaves its words alone", () => {
    expect(formatHome(NOWHERE, at(80, { colour: true })))
      .toContain(`  ${AMBER}!${FG} Safelight hasn't shared its settings yet. Open the app once, then come back.`);
  });

  it("changes no text, moves no column and fits the width, with colour on or off", () => {
    for (const status of [IN_PROJECT, NOWHERE, { ...IN_PROJECT, guiHasProjectOpen: true }]) {
      for (const width of [40, 59, 60, 80, 120]) {
        for (const unicode of [true, false]) {
          const plain = formatHome(status, at(width, { unicode }));
          expect(plain).not.toContain("\x1b");
          expect(plain.endsWith("\n")).toBe(true);
          for (const line of plain.split("\n")) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(width);
            expect(line).toBe(line.trimEnd());
          }
          if (!unicode) expect(plain).toMatch(/^[\x20-\x7e\n]*$/);
          for (const trueColour of [true, false]) {
            expect(stripStyle(formatHome(status, at(width, { unicode, colour: true, trueColour })))).toBe(plain);
          }
        }
      }
    }
  });

});

describe("formatPrompt", () => {
  it("shows the project faint and an amber mark", () => {
    expect(formatPrompt({ projectName: "Iceland 2026" }, at(80))).toBe("Iceland 2026 › ");
    expect(formatPrompt({ projectName: "Iceland 2026" }, at(80, { unicode: false }))).toBe("Iceland 2026 > ");
    expect(formatPrompt({ projectName: "Iceland 2026" }, at(80, { colour: true }))).toBe(`${D}Iceland 2026${N} ${AMBER}›${FG} `);
  });

  it("names the command when there's no project", () => {
    expect(formatPrompt({ projectName: null }, at(80))).toBe("safelight › ");
  });

  it("goes faint with an ellipsis while a command runs", () => {
    expect(formatPrompt({ projectName: "Iceland 2026", busy: true }, at(80))).toBe("Iceland 2026 … ");
    expect(formatPrompt({ projectName: null, busy: true }, at(80, { unicode: false }))).toBe("safelight ... ");
    expect(formatPrompt({ projectName: "Iceland 2026", busy: true }, at(80, { colour: true }))).toBe(`${D}Iceland 2026 …${N} `);
  });

  it("shortens a long project name", () => {
    expect(formatPrompt({ projectName: "Wedding of Priya and Jonathan, Tofino" }, at(80))).toBe("Wedding of Priya and Jo… › ");
  });
});

describe("formatReplNote", () => {
  it("says how to leave, goodbye and cancelled in one faint line", () => {
    expect(formatReplNote("interrupt", at(80))).toBe("Type exit or press Ctrl+D to leave.");
    expect(formatReplNote("bye", at(80))).toBe("Bye.");
    expect(formatReplNote("cancelled", at(80))).toBe("Cancelled.");
    expect(formatReplNote("interrupt", at(80, { colour: true }))).toBe(`${D}Type exit or press Ctrl+D to leave.${N}`);
    expect(formatReplNote("cancelled", at(80, { colour: true }))).toBe(`${D}Cancelled.${N}`);
  });

  it("quotes what isn't a command and points at help", () => {
    expect(formatReplNote("unknown", at(80), "fotos")).toBe("\"fotos\" isn't a command. Type help to see them all.");
    expect(formatReplNote("unknown", at(80, { colour: true }), "fotos")).toBe(`"fotos" isn't a command. ${D}Type help to see them all.${N}`);
    expect(formatReplNote("unknown", at(80))).toBe("That isn't a command. Type help to see them all.");
    expect(formatReplNote("unknown", at(80, { unicode: false }), "set IMG_4021.ARW contrast=12 shadows=25 whites=4"))
      .toBe("\"set IMG_4021.ARW contrast=12...\" isn't a command. Type help to see them all.");
  });
});

describe("resolveOutputOptions trueColour", () => {
  const stream = Object.assign(new Writable({ write: (_chunk, _enc, done) => done() }), { isTTY: true, columns: 80 }) as unknown as NodeJS.WriteStream;
  const resolve = (env: Record<string, string | undefined>) => resolveOutputOptions({ stdout: stream, stderr: stream }, env, "normal").trueColour;

  it("is on only where the terminal says it takes 24-bit colour", () => {
    expect(resolve({ COLORTERM: "truecolor" })).toBe(true);
    expect(resolve({ WT_SESSION: "1" })).toBe(true);
    expect(resolve({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(resolve({ TERM: "xterm-kitty" })).toBe(true);
    expect(resolve({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" })).toBe(false);
    expect(resolve({})).toBe(false);
  });
});
