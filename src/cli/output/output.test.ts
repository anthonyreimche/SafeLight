// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import type { HelpGroup, ToolRef, ValueInfo } from "../types";
import { createOutput, resolveOutputOptions } from "./index";
import type { HelpVerb, Output, OutputOptions, ToolRow } from "./index";
import { stripStyle } from "./palette";

function sink(isTTY: boolean, columns = 80) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { stream: Object.assign(stream, { isTTY, columns }) as unknown as NodeJS.WriteStream, text: () => chunks.join("") };
}

interface Look { width?: number; colour?: boolean; unicode?: boolean; verbosity?: OutputOptions["verbosity"]; tty?: boolean }

function output(look: Look = {}) {
  const stdout = sink(look.tty ?? false);
  const stderr = sink(look.tty ?? false);
  const colour = look.colour ?? false;
  const out = createOutput({ stdout: stdout.stream, stderr: stderr.stream }, {
    colour: { stdout: colour, stderr: colour },
    unicode: look.unicode ?? true,
    width: look.width ?? 120,
    verbosity: look.verbosity ?? "normal",
  });
  return { out, stdout: stdout.text, stderr: stderr.text };
}

const builder = (look: Look = {}): Output => output(look).out;

const B = "\x1b[1m";
const D = "\x1b[2m";
const N = "\x1b[22m";
const AMBER = "\x1b[38;5;166m";
const RED = "\x1b[31m";
const FG = "\x1b[39m";

const tool = (name: string, order: number): ToolRef => ({
  id: name.toLowerCase().replace(/ /g, "-"), name, kind: "core", installed: true, enabled: true, settable: true, order, hasCommitHooks: false,
});
const WB = tool("White Balance", 1);
const BASIC = tool("Basic", 2);
const DETAIL = tool("Detail", 3);
const LOCAL = tool("Local Contrast", 4);
const RETINEX = tool("Retinex", 5);

const number = (t: ToolRef, key: string, min: number, max: number, more: Partial<ValueInfo> = {}): ValueInfo => ({
  key, label: key[0].toUpperCase() + key.slice(1), tool: t, kind: "number", min, max, settable: true, ...more,
});

const TEMPERATURE = number(WB, "temperature", 2000, 50000, { unit: "K" });
const TINT = number(WB, "tint", -150, 150);
const EXPOSURE = number(BASIC, "exposure", -5, 5, { unit: "EV", decimals: 2 });
const CONTRAST = number(BASIC, "contrast", -100, 100);
const SHARPENING = number(DETAIL, "sharpening", 0, 150);
const ROTATE = number(BASIC, "rotate", -45, 45, { unit: "°", decimals: 1 });
const LC_ON: ValueInfo = { key: "on", label: "On", tool: LOCAL, kind: "switch", settable: true };
const LC_MODE: ValueInfo = {
  key: "mode", label: "Mode", tool: LOCAL, kind: "choice", settable: true,
  choices: [{ value: "laplacian", label: "Laplacian" }, { value: "bilateral", label: "Bilateral" }],
};
const LC_DETAIL = number(LOCAL, "detail", -1, 4, { step: 0.01 });
const LC_MIDTONE = number(LOCAL, "midtone", 0.001, 1);
const RX_STRENGTH: ValueInfo = { key: "strength", label: "Strength", tool: RETINEX, kind: "number", settable: true, rangeUnknown: true };
const RX_RADIUS: ValueInfo = { key: "radius", label: "Radius", tool: RETINEX, kind: "number", settable: true, rangeUnknown: true };

const TOOLS: ToolRow[] = [
  {
    tool: "White Balance", state: "in use", values: [
      { info: TEMPERATURE, value: 5150, changed: false, note: "(as shot 5150)" },
      { info: TINT, value: 0, changed: false },
    ],
  },
  {
    tool: "Basic", values: [
      { info: EXPOSURE, value: 0.7, changed: true },
      { info: CONTRAST, value: -12, changed: true },
    ],
  },
  { tool: "Detail", values: [{ info: SHARPENING, value: 25, changed: false }] },
  {
    tool: "Local Contrast", state: "idle", values: [
      { info: LC_ON, value: false, changed: false },
      { info: LC_MODE, value: "laplacian", changed: false },
      { info: LC_DETAIL, value: 0.25, changed: false },
      { info: LC_MIDTONE, value: 0.5, changed: false },
    ],
  },
  {
    tool: "Retinex", state: "not installed", values: [
      { info: RX_STRENGTH, value: 40, changed: true },
      { info: RX_RADIUS, value: 80, changed: false },
    ],
  },
  { tool: "Contrast Equalizer", state: "idle", values: [] },
];

