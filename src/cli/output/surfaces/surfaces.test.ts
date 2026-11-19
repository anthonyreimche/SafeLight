// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every surface as a terminal shows it. Goldens are in the tagged theme where
// colour is the point (‹amber›text‹/›) and untagged where layout is.

import { describe, expect, it } from "vitest";
import {
  COLOR_NR, CONTRAST, CURVE_POINTS, EXPOSURE, HIGHLIGHTS, SHADOWS, SHARPENING, TEMPERATURE, TINT,
  richOptions, sink, taggedLook, untag,
} from "../fixtures";
import { createOutput, formatConfirm, formatHome, formatInstallCard, formatPhotoGrid } from "../index";
import type { HelpVerb, HomeStatus, Output, ToolRow } from "../index";
import { cells } from "../width";
import { progressFrame, workingFrame } from "./export";
import { LOGO_ART, LOGO_ART_WIDTH, logoParts, paintLogoRow } from "../logo/art";
import { LOGO_FROM, bulbRows, homeLayout } from "./home";

const page = (text: string): string => `\n${text}\n`;
const shape = (text: string): string => page(untag(text));

function output(width = 96, caps = {}): Output {
  return createOutput({ stdout: sink(true, width).stream, stderr: sink(true, width).stream }, richOptions(width, caps));
}

const HOME: HomeStatus = {
  version: "3.3.0",
  cwd: String.raw`D:\Photos\Iceland 2026`,
  project: { root: String.raw`D:\Photos\Iceland 2026`, name: "Iceland 2026", photos: 412, edited: 38, picks: 12 },
  guiHasProjectOpen: false,
  graphics: "d3d11",
  settingsShared: true,
  extensions: { installed: 14, updates: 2 },
};

describe("home", () => {
  const artAt = (lines: readonly string[]): number => lines.findIndex((line) => line.trim() === LOGO_ART[0].trim());

  it("draws the logo exactly as drawn, then the name, the project card and the status", () => {
    const lines = untag(formatHome(HOME, richOptions(96))).split("\n");
    const top = artAt(lines);
    expect(top).toBe(1);
    expect(lines.slice(top, top + LOGO_ART.length)).toEqual(LOGO_ART.map((row) => (row === "" ? "" : `   ${row}`.trimEnd())));
    const rest = lines.slice(top + LOGO_ART.length).join("\n");
    expect(rest).toMatchInlineSnapshot(`
      "
         Safelight Unplugged                              3.3.0

         ╭─ Iceland 2026 ─────────────────────────────────────╮
         │ 412 photos · 38 edited · 12 picks                  │
         │ D:\\Photos\\Iceland 2026                             │
         ╰────────────────────────────────────────────────────╯
         d3d11 · 14 extensions · 2 updates

        Try   photos                       list this project's photos
              tools <photo>                a photo's tools and values
              set <photo> exposure=+0.5    change a value
              help                         every command

      "
    `);
  });

  it("paints the globe's highlights and shadows in two reds, the lettering and base strong and the caption muted, and nothing else red", () => {
    const text = formatHome(HOME, richOptions(96));
    expect(text).toContain("‹bulb›---‹/›‹lampShade›..........‹/›");
    expect(text).toContain("‹strong›##+######‹/›");
    expect(text).toContain("‹strong›/___/\\_,_/_/‹/›");
    expect(text).toContain("‹muted›u‹/› ‹muted›n‹/›");
    expect(text).toContain("‹amber›2 updates‹/›");
    const outsideArt = text.split("\n").slice(1 + LOGO_ART.length).join("\n");
    expect(outsideArt).not.toContain("‹bulb›");
    expect(outsideArt).not.toContain("‹lampShade›");
  });

  it("reads - as the lit globe and . as its shade, a - inside the lettering as lettering, and words as the caption", () => {
    expect(logoParts(".-  -_) ab #+")).toEqual([
      "shade", "globe", "space", "space", "stroke", "stroke", "stroke", "space", "caption", "caption", "space", "stroke", "stroke",
    ]);
    expect(paintLogoRow(" ##+.. -.  u n", (part, run) => `[${part}:${run}]`))
      .toBe(" [stroke:##+][shade:..] [globe:-][shade:.]  [caption:u] [caption:n]");
  });

  it("is plain ASCII, and the same art, with no colour and on a legacy console", () => {
    const text = untag(formatHome(HOME, richOptions(96, { glyphs: "ascii" })));
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
    for (const row of LOGO_ART) if (row.trim() !== "") expect(text).toContain(row.trim());
    expect(text).toContain("+- Iceland 2026 ");
  });

  it("turns the card into the empty state outside a project", () => {
    const nowhere: HomeStatus = { ...HOME, cwd: String.raw`C:\Users\sam`, project: null, graphics: null, settingsShared: false, extensions: { installed: 0, updates: null } };
    const lines = untag(formatHome(nowhere, richOptions(96))).split("\n");
    expect(lines.slice(1 + LOGO_ART.length).join("\n")).toMatchInlineSnapshot(`
      "
         Safelight Unplugged                              3.3.0

         ╭─ No project here ──────────────────────────────────╮
         │ cd into a folder Safelight has opened, or open     │
         │ this one in Safelight once.                        │
         │ C:\\Users\\sam                                       │
         ╰────────────────────────────────────────────────────╯
         graphics not known yet · 0 extensions
         ! Safelight hasn't shared its settings yet. Open the app once, then come back.

        Try   doctor        check this setup
              extensions    list installed extensions
              help          every command

      "
    `);
  });

  it("puts a read only pill in the card's edge when Safelight has the project open", () => {
    const text = formatHome({ ...HOME, guiHasProjectOpen: true }, richOptions(96));
    expect(text).toContain("‹pill.amber› read only ‹/›");
    expect(untag(text)).toContain("│ Safelight has it open, so changes here will be     │");
  });

  it("draws the art once there is room for it over the card, and goes compact under that", () => {
    expect(LOGO_FROM).toBe(Math.max(LOGO_ART_WIDTH, 54) + 3 + 1);
    expect(artAt(untag(formatHome(HOME, richOptions(LOGO_FROM))).split("\n"))).toBe(1);
    expect(artAt(untag(formatHome(HOME, richOptions(LOGO_FROM - 1))).split("\n"))).toBe(-1);
    expect(shape(formatHome(HOME, richOptions(50)))).toMatchInlineSnapshot(`
      "

        ● Safelight Unplugged 3.3.0

        Iceland 2026
        412 photos · 38 edited · 12 picks
        D:\\Photos\\Iceland 2026
        d3d11 · 14 extensions · 2 updates

        Try   photos
              tools <photo>
              set <photo> exposure=+0.5
              help


      "
    `);
  });

  it("never runs past the terminal's width", () => {
    const long: HomeStatus = { ...HOME, cwd: String.raw`D:\Photos\${"deep\\".repeat(30)}`, project: { ...HOME.project!, name: "A project with a very long name indeed, longer than the card" } };
    for (const width of [40, 50, 60, 72, 74, 75, 96, 200]) {
      for (const line of formatHome(long, richOptions(width)).split("\n")) expect(cells(line)).toBeLessThan(Math.min(width, 96));
    }
  });

  it("warms the globe from ember to lit, its shade a step behind, leaves the strokes alone, and the last frame is the static render", () => {
    const look = taggedLook(96);
    const lit = bulbRows(look, 1);
    expect(bulbRows(look)).toEqual(lit);
    expect(bulbRows(look, 0)).toEqual(lit.map((row) => row.replaceAll("‹lampShade›", "‹ember›").replaceAll("‹bulb›", "‹ember›")));
    expect(bulbRows(look, 0.5)).toEqual(lit.map((row) => row.replaceAll("‹lampShade›", "‹ember›").replaceAll("‹bulb›", "‹lampShade›")));
    expect(lit.join("\n")).toContain("‹strong›");
    expect(lit.map(cells)).toEqual(Array(LOGO_ART.length).fill(LOGO_ART_WIDTH));
    expect(homeLayout(HOME, look, 1).lines).toEqual(homeLayout(HOME, look).lines);
    expect(homeLayout(HOME, look).bulb).toEqual({ top: 1, left: 3, rows: LOGO_ART.length });
    expect(homeLayout(HOME, taggedLook(50)).bulb).toBeNull();
  });
});

const TOOLS: ToolRow[] = [
  {
    tool: "White Balance", state: "in use", values: [
      { info: TEMPERATURE, value: 5600, changed: true, note: "(as shot 5150)" },
      { info: TINT, value: 4, changed: true },
    ],
  },
  {
    tool: "Basic", state: "in use", values: [
      { info: EXPOSURE, value: 0.7, changed: true },
      { info: CONTRAST, value: 0, changed: false },
      { info: HIGHLIGHTS, value: -40, changed: true },
      { info: SHADOWS, value: 45, changed: true },
    ],
  },
  {
    tool: "Detail", state: "in use", values: [
      { info: SHARPENING, value: 25, changed: false },
      { info: COLOR_NR, value: 25, changed: false },
    ],
  },
  { tool: "Tone Curve", state: "in use", values: [{ info: CURVE_POINTS, value: "3 points", changed: true, note: "(edit in Safelight)" }] },
];

describe("tools", () => {
  it("draws each changed value as key, value, slider, mark and range, and folds the defaults", () => {
    const out = output(96);
    const header = out.photoHeader({
      name: "DSC_0412.NEF", camera: "Nikon Z 6II", megapixels: 24, edited: true, processVersion: 2,
      step: { at: 4, of: 6 }, rating: 4, flag: "pick", label: "blue",
    });
    expect(shape(`${header}\n${out.toolTable(TOOLS)}`)).toMatchInlineSnapshot(`
      "
      DSC_0412.NEF
      Nikon Z 6II · 24 MP · step 4 of 6 · process version 2
      ★★★★· · pick · ● blue

      White Balance
        temperature    5600 K    ──────●──────────────  ✱   2000…50000  as shot 5150
        tint             +4      ──────────●──────────  ✱   −150…150

      Basic
        exposure      +0.70 EV   ──────────┼●─────────  ✱   −5…5
        highlights      −40      ──────●╺━━┼──────────  ✱   −100…100
        shadows         +45      ──────────┼━━━╸●─────  ✱   −100…100
        …1 more at its default

      Detail   2 values at their defaults

      Tone Curve
        toneCurve     3 points                          ✱  edit in Safelight

      --all lists values at their defaults too
      "
    `);
  });

  it("unfolds with all: defaults recede to a muted number and a bare tick", () => {
    expect(page(output(96).toolTable(TOOLS, { all: true }))).toMatchInlineSnapshot(`
      "
      ‹strong›White Balance‹/›
        temperature   ‹strong› 5600‹/›‹muted› K ‹/›   ‹faint›──────‹/›‹amber›●‹/›‹faint›──────────────‹/›  ‹amber›✱‹/›   ‹muted›2000…50000‹/›  ‹muted›as shot 5150‹/›
        tint          ‹strong›   +4‹/›‹muted›   ‹/›   ‹faint›──────────‹/›‹amber›●‹/›‹faint›──────────‹/›  ‹amber›✱‹/›   ‹muted›−150…150‹/›

      ‹strong›Basic‹/›
        exposure      ‹strong›+0.70‹/›‹muted› EV‹/›   ‹faint›──────────‹/›‹muted›┼‹/›‹amber›●‹/›‹faint›─────────‹/›  ‹amber›✱‹/›   ‹muted›−5…5‹/›
        contrast      ‹muted›    0‹/›‹muted›   ‹/›   ‹faint›──────────‹/›‹muted›┼‹/›‹faint›──────────‹/›      ‹muted›−100…100‹/›
        highlights    ‹strong›  −40‹/›‹muted›   ‹/›   ‹faint›──────‹/›‹amber›●╺━━‹/›‹muted›┼‹/›‹faint›──────────‹/›  ‹amber›✱‹/›   ‹muted›−100…100‹/›
        shadows       ‹strong›  +45‹/›‹muted›   ‹/›   ‹faint›──────────‹/›‹muted›┼‹/›‹amber›━━━╸●‹/›‹faint›─────‹/›  ‹amber›✱‹/›   ‹muted›−100…100‹/›

      ‹strong›Detail‹/›
        sharpening    ‹muted›   25‹/›‹muted›   ‹/›   ‹faint›───‹/›‹muted›┼‹/›‹faint›─────────────────‹/›      ‹muted›0…150‹/›
        colorNR       ‹muted›   25‹/›‹muted›   ‹/›   ‹faint›─────‹/›‹muted›┼‹/›‹faint›───────────────‹/›      ‹muted›0…100‹/›

      ‹strong›Tone Curve‹/›
        toneCurve     ‹strong›3 points‹/›                          ‹amber›✱‹/›  ‹muted›edit in Safelight‹/›
      "
    `);
  });

  it("narrows: shorter bars at 80, no ranges at 60, key and value only at 44", () => {
    expect(shape(output(80).toolTable(TOOLS))).toMatchInlineSnapshot(`
      "
      White Balance
        temperature    5600 K    ─────●──────────  ✱   2000…50000  as shot 5150
        tint             +4      ────────●───────  ✱   −150…150

      Basic
        exposure      +0.70 EV   ────────┼●──────  ✱   −5…5
        highlights      −40      ────●━━━┼───────  ✱   −100…100
        shadows         +45      ────────┼━╸●────  ✱   −100…100
        …1 more at its default

      Detail   2 values at their defaults

      Tone Curve
        toneCurve     3 points                     ✱  edit in Safelight

      --all lists values at their defaults too
      "
    `);
    expect(shape(output(60).toolTable(TOOLS))).toMatchInlineSnapshot(`
      "
      White Balance
        temperature    5600 K    ───●──────  ✱
        tint             +4      ─────●────  ✱

      Basic
        exposure      +0.70 EV   ─────●────  ✱
        highlights      −40      ───●╺┼────  ✱
        shadows         +45      ─────┼╸●──  ✱
        …1 more at its default

      Detail   2 values at their defaults

      Tone Curve
        toneCurve     3 points               ✱  edit in Safeli…

      --all lists values at their defaults too
      "
    `);
    expect(shape(output(44).toolTable(TOOLS))).toMatchInlineSnapshot(`
      "
      White Balance
        temperature    5600 K   ✱
        tint             +4     ✱

      Basic
        exposure      +0.70 EV  ✱
        highlights      −40     ✱
        shadows         +45     ✱
        …1 more at its default

      Detail   2 values at their defaults

      Tone Curve
        toneCurve     3 points  ✱  edit in Saf…

      --all lists values at their defaults too
      "
    `);
  });

  it("sets the photo to the right of the values at 96 columns, and not below that", () => {
    const picture = ["▀".repeat(28), "▀".repeat(28), "▀".repeat(28)];
    expect(shape(output(96).toolTable(TOOLS.slice(0, 2), { picture }))).toMatchInlineSnapshot(`
      "
      White Balance                                         ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
        temperature    5600 K    ──────●──────────────  ✱   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
        tint             +4      ──────────●──────────  ✱   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀

      Basic
        exposure      +0.70 EV   ──────────┼●─────────  ✱
        highlights      −40      ──────●╺━━┼──────────  ✱
        shadows         +45      ──────────┼━━━╸●─────  ✱
        …1 more at its default

      --all lists values at their defaults too
      "
    `);
    expect(output(80).toolTable(TOOLS, { picture })).toBe(output(80).toolTable(TOOLS));
  });

  it("lists bare tools with their state, and says when a tool is off or its ranges aren't known", () => {
    const out = output(96);
    expect(page(out.toolTable([{ tool: "Basic", values: [] }, { tool: "Retinex", state: "off", values: [] }]))).toMatchInlineSnapshot(`
      "
      Basic
      Retinex   ‹muted›off‹/›
      "
    `);
    const unknown = { ...EXPOSURE, key: "strength", rangeUnknown: true, default: undefined };
    expect(page(out.toolTable([{ tool: "Retinex", state: "idle", values: [{ info: unknown, value: 0.4, changed: true }] }]))).toMatchInlineSnapshot(`
      "
      ‹strong›Retinex‹/›  ‹muted›(idle, ranges unknown)‹/›
        strength   ‹strong›+0.40‹/›‹muted› EV‹/›  ‹amber›✱‹/›
      "
    `);
  });

  it("shows a switch as on or off and a choice among its choices", () => {
    const on = { ...EXPOSURE, key: "on", kind: "switch" as const };
    const mode = { ...EXPOSURE, key: "mode", kind: "choice" as const, choices: [{ value: "laplacian", label: "Laplacian" }, { value: "bilateral", label: "Bilateral" }] };
    expect(page(output(96).toolTable([{
      tool: "Local Contrast", values: [{ info: on, value: true, changed: true }, { info: mode, value: "bilateral", changed: true }],
    }]))).toMatchInlineSnapshot(`
      "
      ‹strong›Local Contrast‹/›
        on     ‹amber›on ●‹/›       ‹amber›✱‹/›
        mode   ‹strong›Bilateral‹/›  ‹amber›✱‹/›   ‹muted›laplacian‹/›‹faint› · ‹/›[bilateral]
      "
    `);
  });

  it("keeps the header to a name and its facts when that is all it is given", () => {
    expect(page(output(96).photoHeader({ name: "DSC_0412.NEF", edited: false, processVersion: 2 }))).toMatchInlineSnapshot(`
      "
      ‹strong›DSC_0412.NEF‹/›
      ‹muted›not edited‹/›‹faint› · ‹/›‹muted›process version 2‹/›

      "
    `);
  });
});