const GROUPED: Record<HelpGroup, string[]> = {
  Look: ["photos", "tools", "get", "history", "preview"],
  Edit: ["set", "add", "remove", "reset", "auto", "undo", "redo"],
  Share: ["copy", "paste", "presets", "apply", "save-preset"],
  Organize: ["rate", "flag", "label"],
  Output: ["export"],
  Extensions: ["search", "install", "uninstall", "update", "extensions", "enable", "disable"],
  More: ["doctor", "version", "help"],
};
const VERBS: HelpVerb[] = (Object.keys(GROUPED) as HelpGroup[]).flatMap((group) =>
  GROUPED[group].map((verb) => ({ verb, group, summary: "" })));

describe("resolveOutputOptions", () => {
  const resolve = (env: Record<string, string | undefined>, tty = true, columns = 100) =>
    resolveOutputOptions({ stdout: sink(tty, columns).stream, stderr: sink(tty, columns).stream }, env, "normal");

  it("colours a terminal and nothing else", () => {
    expect(resolve({}).colour).toEqual({ stdout: true, stderr: true });
    expect(resolve({}, false).colour).toEqual({ stdout: false, stderr: false });
  });

  it("decides colour for each stream on its own", () => {
    const options = resolveOutputOptions({ stdout: sink(false).stream, stderr: sink(true).stream }, {}, "normal");
    expect(options.colour).toEqual({ stdout: false, stderr: true });
  });

  it("turns colour off for NO_COLOR and TERM=dumb, and on for FORCE_COLOR", () => {
    expect(resolve({ NO_COLOR: "1" }).colour).toEqual({ stdout: false, stderr: false });
    expect(resolve({ NO_COLOR: "" }).colour.stdout).toBe(true);
    expect(resolve({ TERM: "dumb" }).colour.stdout).toBe(false);
    expect(resolve({ FORCE_COLOR: "1" }, false).colour).toEqual({ stdout: true, stderr: true });
    expect(resolve({ FORCE_COLOR: "0" }, false).colour.stdout).toBe(false);
  });

  it("takes the terminal's width, or 80 when it has none", () => {
    expect(resolve({}).width).toBe(100);
    expect(resolve({}, false, 0).width).toBe(80);
  });

  it("falls back to ASCII where the terminal can't be trusted with more", () => {
    expect(resolve({}).unicode).toBe(true);
    expect(resolve({ LANG: "en_CA.UTF-8" }).unicode).toBe(true);
    expect(resolve({ LANG: "C" }).unicode).toBe(false);
    expect(resolve({ LC_ALL: "POSIX", LANG: "en_CA.UTF-8" }).unicode).toBe(false);
    expect(resolve({ LANG: "en_US.ISO-8859-1" }).unicode).toBe(false);
    expect(resolve({ TERM: "dumb" }).unicode).toBe(false);
    expect(resolve({ TERM: "linux" }).unicode).toBe(false);
  });

  it("uses ASCII on a legacy Windows console and when Windows output is piped", () => {
    expect(resolve({ OS: "Windows_NT" }).unicode).toBe(false);
    expect(resolve({ OS: "Windows_NT", WT_SESSION: "x" }).unicode).toBe(true);
    expect(resolve({ OS: "Windows_NT", TERM_PROGRAM: "vscode" }).unicode).toBe(true);
    expect(resolve({ OS: "Windows_NT", TERM: "xterm-256color" }).unicode).toBe(true);
    expect(resolve({ OS: "Windows_NT", WT_SESSION: "x" }, false).unicode).toBe(false);
  });
});

describe("values", () => {
  const out = builder();
  const ascii = builder({ unicode: false });

  it("writes numbers as the panels do", () => {
    expect(out.formatValue(EXPOSURE, 0.7)).toBe("+0.70 EV");
    expect(out.formatValue(EXPOSURE, -1.25)).toBe("−1.25 EV");
    expect(out.formatValue(EXPOSURE, 0)).toBe("0.00 EV");
    expect(out.formatValue(EXPOSURE, -0.001)).toBe("0.00 EV");
    expect(out.formatValue(TEMPERATURE, 5600)).toBe("5600 K");
    expect(out.formatValue(TEMPERATURE, 12500)).toBe("12500 K");
    expect(out.formatValue(CONTRAST, -40)).toBe("−40");
    expect(out.formatValue(CONTRAST, 25)).toBe("+25");
    expect(out.formatValue(SHARPENING, 25)).toBe("25");
    expect(out.formatValue(ROTATE, -2.5)).toBe("−2.5°");
    expect(ascii.formatValue(CONTRAST, -40)).toBe("-40");
  });

  it("takes decimals from the step, then from the number itself", () => {
    expect(out.formatValue(LC_DETAIL, 1.2)).toBe("+1.20");
    expect(out.formatValue(LC_MIDTONE, 0.5)).toBe("0.5");
    expect(out.formatValue(LC_MIDTONE, 0.123456)).toBe("0.1235");
  });

  it("writes switches, choices and ids in words", () => {
    expect(out.formatValue(LC_ON, true)).toBe("on");
    expect(out.formatValue(LC_ON, false)).toBe("off");
    expect(out.formatValue(LC_MODE, "bilateral")).toBe("Bilateral");
    expect(out.formatValue(LC_MODE, "other")).toBe("other");
    expect(out.formatValue({ ...LC_ON, kind: "id" }, null)).toBe("default");
  });

  it("writes ranges without padding", () => {
    expect(out.formatRange(EXPOSURE)).toBe("−5…5");
    expect(out.formatRange(TEMPERATURE)).toBe("2000…50000");
    expect(out.formatRange(LC_MIDTONE)).toBe("0.001…1");
    expect(out.formatRange(LC_MODE)).toBe("laplacian | bilateral");
    expect(out.formatRange(LC_ON)).toBe("on | off");
    expect(out.formatRange(RX_STRENGTH)).toBe("ranges unknown");
    expect(ascii.formatRange(EXPOSURE)).toBe("-5...5");
  });
});