const CHANGES = [
  { label: "Exposure", value: "+0.70 EV", info: EXPOSURE, before: 0.5, after: 0.7 },
  { label: "Highlights", value: "−40", info: HIGHLIGHTS, before: 0, after: -40 },
  { label: "Shadows", value: "+45", info: SHADOWS, before: 20, after: 45 },
  { label: "Temperature", value: "5600 K", info: TEMPERATURE, before: 5150, after: 5600 },
];

describe("set results", () => {
  const printed = (width: number, write: (out: Output) => void): string => {
    const stdout = sink(true, width);
    write(createOutput({ stdout: stdout.stream, stderr: sink(true, width).stream }, richOptions(width)));
    return stdout.text();
  };

  it("prints one photo as a block: name and step, then before → after with bars", () => {
    expect(shape(printed(96, (out) => out.result({ photo: "DSC_0412.NEF", step: 5, changes: CHANGES })))).toMatchInlineSnapshot(`
      "
        DSC_0412.NEF · step 5
          exposure      +0.50 → +0.70 EV   ──────────○●─────────
          highlights        0 → −40        ──────●╺━━○──────────
          shadows         +20 → +45        ──────────┼━○━╸●─────
          temperature    5150 → 5600 K     ─────○●──────────────

      "
    `);
  });

  it("colours the old ground dim and the move bright", () => {
    expect(page(printed(96, (out) => out.result({ photo: "DSC_0412.NEF", step: 5, changes: CHANGES.slice(2, 3) })))).toMatchInlineSnapshot(`
      "
        ‹strong›DSC_0412.NEF‹/›‹faint› · ‹/›‹muted›step 5‹/›
          shadows   ‹muted›+20‹/› ‹faint›→‹/› ‹strong›+45‹/›   ‹faint›──────────‹/›‹muted›┼‹/›‹amberDim›━○‹/›‹amber›━╸●‹/›‹faint›─────‹/›

      "
    `);
  });

  it("drops to the diff, with no bars, under 50 columns", () => {
    expect(shape(printed(44, (out) => out.result({ photo: "DSC_0412.NEF", step: 5, changes: CHANGES })))).toMatchInlineSnapshot(`
      "
        DSC_0412.NEF · step 5
          exposure      +0.50 → +0.70 EV
          highlights        0 → −40
          shadows         +20 → +45
          temperature    5150 → 5600 K

      "
    `);
  });

  it("prints a batch as a line a photo and a summary", () => {
    const out = output(96);
    expect(page([
      out.resultLine({ photo: "DSC_0398.NEF", step: 3, changes: [{ label: "Temperature", value: "5400 K" }, { label: "Exposure", value: "+0.30 EV" }] }),
      out.resultLine({ photo: "DSC_0401.NEF", changes: [], note: "already matches" }),
      out.summary({ photos: 78, stepEach: true, failed: 0, skipped: 0 }),
      out.summary({ photos: 78, stepEach: true, failed: 2, skipped: 1 }),
      out.summary({ photos: 12, stepEach: false, failed: 0, skipped: 0 }),
    ].join("\n"))).toMatchInlineSnapshot(`
      "
      DSC_0398.NEF   Temperature 5400 K‹faint› · ‹/›Exposure +0.30 EV   ‹muted›step 3‹/›
      DSC_0401.NEF  ‹muted›already matches‹/›
      ‹ok›✓‹/› 78 photos‹faint› · ‹/›1 step each
      ‹amber›!‹/› 78 photos‹faint› · ‹/›1 step each‹faint› · ‹/›‹lamp›2 failed‹/›‹faint› · ‹/›‹muted›1 skipped‹/›
      ‹muted›12 photos‹/›
      "
    `);
  });
});