describe("help", () => {
  it("is the help screen of the command reference", () => {
    expect(builder({ width: 120 }).help({ version: "3.3.0", verbs: VERBS })).toBe([
      "Safelight Unplugged 3.3.0: edit photos with commands and values.",
      "",
      "  slu <verb> [photos…] [key=value…] [options]",
      "",
      "Photos: files, globs (*.ARW), folders (-r for subfolders), --all, - (paths on stdin)",
      "        filters: --rating 3+  --flag pick  --label red  --edited",
      "Values: key=5  key+=0.3  key-=10  key=default  temperature=5600K  transform.flipH=on",
      "",
      "Look         photos   tools   get   history   preview",
      "Edit         set   add   remove   reset   auto   undo   redo",
      "Share        copy   paste   presets   apply   save-preset",
      "Organize     rate   flag   label",
      "Output       export",
      "Extensions   search   install   uninstall   update   extensions   enable   disable",
      "More         doctor   version   help <verb>",
      "",
      "Options: --json  -q  -v  --project <folder>  --preview  --yes  --strict  --wait",
      "Docs: https://github.com/anthonyreimche/SafeLight/blob/main/docs/user/unplugged.md",
    ].join("\n"));
  });

  it("continues a row under its own first word at 60 columns", () => {
    expect(builder({ width: 60 }).help({ version: "3.3.0", verbs: VERBS })).toBe([
      "Safelight Unplugged 3.3.0: edit photos with commands and",
      "values.",
      "",
      "  slu <verb> [photos…] [key=value…] [options]",
      "",
      "Photos: files, globs (*.ARW), folders (-r for subfolders),",
      "        --all, - (paths on stdin)",
      "        filters: --rating 3+  --flag pick  --label red",
      "        --edited",
      "Values: key=5  key+=0.3  key-=10  key=default",
      "        temperature=5600K  transform.flipH=on",
      "",
      "Look         photos   tools   get   history   preview",
      "Edit         set   add   remove   reset   auto   undo   redo",
      "Share        copy   paste   presets   apply   save-preset",
      "Organize     rate   flag   label",
      "Output       export",
      "Extensions   search   install   uninstall   update",
      "             extensions   enable   disable",
      "More         doctor   version   help <verb>",
      "",
      "Options: --json  -q  -v  --project <folder>  --preview",
      "         --yes  --strict  --wait",
      "Docs: https://github.com/anthonyreimche/SafeLight/blob/main/docs/user/unplugged.md",
    ].join("\n"));
  });
});

describe("help for one verb", () => {
  const SET = {
    verb: "set",
    usage: "set <photos…> key=value… [options]",
    summary: "Sets values on one photo or many. Each photo gets one history step, however many values change.",
    options: [
      { flag: "--strict", summary: "Stops when a value is past its limit, instead of setting the limit and warning." },
      { flag: "--preview", summary: "Shows the result in the terminal." },
    ],
    examples: ["slu set IMG_4021.ARW exposure=+0.7 highlights=-40", "slu set . --flag pick temperature=5400K"],
  };

  it("wraps the summary and each option under itself at 60 columns", () => {
    expect(builder({ width: 60 }).verbHelp(SET)).toBe([
      "slu set <photos…> key=value… [options]",
      "",
      "Sets values on one photo or many. Each photo gets one",
      "history step, however many values change.",
      "",
      "Options:",
      "  --strict   Stops when a value is past its limit, instead",
      "             of setting the limit and warning.",
      "  --preview  Shows the result in the terminal.",
      "",
      "Examples:",
      "  slu set IMG_4021.ARW exposure=+0.7 highlights=-40",
      "  slu set . --flag pick temperature=5400K",
    ].join("\n"));
  });

  it("sets the verb in bold and the section names faint", () => {
    const lines = builder({ colour: true }).verbHelp(SET).split("\n");
    expect(lines[0]).toBe(`${B}slu set${N} <photos…> key=value… [options]`);
    expect(lines[4]).toBe(`${D}Options:${N}`);
  });

  it("leaves out the sections a verb doesn't have", () => {
    expect(builder().verbHelp({ verb: "version", usage: "version", summary: "Shows the version.", options: [], examples: [] }))
      .toBe("slu version\n\nShows the version.");
  });

  it("writes the usage in ASCII where it must", () => {
    expect(builder({ unicode: false }).verbHelp(SET).split("\n")[0]).toBe("slu set <photos...> key=value... [options]");
  });
});