describe("photos", () => {
  const rows = [
    { name: "DSC_0398.NEF", rating: 5, flag: "pick" as const, label: "red", edited: true, size: "24 MP" },
    { name: "DSC_0401.NEF", rating: 4, flag: "pick" as const, label: "blue", edited: true, size: "24 MP" },
    { name: "DSC_0413.NEF", rating: 2, flag: "none" as const, label: "none", edited: false, size: "24 MP" },
    { name: "DSC_0419.NEF", rating: 0, flag: "reject" as const, label: "", edited: false, size: "24 MP" },
  ];

  it("lists with five cells of stars, a label dot and the edited mark, and no header", () => {
    expect(shape(output(96).photoTable(rows))).toMatchInlineSnapshot(`
      "
      DSC_0398.NEF   ★★★★★   pick     ● red    ✱   24 MP
      DSC_0401.NEF   ★★★★·   pick     ● blue   ✱   24 MP
      DSC_0413.NEF   ★★···   ·        ·        ·   24 MP
      DSC_0419.NEF   ·····   reject   ·        ·   24 MP
      "
    `);
  });

  it("gives stars, labels and the mark their colours, and mutes a rejected row", () => {
    const lines = output(96).photoTable(rows).split("\n");
    expect(lines[1]).toBe("DSC_0401.NEF   ‹star›★★★★‹/›‹faint›·‹/›   pick     ‹label.blue›●‹/› ‹muted›blue‹/›   ‹amber›✱‹/›   ‹muted›24 MP‹/›");
    expect(lines[3]).toBe("‹muted›DSC_0419.NEF‹/›   ‹muted›·····‹/›   ‹muted›reject‹/›   ‹faint›·‹/›        ‹faint›·‹/›   ‹muted›24 MP‹/›");
  });

  it("gives way at the name when the line is too long", () => {
    const long = [{ ...rows[0], name: `2026/iceland/day-3/glacier-lagoon/selects/${"x".repeat(60)}/DSC_0398.NEF` }];
    for (const width of [44, 80]) expect(cells(output(width).photoTable(long))).toBeLessThanOrEqual(width - 3);
    expect(untag(output(44).photoTable(long))).toMatch(/^….*DSC_0398\.NEF /);
  });

  it("lays out the contact sheet in 14-column cells, as many a row as fit", () => {
    const picture = ["▀".repeat(14), "▀".repeat(14)];
    const sheet = formatPhotoGrid([...rows.map((row) => ({ ...row, picture })), { ...rows[0], name: "sub/DSC_0500.NEF" }], richOptions(72));
    expect(shape(sheet ?? "")).toMatchInlineSnapshot(`
      "
      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀
      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀▀▀▀
      DSC_0398         DSC_0401         DSC_0413         DSC_0419
      ★★★★★ ● ✱        ★★★★· ● ✱        ★★···            reject

      DSC_0500
      ★★★★★ ● ✱
      "
    `);
    expect(formatPhotoGrid(rows, { ...richOptions(72), caps: undefined })).toBeNull();
  });
});

describe("history", () => {
  it("heads the timeline with where the photo is and ends with the two moves", () => {
    const now = Date.now();
    const text = output(96).historyList([
      { index: 1, label: "Opened", timestamp: now - 3000, current: false },
      { index: 2, label: "Exposure", timestamp: now - 2000, current: true },
      { index: 3, label: "Detail", timestamp: now - 1000, current: false },
      { index: 4, label: "Local Contrast", timestamp: now - 500, current: false },
    ], "DSC_0412.NEF").split("\n");
    expect(text[0]).toBe("‹strong›DSC_0412.NEF‹/›‹faint› · ‹/›‹muted›on step 2 of 4‹/›");
    expect(text[2]).toBe("‹muted›Today‹/›");
    expect(text[text.length - 2]).toBe("");
    expect(text[text.length - 1]).toBe("‹strong›undo‹/› DSC_0412.NEF‹faint› · ‹/›‹strong›redo‹/› DSC_0412.NEF 2");
  });

  it("offers only the moves there are, and none without a photo's name", () => {
    const out = output(96);
    const one = [{ index: 1, label: "Opened", timestamp: 0, current: true }];
    expect(untag(out.historyList(one, "a.NEF"))).toBe("a.NEF · on step 1 of 1\n\n◉  1  Opened   you are here");
    expect(untag(out.historyList(one))).toBe("on step 1 of 1\n\n◉  1  Opened   you are here");
    expect(untag(out.historyList([]))).toBe("No steps yet.");
  });
});