describe("tool table", () => {
  it("lists tools at 120 columns", () => {
    expect(builder({ width: 120 }).toolTable(TOOLS)).toBe([
      "White Balance  temperature   5150 K      2000…50000  (as shot 5150)",
      "               tint             0        −150…150",
      "Basic          exposure     +0.70 EV  ✱  −5…5",
      "               contrast       −12     ✱  −100…100",
      "Detail         sharpening      25        0…150",
      "Local Contrast  (idle)",
      "               on           off          on | off",
      "               mode         Laplacian    laplacian | bilateral",
      "               detail       +0.25        −1…4",
      "               midtone        0.5        0.001…1",
      "Retinex  (not installed, values kept, ranges unknown)",
      "               strength        40     ✱",
      "               radius          80",
      "Contrast Equalizer  (idle)",
    ].join("\n"));
  });

  it("drops a note, then shortens a range, at 60 columns", () => {
    const lines = builder({ width: 60 }).toolTable(TOOLS).split("\n");
    expect(lines[0]).toBe("White Balance  temperature   5150 K      2000…50000");
    expect(lines[7]).toBe("               mode         Laplacian    laplacian | bilate…");
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(60);
  });

  it("colours tool names, changed marks and ranges, and nothing else", () => {
    const lines = builder({ colour: true }).toolTable(TOOLS).split("\n");
    expect(lines[0]).toBe(`${B}White Balance${N}  temperature   5150 K      ${D}2000…50000  (as shot 5150)${N}`);
    expect(lines[1]).toBe(`               tint             0        ${D}−150…150${N}`);
    expect(lines[2]).toBe(`${B}Basic${N}          exposure     +0.70 EV  ${AMBER}✱${FG}  ${D}−5…5${N}`);
    expect(lines[5]).toBe(`${B}Local Contrast${N}  ${D}(idle)${N}`);
    expect(lines[12]).toBe("               radius          80");
  });

  it("falls back to ASCII", () => {
    const lines = builder({ unicode: false }).toolTable(TOOLS).split("\n");
    expect(lines[2]).toBe("Basic          exposure     +0.70 EV  *  -5...5");
    expect(lines[3]).toBe("               contrast       -12     *  -100...100");
  });

  it("leaves out the changed column when nothing is changed", () => {
    expect(builder().toolTable([TOOLS[2]])).toBe("Detail  sharpening  25  0…150");
  });

  it("says why a value can't be set", () => {
    const curve: ValueInfo = { key: "points", label: "Points", tool: DETAIL, kind: "id", settable: false, notSettableReason: "edit in Safelight" };
    expect(builder().toolTable([{ tool: "Tone Curve", values: [{ info: curve, value: "custom", changed: true }] }]))
      .toBe("Tone Curve  points  custom ✱  edit in Safelight");
  });
});

const PHOTOS = [
  { name: "2026-11-wedding/ceremony/IMG_4021.ARW", rating: 4, flag: "pick" as const, label: "red", edited: true, size: "7008×4672" },
  { name: "IMG_4022.ARW", rating: 0, flag: "none" as const, label: "", edited: false, size: "7008×4672" },
  { name: "DSC_0412.NEF", rating: 1, flag: "reject" as const, label: "none", edited: false },
];

const EXTENSIONS = [
  { name: "Local Contrast", id: "local-contrast", version: "1.0.0", enabled: true, trust: "verified" as const, update: "1.0.1" },
  { name: "Basic", id: "safelight.basic", version: "3.2.5", enabled: true, trust: "official" as const },
  { name: "Pyramid Local Contrast", id: "pyramid-local-contrast", version: "1.1.0", enabled: false, trust: "unverified" as const },
  { name: "Old Thing", id: "old-thing", version: "0.1.0", enabled: false, trust: "banned" as const },
];

const FOUND = [
  { installName: "local-contrast", name: "Local Contrast", version: "1.0.0", category: "tone", trust: "verified" as const },
  { installName: "contrast-and-texture", name: "Contrast & Texture", version: "1.0.2", category: "detail", trust: "verified" as const },
  { installName: "pyramid-local-contrast", name: "Pyramid Local Contrast", version: "1.1.0", category: "detail", trust: "unverified" as const },
];

const at = (hour: number, minute: number): number => new Date(2026, 10, 14, hour, minute).getTime();
const STEPS = [
  { index: 0, label: "Imported", timestamp: at(9, 2), current: false },
  { index: 1, label: "Exposure +0.70 EV", timestamp: at(9, 5), current: false },
  { index: 2, label: "Highlights −40", timestamp: at(9, 6), current: true },
  { index: 10, label: "Local Contrast on", timestamp: at(21, 30), current: false },
];

describe("photo table", () => {
  it("lists photos under a header at 120 columns", () => {
    expect(builder({ width: 120 }).photoTable(PHOTOS)).toBe([
      "Photo                                  Rating  Flag    Label  Edited  Size",
      "2026-11-wedding/ceremony/IMG_4021.ARW  ★★★★    pick    red    edited  7008×4672",
      "IMG_4022.ARW                           ·       ·       ·      ·       7008×4672",
      "DSC_0412.NEF                           ★       reject  ·      ·",
    ].join("\n"));
  });

  it("keeps the file name when a path has to give at 60 columns", () => {
    expect(builder({ width: 60 }).photoTable(PHOTOS)).toBe([
      "Photo               Rating  Flag    Label  Edited  Size",
      "…mony/IMG_4021.ARW  ★★★★    pick    red    edited  7008×4672",
      "IMG_4022.ARW        ·       ·       ·      ·       7008×4672",
      "DSC_0412.NEF        ★       reject  ·      ·",
    ].join("\n"));
  });

  it("sets the header and the empty cells faint", () => {
    const lines = builder({ colour: true }).photoTable(PHOTOS.slice(1, 2).map((p) => ({ ...p, size: undefined }))).split("\n");
    expect(lines[0]).toBe(`${D}Photo${N}         ${D}Rating${N}  ${D}Flag${N}  ${D}Label${N}  ${D}Edited${N}`);
    expect(lines[1]).toBe(`IMG_4022.ARW  ${D}·${N}       ${D}·${N}     ${D}·${N}      ${D}·${N}`);
  });

  it("falls back to ASCII, and is empty for no photos", () => {
    expect(builder({ unicode: false }).photoTable(PHOTOS).split("\n")[1])
      .toBe("2026-11-wedding/ceremony/IMG_4021.ARW  ****    pick    red    edited  7008x4672");
    expect(builder().photoTable([])).toBe("");
  });
});

describe("extension tables", () => {
  it("lists installed extensions at 120 columns", () => {
    expect(builder({ width: 120 }).extensionTable(EXTENSIONS)).toBe([
      "Extension               Id                      Version  State  Trust       Update",
      "Local Contrast          local-contrast          1.0.0    on     verified    1.0.1 available",
      "Basic                   safelight.basic         3.2.5    on     official",
      "Pyramid Local Contrast  pyramid-local-contrast  1.1.0    off    unverified",
      "Old Thing               old-thing               0.1.0    off    banned",
    ].join("\n"));
  });

  it("gives up the id before the name at 60 columns", () => {
    expect(builder({ width: 60 }).extensionTable(EXTENSIONS)).toBe([
      "Extension        Version  State  Trust       Update",
      "Local Contrast   1.0.0    on     verified    1.0.1 available",
      "Basic            3.2.5    on     official",
      "Pyramid Local…   1.1.0    off    unverified",
      "Old Thing        0.1.0    off    banned",
    ].join("\n"));
  });

  it("marks trust in colour only where it needs a look", () => {
    const lines = builder({ colour: true }).extensionTable(EXTENSIONS).split("\n");
    expect(lines[1]).toBe(`Local Contrast          ${D}local-contrast${N}          1.0.0    on     verified    1.0.1 available`);
    expect(lines[3]).toBe(`${D}Pyramid Local Contrast${N}  ${D}pyramid-local-contrast${N}  1.1.0    ${D}off${N}    ${AMBER}unverified${FG}`);
    expect(lines[4]).toBe(`${D}Old Thing${N}               ${D}old-thing${N}               0.1.0    ${D}off${N}    ${RED}banned${FG}`);
  });

  it("lists search results as the command reference shows them", () => {
    expect(builder({ width: 120 }).searchTable(FOUND)).toBe([
      "local-contrast          Local Contrast 1.0.0          tone    verified",
      "contrast-and-texture    Contrast & Texture 1.0.2      detail  verified",
      "pyramid-local-contrast  Pyramid Local Contrast 1.1.0  detail  unverified",
    ].join("\n"));
    expect(builder({ width: 60 }).searchTable(FOUND)).toBe([
      "local-contrast          Local Contrast…   tone    verified",
      "contrast-and-texture    Contrast & Text…  detail  verified",
      "pyramid-local-contrast  Pyramid Local C…  detail  unverified",
    ].join("\n"));
    expect(builder({ colour: true }).searchTable(FOUND).split("\n")[2])
      .toBe(`pyramid-local-contrast  Pyramid Local Contrast 1.1.0  ${D}detail${N}  ${AMBER}unverified${FG}`);
  });
});