describe("export in progress", () => {
  const look = taggedLook(96);
  const items = [
    { name: "DSC_0398.NEF", state: "done" as const, ms: 900 },
    { name: "DSC_0401.NEF", state: "done" as const, ms: 800 },
    { name: "DSC_0407.NEF", state: "failed" as const, error: "can't be decoded" },
    { name: "DSC_0412.NEF", state: "working" as const },
    { name: "DSC_0413.NEF", state: "waiting" as const },
  ];

  it("is three lines: the lamp by the photo being rendered, a blank, the bar with its count and time left", () => {
    expect(page(progressFrame({ label: "Rendering", done: 37, total: 78, items, startedAt: 0 }, 5000, 0, look).join("\n"))).toMatchInlineSnapshot(`
      "
      ‹lamp›●‹/› DSC_0412.NEF   ‹muted›Rendering…‹/›

      ‹lamp›━━━━━━━━━━━━━━━━━━━━━━━‹/›‹faint›─────────────────────────‹/›   37 of 78‹faint› · ‹/›‹muted›about 35 s left‹/›
      "
    `);
  });

  it("says what it is waiting for before the first photo", () => {
    const waiting = items.map((item) => ({ ...item, state: "waiting" as const }));
    expect(shape(progressFrame({ label: "Starting the engine", done: 0, total: 78, items: waiting }, 2100, 0, look).join("\n"))).toMatchInlineSnapshot(`
      "
      ● Starting the engine…  2.1 s

      ────────────────────────────────────────────────   0 of 78
      "
    `);
  });

  it("is one line for a download or a plain count, and for a wait", () => {
    expect(shape([
      ...progressFrame({ label: "Downloading Local Contrast 1.0.0", done: 0, total: 0, bytes: { done: 421_888, total: 1_153_434 } }, 5000, 0, look),
      ...progressFrame({ label: "Downloading Local Contrast 1.0.0", done: 0, total: 0, bytes: { done: 421_888, total: null } }, 500, 0, look),
      ...progressFrame({ label: "Exporting", done: 3, total: 10 }, 500, 0, look),
      ...progressFrame({ label: "Checking for updates", done: 0, total: 0 }, 500, 0, look),
      ...workingFrame("Starting the engine", 2100, look),
    ].join("\n"))).toMatchInlineSnapshot(`
      "
      ● Downloading Local Contrast 1.0.0…  5.0 s   ━━━━━━━━━───────────────   412 KB of 1.1 MB
      ● Downloading Local Contrast 1.0.0…   412 KB
      ● Exporting…   ━━━━━━━─────────────────   3 of 10
      ● Checking for updates…
      ● Starting the engine…  2.1 s
      "
    `);
  });

  it("fits the width it is given", () => {
    for (const width of [40, 50, 72, 96]) {
      const narrow = taggedLook(width);
      const long = [{ name: `${"very-long-folder/".repeat(8)}DSC_0412.NEF`, state: "working" as const }];
      for (const line of progressFrame({ label: "Rendering", done: 3, total: 78, items: long, startedAt: 0 }, 9000, 0, narrow)) {
        expect(cells(line)).toBeLessThanOrEqual(narrow.width);
      }
      for (const line of progressFrame({ label: "Downloading an extension with a long name", done: 0, total: 0, bytes: { done: 1, total: 9 } }, 9000, 0, narrow)) {
        expect(cells(line)).toBeLessThanOrEqual(narrow.width);
      }
    }
  });

  it("prints a finished photo as a row with its facts", () => {
    const out = output(96);
    expect(out.exported({ path: String.raw`..\wedding-web\DSC_0398.jpg`, width: 2048, height: 1365, colourSpace: "sRGB", bytes: 1_468_006 }))
      .toBe(String.raw`‹ok›✓‹/› ..\wedding-web\DSC_0398.jpg   ‹muted›2048×1365‹/›   ‹muted›sRGB‹/›   ‹muted›1.4 MB‹/›`);
  });

  it("links an exported file's path where the terminal follows links", () => {
    const out = createOutput({ stdout: sink(true).stream, stderr: sink(true).stream }, richOptions(96, { tier: "mono", links: true }));
    expect(out.exported({ path: String.raw`D:\out\a b.jpg`, width: 1, height: 1, colourSpace: "sRGB", bytes: 1 }))
      .toContain("\x1b]8;;file:///D:/out/a%20b.jpg\x1b\\D:\\out\\a b.jpg\x1b]8;;\x1b\\");
  });
});