describe("history", () => {
  it("marks the current step", () => {
    expect(builder().historyList(STEPS)).toBe([
      "   0  Imported           2026-11-14 09:02",
      "   1  Exposure +0.70 EV  2026-11-14 09:05",
      "●  2  Highlights −40     2026-11-14 09:06",
      "  10  Local Contrast on  2026-11-14 21:30",
    ].join("\n"));
    expect(builder({ unicode: false }).historyList(STEPS).split("\n")[2]).toBe(">  2  Highlights -40     2026-11-14 09:06");
  });

  it("sets undone steps faint and the mark amber", () => {
    const lines = builder({ colour: true }).historyList(STEPS).split("\n");
    expect(lines[2]).toBe(`${AMBER}●${FG}  2  Highlights −40     ${D}2026-11-14 09:06${N}`);
    expect(lines[3]).toBe(`  ${D}10${N}  ${D}Local Contrast on${N}  ${D}2026-11-14 21:30${N}`);
  });
});

describe("lines", () => {
  const CHANGES = [
    { label: "Exposure", value: "+0.70 EV" }, { label: "Highlights", value: "−40" }, { label: "Shadows", value: "+25" },
    { label: "Temperature", value: "5600 K" }, { label: "Vibrance", value: "+15" },
  ];
  const HEADER = { name: "IMG_4021.ARW", camera: "Sony ILCE-7M4", megapixels: 33, edited: false, processVersion: 2 };

  it("writes the photo header", () => {
    expect(builder().photoHeader(HEADER)).toBe("IMG_4021.ARW · Sony ILCE-7M4 · 33 MP · not edited · process version 2");
    expect(builder({ width: 60 }).photoHeader(HEADER)).toBe("IMG_4021.ARW · Sony ILCE-7M4 · 33 MP · not edited\nprocess version 2");
    expect(builder().photoHeader({ name: "a.jpg", megapixels: 2.07, edited: true, processVersion: 1 })).toBe("a.jpg · 2.1 MP · edited · process version 1");
    expect(builder({ colour: true }).photoHeader({ name: "a.jpg", edited: true, processVersion: 1 }))
      .toBe(`${B}a.jpg${N}${D} · ${N}edited${D} · ${N}process version 1`);
  });

  it("writes a result line", () => {
    expect(builder().resultLine({ photo: "IMG_4021.ARW", changes: CHANGES.slice(0, 2), step: 2 }))
      .toBe("IMG_4021.ARW  Exposure +0.70 EV · Highlights −40   (step 2)");
    expect(builder().resultLine({ photo: "IMG_4021.ARW", changes: [{ label: "Local Contrast on", value: "" }], step: 3 }))
      .toBe("IMG_4021.ARW  Local Contrast on   (step 3)");
    expect(builder().resultLine({ photo: "IMG_4021.ARW", changes: [], note: "nothing to undo" })).toBe("IMG_4021.ARW  nothing to undo");
    expect(builder({ colour: true }).resultLine({ photo: "IMG_4021.ARW", changes: CHANGES.slice(0, 2), step: 2 }))
      .toBe(`IMG_4021.ARW  Exposure +0.70 EV${D} · ${N}Highlights −40   ${D}(step 2)${N}`);
  });

  it("continues a long result under its first change at 60 columns", () => {
    expect(builder({ width: 60 }).resultLine({ photo: "IMG_4021.ARW", changes: CHANGES, step: 2 })).toBe([
      "IMG_4021.ARW  Exposure +0.70 EV · Highlights −40",
      "              Shadows +25 · Temperature 5600 K",
      "              Vibrance +15   (step 2)",
    ].join("\n"));
  });

  it("writes a batch summary, with failures in red", () => {
    expect(builder().summary({ photos: 78, stepEach: true, failed: 0, skipped: 0 })).toBe("78 photos · 1 step each");
    expect(builder().summary({ photos: 1, stepEach: false, failed: 0, skipped: 0 })).toBe("1 photo");
    expect(builder().summary({ photos: 78, stepEach: true, failed: 2, skipped: 1 })).toBe("78 photos · 1 step each · 2 failed · 1 skipped");
    expect(builder({ colour: true }).summary({ photos: 78, stepEach: false, failed: 2, skipped: 0 })).toBe(`78 photos${D} · ${N}${RED}2 failed${FG}`);
  });

  it("writes an exported file", () => {
    const file = { path: "~/out/IMG_4021.jpg", width: 3000, height: 2000, colourSpace: "sRGB", bytes: 2202009 };
    expect(builder().exported(file)).toBe("~/out/IMG_4021.jpg  3000×2000 · sRGB · 2.1 MB");
    expect(builder({ unicode: false }).exported(file)).toBe("~/out/IMG_4021.jpg  3000x2000 - sRGB - 2.1 MB");
    expect(builder({ colour: true }).exported(file)).toBe(`~/out/IMG_4021.jpg  ${D}3000×2000 · sRGB · 2.1 MB${N}`);
  });

  it("lists what doctor checked", () => {
    const items = [
      { label: "Safelight", value: "3.2.5", status: "ok" as const },
      { label: "Extensions", value: "2 have updates", status: "warn" as const },
      { label: "Project", value: "open in Safelight", status: "fail" as const },
      { label: "Terminal", value: "120 columns", status: "info" as const },
    ];
    expect(builder().doctor(items)).toBe([
      "✓ Safelight   3.2.5",
      "! Extensions  2 have updates",
      "× Project     open in Safelight",
      "  Terminal    120 columns",
    ].join("\n"));
    expect(builder({ unicode: false }).doctor(items).split("\n")).toEqual([
      "ok Safelight   3.2.5",
      "!  Extensions  2 have updates",
      "x  Project     open in Safelight",
      "   Terminal    120 columns",
    ]);
    expect(builder({ colour: true }).doctor(items).split("\n").slice(1, 3)).toEqual([
      `${AMBER}!${FG} ${D}Extensions${N}  2 have updates`,
      `${RED}×${FG} ${D}Project${N}     open in Safelight`,
    ]);
  });
});