describe("extensions", () => {
  const hits = [
    { installName: "local-contrast", name: "Local Contrast", version: "1.0.0", category: "tone", trust: "verified" as const, description: "Lifts fine detail without halos, in two modes." },
    { installName: "pyramid-local-contrast", name: "Pyramid Local Contrast", version: "1.1.0", category: "detail", trust: "unverified" as const, description: "Multi-scale local contrast." },
  ];

  it("shows search hits as cards", () => {
    expect(shape(output(96).searchTable(hits))).toMatchInlineSnapshot(`
      "
      2 extensions found

      ╭─ Local Contrast  1.0.0 ───────────────────────────── ✓ verified ─╮
      │ Lifts fine detail without halos, in two modes.              tone │
      │ install local-contrast                                           │
      ╰──────────────────────────────────────────────────────────────────╯
      ╭─ Pyramid Local Contrast  1.1.0 ─────────────────── ! unverified ─╮
      │ Multi-scale local contrast.                               detail │
      │ install pyramid-local-contrast                                   │
      ╰──────────────────────────────────────────────────────────────────╯
      "
    `);
  });

  it("goes back to a table past eight hits", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...hits[0], installName: `tool-${i}` }));
    const text = untag(output(96).searchTable(many));
    expect(text.split("\n")).toHaveLength(9);
    expect(text).not.toContain("╭");
  });

  it("lists what is installed with updates first, and sets a switched-off row back", () => {
    expect(shape(output(96).extensionTable([
      { name: "Basic", id: "safelight.basic", version: "1.4.0", enabled: true, trust: "official" },
      { name: "Local Contrast", id: "local-contrast", version: "1.0.0", enabled: true, trust: "verified", update: "1.0.2" },
      { name: "Acme Tool", id: "acme", version: "0.3.1", enabled: false, trust: "unverified" },
      { name: "Retinex", id: "retinex", version: "1.0.0", enabled: null, trust: "official", update: "1.1.0" },
    ]))).toMatchInlineSnapshot(`
      "
      4 extensions · 2 updates

      Local Contrast   1.0.0 → 1.0.2   on    ✓ verified     update local-contrast
      Retinex          1.0.0 → 1.1.0   ?     ● official     update retinex
      Basic            1.4.0           on    ● official
      Acme Tool        0.3.1           off   ! unverified

      Open Safelight once so safelight can see which extensions are on.
      "
    `);
  });

  it("makes the newer version amber", () => {
    const text = output(96).extensionTable([{ name: "Retinex", id: "retinex", version: "1.0.0", enabled: true, trust: "official", update: "1.1.0" }]);
    expect(text).toContain("1.0.0 ‹faint›→‹/› ‹amber›1.1.0‹/›");
    expect(text).toContain("‹amber›1 update‹/›");
  });

  it("asks the one question under the one amber panel", () => {
    const risk = { name: "Pyramid Local Contrast", trust: "unverified" as const, permissions: ["reach https://api.example.com", "keep secrets"] };
    const text = formatInstallCard(risk, richOptions(96)) + (formatConfirm("Install it?", false, richOptions(96)) ?? "");
    expect(text.startsWith("  ‹amber›╭‹/›")).toBe(true);
    expect(shape(text)).toMatchInlineSnapshot(`
      "
        ╭─ Pyramid Local Contrast ────────────────────────── ! unverified ─╮
        │ It may                                                           │
        │   reach https://api.example.com                                  │
        │   keep secrets                                                   │
        │                                                                  │
        │ Nobody at Safelight has checked this extension. It runs with     │
        │ full access to your photos and files.                            │
        ╰──────────────────────────────────────────────────────────────────╯
        Install it?   ‹ No ›   Yes          ← → choose · enter · y / n
      "
    `);
    expect(formatConfirm("Install it?", true, richOptions(96))).toContain("‹muted›  No  ‹/› ‹strong›‹ Yes ›‹/›");
  });

  it("has nothing to add off a terminal, where the question stays [y/N]", () => {
    const piped = { ...richOptions(96), caps: { ...richOptions(96).caps!, rich: { stdout: false, stderr: false } } };
    expect(formatInstallCard({ name: "X", trust: "unverified", permissions: [] }, piped)).toBe("");
    expect(formatConfirm("Install it?", false, piped)).toBeNull();
  });
});

describe("doctor", () => {
  it("is a checklist with what to do under a row, and a verdict", () => {
    expect(page(output(96).doctor([
      { label: "App", value: String.raw`Safelight 3.3.0 · D:\Repositories\SafeLight`, status: "ok" },
      { label: "Terminal", value: "Windows Terminal · 24-bit colour · pictures as blocks", status: "warn", hint: "Windows Terminal 1.22 or newer shows real pictures." },
      { label: "Extensions", value: "Retinex failed to load", status: "fail", hint: "update retinex" },
      { label: "Network", value: "not checked", status: "info" },
    ]))).toMatchInlineSnapshot(`
      "
      ‹ok›✓‹/› ‹muted›App       ‹/›   Safelight 3.3.0 · D:\\Repositories\\SafeLight
      ‹amber›!‹/› ‹muted›Terminal  ‹/›   Windows Terminal · 24-bit colour · pictures as blocks
                     ‹muted›Windows Terminal 1.22 or newer shows real pictures.‹/›
      ‹lamp›✕‹/› ‹muted›Extensions‹/›   Retinex failed to load
                     ‹muted›update retinex‹/›
      ‹faint›·‹/› ‹muted›Network   ‹/›   not checked

      ‹lamp›1 problem‹/›‹faint› · ‹/›‹amber›1 note‹/›
      "
    `);
  });

  it("says so when everything is in order", () => {
    expect(output(96).doctor([{ label: "App", value: "Safelight 3.3.0", status: "ok" }]).split("\n").pop()).toBe("‹ok›Everything is in order.‹/›");
  });
});