describe("preview caption", () => {
  const KITTY = { mode: "kitty" as const, trueColour: true, width: 1200, height: 800 };
  const BLOCKS = { mode: "blocks" as const, trueColour: false, width: 160, height: 100, ms: 412 };

  it("names the mode and the colour depth", () => {
    expect(builder().previewCaption(KITTY)).toBe("kitty · 24-bit");
    expect(builder({ colour: true }).previewCaption(KITTY)).toBe(`${D}kitty · 24-bit${N}`);
    expect(builder({ unicode: false }).previewCaption(KITTY)).toBe("kitty - 24-bit");
    expect(builder({ verbosity: "verbose" }).previewCaption({ ...KITTY, ms: 380 })).toBe("kitty · 24-bit · 1200×800 · 0.4 s");
  });

  it("warns when the terminal can't show true colour", () => {
    expect(builder().previewCaption(BLOCKS)).toBe("blocks · reduced colour, so tones here are approximate · 0.4 s");
    expect(builder({ colour: true }).previewCaption(BLOCKS))
      .toBe(`${D}blocks${N}${D} · ${N}${AMBER}reduced colour, so tones here are approximate${FG}${D} · ${N}${D}0.4 s${N}`);
  });

  it("says so when there is no way to show the photo", () => {
    expect(builder().previewCaption({ mode: "none", trueColour: false, width: 0, height: 0 })).toBe("No preview: this terminal can't show images.");
  });
});

describe("errors and warnings", () => {
  const TYPO = { message: "\"expsure\" isn't one of this photo's values. Did you mean exposure?", hint: "slu tools IMG_4021.ARW lists them." };
  const MISSING = { message: "IMG_4021.ARW renders without Retinex, which isn't installed. Its values are kept.", hint: "slu install retinex" };

  it("says what happened, then what to do", () => {
    expect(builder({ width: 120 }).problem("error", TYPO)).toBe([
      "slu: \"expsure\" isn't one of this photo's values. Did you mean exposure?",
      "     slu tools IMG_4021.ARW lists them.",
    ].join("\n"));
    expect(builder().problem("warning", { message: "exposure 7 is past its limit, so it was set to 5 EV." }))
      .toBe("slu: exposure 7 is past its limit, so it was set to 5 EV.");
  });

  it("wraps under the message at 60 columns", () => {
    expect(builder({ width: 60 }).problem("warning", MISSING)).toBe([
      "slu: IMG_4021.ARW renders without Retinex, which isn't",
      "     installed. Its values are kept.",
      "     slu install retinex",
    ].join("\n"));
  });

  it("is red for an error and amber for a warning, with the hint faint", () => {
    expect(builder({ colour: true }).problem("error", TYPO)).toBe([
      `${RED}slu:${FG} "expsure" isn't one of this photo's values. Did you mean exposure?`,
      `     ${D}slu tools IMG_4021.ARW lists them.${N}`,
    ].join("\n"));
    expect(builder({ colour: true, width: 60 }).problem("warning", MISSING)).toBe([
      `${AMBER}slu:${FG} IMG_4021.ARW renders without Retinex, which isn't`,
      "     installed. Its values are kept.",
      `     ${D}slu install retinex${N}`,
    ].join("\n"));
  });

  it("keeps a path whole and writes ASCII where it must", () => {
    const long = "D:\\Photos\\2026-11-wedding\\ceremony\\after-the-rain\\IMG_4021.ARW";
    expect(builder({ width: 40 }).problem("error", { message: `${long} isn't a photo.` }).split("\n")[0]).toBe(`slu: ${long}`);
    expect(builder({ unicode: false }).problem("error", { message: "exposure is limited to −5…5." })).toBe("slu: exposure is limited to -5...5.");
  });
});

describe("progress", () => {
  it("shows a count and a bar", () => {
    expect(builder().progressText({ label: "Exporting", done: 12, total: 78 })).toBe("Exporting  12/78  ━━━─────────────────");
    expect(builder().progressText({ label: "Exporting", done: 5, total: 78 })).toBe("Exporting   5/78  ━───────────────────");
    expect(builder({ unicode: false }).progressText({ label: "Exporting", done: 78, total: 78 })).toBe("Exporting  78/78  ====================");
    expect(builder({ colour: true }).progressText({ label: "Exporting", done: 12, total: 78 }))
      .toBe(`Exporting  ${D}12/78${N}  ${AMBER}━━━${FG}${D}─────────────────${N}`);
  });

  it("leaves out the bar when it's narrow and the count when there's no total", () => {
    expect(builder({ width: 50 }).progressText({ label: "Exporting", done: 12, total: 78 })).toBe("Exporting  12/78");
    expect(builder().progressText({ label: "Starting the engine", done: 0, total: 0 })).toBe("Starting the engine");
  });

  it("redraws in place on a terminal and clears when done", () => {
    const o = output({ tty: true });
    o.out.progress({ label: "Exporting", done: 9, total: 10 });
    o.out.progress({ label: "Done", done: 10, total: 10 });
    o.out.progress(null);
    o.out.progress(null);
    const first = "Exporting   9/10  ━━━━━━━━━━━━━━━━━━──";
    const second = "Done  10/10  ━━━━━━━━━━━━━━━━━━━━";
    expect(o.stderr()).toBe(`\r${first}\r${second}${" ".repeat(first.length - second.length)}\r${" ".repeat(second.length)}\r`);
    expect(o.stdout()).toBe("");
  });

  it("writes nothing when stderr isn't a terminal", () => {
    const o = output({ tty: false });
    o.out.progress({ label: "Exporting", done: 1, total: 10 });
    o.out.progress(null);
    expect(o.stderr()).toBe("");
  });

  it("clears the line before anything else is written", () => {
    const o = output({ tty: true });
    o.out.progress({ label: "Exporting", done: 1, total: 0 });
    o.out.print("a.jpg");
    expect(o.stderr()).toBe(`\rExporting\r${" ".repeat(9)}\r`);
    expect(o.stdout()).toBe("a.jpg\n");
  });
});

describe("writers", () => {
  it("prints results to stdout and problems to stderr", () => {
    const o = output();
    o.out.print("78 photos");
    o.out.warn({ message: "one warning" });
    o.out.error({ message: "one error", hint: "do this" });
    expect(o.stdout()).toBe("78 photos\n");
    expect(o.stderr()).toBe("slu: one warning\nslu: one error\n     do this\n");
  });

  it("keeps quiet except for errors", () => {
    const o = output({ verbosity: "quiet" });
    o.out.print("78 photos");
    o.out.warn({ message: "one warning" });
    o.out.info("Opened project");
    o.out.error({ message: "one error" });
    expect(o.stdout()).toBe("");
    expect(o.stderr()).toBe("slu: one error\n");
  });

  it("adds what slu did only when verbose", () => {
    const normal = output();
    normal.out.info("Opened project D:\\Photos");
    expect(normal.stderr()).toBe("");
    const verbose = output({ verbosity: "verbose", colour: true });
    verbose.out.info("Opened project D:\\Photos");
    expect(verbose.stderr()).toBe(`${D}Opened project D:\\Photos${N}\n`);
  });

  it("never styles JSON or raw bytes", () => {
    const o = output({ colour: true, verbosity: "quiet" });
    o.out.json({ slu: 1, exposure: 0.7, label: "Highlights −40" });
    o.out.writeRaw(new Uint8Array([65, 66]));
    expect(o.stdout()).toBe(`{\n  "slu": 1,\n  "exposure": 0.7,\n  "label": "Highlights −40"\n}\nAB`);
  });
});

describe("colour", () => {
  it("changes no text and moves no column, at 60 and 120 columns", () => {
    const render = (out: Output): string[] => [
      out.help({ version: "3.3.0", verbs: VERBS }),
      out.toolTable(TOOLS),
      out.photoTable(PHOTOS),
      out.extensionTable(EXTENSIONS),
      out.searchTable(FOUND),
      out.historyList(STEPS),
      out.photoHeader({ name: "IMG_4021.ARW", camera: "Sony ILCE-7M4", megapixels: 33, edited: false, processVersion: 2 }),
      out.resultLine({ photo: "IMG_4021.ARW", changes: [{ label: "Exposure", value: "+0.70 EV" }, { label: "Shadows", value: "+25" }], step: 2, note: "clamped" }),
      out.summary({ photos: 78, stepEach: true, failed: 2, skipped: 1 }),
      out.previewCaption({ mode: "blocks", trueColour: false, width: 160, height: 100, ms: 412 }),
      out.problem("error", { message: "\"expsure\" isn't one of this photo's values. Did you mean exposure?", hint: "slu tools IMG_4021.ARW lists them." }),
      out.progressText({ label: "Exporting", done: 12, total: 78 }),
    ];
    for (const width of [60, 120]) {
      const plain = render(builder({ width }));
      const coloured = render(builder({ width, colour: true }));
      expect(coloured.map(stripStyle)).toEqual(plain);
      for (const text of plain) expect(text).not.toContain("\x1b");
      expect(coloured.every((text) => text.includes("\x1b"))).toBe(true);
    }
  });
});