describe("help", () => {
  const verbs: HelpVerb[] = (
    [
      ["Look", "photos tools get history preview"], ["Edit", "set add remove reset undo redo"], ["Share", "copy paste presets apply"],
      ["Organize", "rate flag label"], ["Output", "export"], ["Extensions", "search install uninstall update extensions enable disable"],
      ["More", "doctor version help"],
    ] as const
  ).flatMap(([group, list]) => list.split(" ").map((verb) => ({ verb, group, summary: "" })));

  it("fits one screen, with verbs strong and examples in the prompt's colours", () => {
    const text = output(96).help({ version: "3.3.0", verbs });
    expect(text.split("\n").length).toBeLessThanOrEqual(22);
    expect(shape(text)).toMatchInlineSnapshot(`
      "
      Safelight Unplugged 3.3.0 · edit photos with commands and values

      safelight <verb> [photos…] [key=value…] [options]

      Look         photos  tools  get  history  preview
      Edit         set  add  remove  reset  undo  redo
      Share        copy  paste  presets  apply
      Organize     rate  flag  label
      Output       export
      Extensions   search  install  uninstall  update  extensions  enable  disable
      More         doctor  version  help <verb>

      Photos       files · *.ARW · folders (-r) · --all · - for a list on stdin
                   --rating 3+  --flag pick  --label red  --edited
      Values       key=5  key+=0.3  key-=10  key=default  temperature=5600K
      Options      --json  -q  -v  --project <folder>  --preview  --yes  --strict  --wait

      help <verb> shows one command · docs: github.com/anthonyreimche/SafeLight
      "
    `);
    expect(text).toContain("‹muted›Look‹/›         ‹strong›photos‹/›  ‹strong›tools‹/›");
    expect(text).toContain("‹amber›key‹/›‹faint›+=‹/›‹strong›0.3‹/›");
    expect(text).toContain("‹strong›help‹/› ‹italic›<verb>‹/›");
  });

  it("wraps under its own first word when narrow", () => {
    for (const line of output(44).help({ version: "3.3.0", verbs }).split("\n")) expect(cells(line)).toBeLessThanOrEqual(41);
  });

  it("shows one verb: usage, what it does, options, examples in colour", () => {
    expect(page(output(96).verbHelp({
      verb: "tools", usage: "tools [photo] [--all]", summary: "Lists the tools in pipeline order.",
      options: [{ flag: "--all", summary: "Also list idle tools." }, { flag: "--project <folder>", summary: "Use this project." }],
      examples: ["safelight tools IMG_4021.ARW --all", "safelight set IMG_4021.ARW exposure=+0.5"],
    }))).toMatchInlineSnapshot(`
      "
      ‹muted›safelight‹/› ‹strong›tools‹/› ‹italic›[photo]‹/› ‹italic›[--all]‹/›

      Lists the tools in pipeline order.

      --all                ‹muted›Also list idle tools.‹/›
      --project <folder>   ‹muted›Use this project.‹/›

      ‹muted›safelight‹/› ‹strong›tools‹/› IMG_4021.ARW ‹muted›--all‹/›
      ‹muted›safelight‹/› ‹strong›set‹/› IMG_4021.ARW ‹amber›exposure‹/›‹faint›=‹/›‹strong›+0.5‹/›
      "
    `);
  });
});

describe("the look in ASCII", () => {
  it("still has a shape", () => {
    const stdout = sink(true, 96);
    const out = createOutput({ stdout: stdout.stream, stderr: sink(true, 96).stream }, richOptions(96, { glyphs: "ascii" }));
    out.result({ photo: "DSC_0412.NEF", step: 5, changes: CHANGES.slice(0, 2) });
    out.print(out.toolTable(TOOLS.slice(1, 2)));
    expect(untag(stdout.text())).toMatch(/^[\x20-\x7e\n]+$/);
    expect(shape(stdout.text())).toMatchInlineSnapshot(`
      "
        DSC_0412.NEF - step 5
          exposure     +0.50 -> +0.70 EV   [----------.o---------]
          highlights       0 -> -40        [------o===.----------]
        Basic
          exposure     +0.70 EV   [----------|o---------]  *   -5...5
          highlights     -40      [------o===|----------]  *   -100...100
          shadows        +45      [----------|====o-----]  *   -100...100
          ...1 more at its default

        --all lists values at their defaults too

      "
    `);
  });
});
