// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The library commands' output: `ls` and its tree, import, keywords, forget,
// the contact sheet's pictures, export's closing lines and doctor settling.
// Tagged goldens for the terminal, exact bytes for everything else.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { treeRows } from "./components/tree";
import { richOptions, sink, taggedLook, untag } from "./fixtures";
import { createOutput, formatForgetCard, formatPhotoGrid, formatPrompt, gridPictureFromJpeg, gridPictureFromRgba } from "./index";
import type {
  DoctorCheck, FolderNode, GridCell, ImportSummary, Listing, ListingSummary, Output, OutputOptions, PhotoRow,
} from "./index";
import { cells, stripMarkup } from "./width";

const page = (text: string): string => `\n${text}\n`;
const shape = (text: string): string => page(untag(text));

function rich(width = 96, caps = {}): Output {
  return createOutput({ stdout: sink(true, width).stream, stderr: sink(true, width).stream }, richOptions(width, caps));
}

const PLAIN: OutputOptions = { colour: { stdout: false, stderr: false }, unicode: true, width: 80, verbosity: "normal" };
function plain(options: OutputOptions = PLAIN): Output {
  return createOutput({ stdout: sink(false).stream, stderr: sink(false).stream }, options);
}

const photo = (name: string, more: Partial<PhotoRow> = {}): PhotoRow => ({ name, rating: 0, flag: "none", label: "", edited: false, ...more });

const SUMMARY: ListingSummary = { title: "Iceland 2026 › Day 2", photos: 180, edited: 28, notImported: 2, otherFiles: 14 };
const LISTING: Listing = {
  summary: SUMMARY,
  folders: [
    { name: "Drone", photos: 22, edited: 0, notImported: 22 },
    { name: "Panoramas", photos: 14, edited: 3, notImported: 0 },
  ],
  photos: [
    photo("DSC_0398.NEF", { rating: 5, flag: "pick", label: "red", edited: true, size: "24 MP", state: "imported" }),
    photo("DSC_0401.NEF", { rating: 4, flag: "pick", label: "blue", edited: true, size: "24 MP" }),
    photo("DSC_0419.NEF", { flag: "reject", size: "24 MP", state: "imported" }),
    photo("DSC_0500.NEF", { size: "31 MB", state: "new" }),
    photo("DSC_0502.NEF", { state: "removed" }),
    photo("DSC_0300.NEF", { rating: 3, edited: true, state: "missing" }),
  ],
  fix: { command: "import .", does: "imports the 2 new photos." },
};

const TREE: FolderNode = {
  name: "Iceland 2026", path: ".", photos: 40, edited: 5, notImported: 0,
  children: [
    { name: "Day 1 Reykjavik", path: "Day 1 Reykjavik", photos: 120, edited: 10, notImported: 0, children: [] },
    {
      name: "Day 2 Golden Circle", path: "Day 2 Golden Circle", photos: 158, edited: 20, notImported: 2,
      children: [
        { name: "Drone", path: "Day 2 Golden Circle/Drone", photos: 22, edited: 0, notImported: 22, children: [] },
        { name: "Panoramas", path: "Day 2 Golden Circle/Panoramas", photos: 14, edited: 3, notImported: 0, children: [] },
      ],
    },
    { name: "Day 3", path: "Day 3", photos: 58, edited: 0, notImported: 0, children: [] },
  ],
};
const TREE_SUMMARY: ListingSummary = { title: "Iceland 2026", photos: 412, edited: 38, notImported: 24 };

describe("the tree component", () => {
  interface Node { name: string; children: Node[] }
  const leaf = (name: string, ...children: Node[]): Node => ({ name, children });
  const root = leaf("a", leaf("b", leaf("c"), leaf("d")), leaf("e", leaf("f")));
  const drawn = (glyphs: "full" | "ascii", depth?: number): string[] =>
    treeRows(root, taggedLook(96, { glyphs }), depth).map((row) => untag(row.lines) + row.node.name);

  it("joins each node to its parent, and keeps a line down past a branch that has more below it", () => {
    expect(drawn("full")).toEqual(["a", "├─ b", "│  ├─ c", "│  └─ d", "└─ e", "   └─ f"]);
  });

  it("draws in ASCII where the font has no box lines", () => {
    expect(drawn("ascii")).toEqual(["a", "|-- b", "|   |-- c", "|   \\-- d", "\\-- e", "    \\-- f"]);
  });

  it("stops at a depth, and paints its lines faint", () => {
    expect(drawn("full", 1)).toEqual(["a", "├─ b", "└─ e"]);
    expect(treeRows(root, taggedLook()).map((row) => row.lines)[1]).toBe("‹faint›├─ ‹/›");
  });
});

describe("ls on a terminal", () => {
  it("is a summary, folders with their counts, then photos with how each stands", () => {
    expect(shape(rich().listing(LISTING))).toMatchInlineSnapshot(`
      "
      Iceland 2026 › Day 2 · 180 photos · 28 edited · 2 not imported · 14 other files

      Drone/       22 photos              22 not imported
      Panoramas/   14 photos   3 edited

      DSC_0398.NEF   ★★★★★   pick     ● red    ✱   24 MP
      DSC_0401.NEF   ★★★★·   pick     ● blue   ✱   24 MP
      DSC_0419.NEF   ·····   reject   ·        ·   24 MP
      DSC_0500.NEF   ○ not imported                31 MB
      DSC_0502.NEF   removed from the catalogue
      DSC_0300.NEF   ! file missing · edited

      import . imports the 2 new photos.
      "
    `);
  });

  it("keeps amber for what there is to act on", () => {
    expect(page(rich().listing(LISTING))).toMatchInlineSnapshot(`
      "
      ‹strong›Iceland 2026 › Day 2‹/›‹faint› · ‹/›‹muted›180 photos‹/›‹faint› · ‹/›‹muted›28 edited‹/›‹faint› · ‹/›‹amber›2 not imported‹/›‹faint› · ‹/›‹muted›14 other files‹/›

      ‹strong›Drone‹/›‹faint›/‹/›       22 photos              ‹amber›22 not imported‹/›
      ‹strong›Panoramas‹/›‹faint›/‹/›   14 photos   ‹muted›3 edited‹/›

      DSC_0398.NEF   ‹star›★★★★★‹/›   pick     ‹label.red›●‹/› ‹muted›red‹/›    ‹amber›✱‹/›   ‹muted›24 MP‹/›
      DSC_0401.NEF   ‹star›★★★★‹/›‹faint›·‹/›   pick     ‹label.blue›●‹/› ‹muted›blue‹/›   ‹amber›✱‹/›   ‹muted›24 MP‹/›
      ‹muted›DSC_0419.NEF‹/›   ‹muted›·····‹/›   ‹muted›reject‹/›   ‹faint›·‹/›        ‹faint›·‹/›   ‹muted›24 MP‹/›
      DSC_0500.NEF   ‹muted›○ not imported‹/›                ‹muted›31 MB‹/›
      ‹muted›DSC_0502.NEF‹/›   ‹muted›removed from the catalogue‹/›
      DSC_0300.NEF   ‹amber›! file missing‹/›‹faint› · ‹/›edited

      ‹strong›import‹/› . ‹muted›imports the 2 new photos.‹/›
      "
    `);
  });

  it("gives a photo's name the room that is left, down to 40 columns", () => {
    for (const width of [40, 60, 72, 96]) {
      const lines = rich(width).listing({ ...LISTING, photos: LISTING.photos.map((row) => ({ ...row, name: `Day 2/Golden Circle/${row.name}` })) }).split("\n");
      expect(Math.max(...lines.map(cells)), `at ${width}`).toBeLessThanOrEqual(width - 3);
    }
  });

  it("says so when the folder holds nothing, and leaves out counts that are zero", () => {
    expect(rich().listing({ summary: { title: "Empty", photos: 0, edited: 0, notImported: 0 }, folders: [], photos: [] }).split("\n")).toEqual([
      "‹strong›Empty‹/›‹faint› · ‹/›‹muted›0 photos‹/›",
      "",
      "‹muted›No photos here.‹/›",
    ]);
  });

  it("draws --tree with the photos directly in each folder", () => {
    expect(shape(rich().folderTree(TREE, TREE_SUMMARY))).toMatchInlineSnapshot(`
      "
      Iceland 2026 · 412 photos · 38 edited · 24 not imported

      Iceland 2026              40   5 edited
      ├─ Day 1 Reykjavik       120   10 edited
      ├─ Day 2 Golden Circle   158   20 edited   2 not imported
      │  ├─ Drone               22               22 not imported
      │  └─ Panoramas           14   3 edited
      └─ Day 3                  58
      "
    `);
    expect(untag(rich().folderTree(TREE, TREE_SUMMARY, 1)).split("\n").slice(2).map((line) => line.split("  ")[0])).toEqual([
      "Iceland 2026", "├─ Day 1 Reykjavik", "├─ Day 2 Golden Circle", "└─ Day 3",
    ]);
  });
});

describe("ls off a terminal", () => {
  it("is one tab-separated line an entry: folders, then state, rating, flag, label, edited and path", () => {
    expect(plain().listing(LISTING)).toBe([
      "folder\t22\tDrone/",
      "folder\t14\tPanoramas/",
      "imported\t5\tpick\tred\tedited\tDSC_0398.NEF",
      "imported\t4\tpick\tblue\tedited\tDSC_0401.NEF",
      "imported\t0\treject\tnone\t\tDSC_0419.NEF",
      "new\t\t\t\t\tDSC_0500.NEF",
      "removed\t\t\t\t\tDSC_0502.NEF",
      "missing\t3\tnone\tnone\tedited\tDSC_0300.NEF",
    ].join("\n"));
  });

  it("lists --tree flat, with each folder's path", () => {
    expect(plain().folderTree(TREE, TREE_SUMMARY)).toBe([
      "folder\t40\t./",
      "folder\t120\tDay 1 Reykjavik/",
      "folder\t158\tDay 2 Golden Circle/",
      "folder\t22\tDay 2 Golden Circle/Drone/",
      "folder\t14\tDay 2 Golden Circle/Panoramas/",
      "folder\t58\tDay 3/",
    ].join("\n"));
    expect(plain().folderTree(TREE, TREE_SUMMARY, 1).split("\n")).toHaveLength(4);
  });
});

describe("photos keeps its look now that rows carry a state", () => {
  it("draws an imported row the same with and without the state", () => {
    const rows = LISTING.photos.slice(0, 3);
    expect(rich().photoTable(rows)).toBe(rich().photoTable(rows.map(({ state: _state, ...row }) => row)));
    expect(plain().photoTable(rows)).toBe(plain().photoTable(rows.map(({ state: _state, ...row }) => row)));
  });
});

describe("the contact sheet", () => {
  const pixels = (width: number, height: number, colour: readonly [number, number, number]) => ({
    width, height, rgba: Uint8Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 3 ? 255 : colour[i % 4])),
  });

  it("turns pixels into half blocks that fit a cell, keeping the photo's shape", () => {
    const wide = gridPictureFromRgba(pixels(300, 200, [10, 20, 30]), richOptions(96)) as string[];
    expect(wide).toEqual(Array.from({ length: 5 }, () => "▀".repeat(14)));
    const tall = gridPictureFromRgba(pixels(200, 300, [10, 20, 30]), richOptions(96)) as string[];
    expect(tall).toEqual(Array.from({ length: 7 }, () => `  ${"▀".repeat(9)}`));
  });

  it("paints each cell with its upper pixel on its lower one, in 24-bit colour or the 256-colour cube", () => {
    const wide = { width: 2, height: 2, rgba: Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]) };
    const line = (gridPictureFromRgba(wide, richOptions(96, { tier: "truecolour" })) as string[])[3];
    expect(line).toContain("\x1b[38;2;255;0;0;48;2;0;0;255m▀");
    expect(line.endsWith("\x1b[39;49m")).toBe(true);
    expect(cells(line)).toBe(14);
    const coarse = (gridPictureFromRgba(wide, richOptions(96, { tier: "256" })) as string[])[3];
    expect(coarse).toContain("\x1b[38;5;196;48;5;21m▀");
  });

  it("has no blocks to give a pipe, 16 colours, or pixels that aren't all there", () => {
    const image = pixels(30, 20, [1, 2, 3]);
    expect(gridPictureFromRgba(image, { ...richOptions(96), caps: undefined })).toBeNull();
    expect(gridPictureFromRgba(image, richOptions(96, { tier: "16" }))).toBeNull();
    expect(gridPictureFromRgba({ ...image, rgba: image.rgba.slice(0, 40) }, richOptions(96))).toBeNull();
  });

  const cell = (name: string, more: Partial<GridCell> = {}): GridCell => ({ ...photo(name), ...more });

  it("shows how a cell stands with the catalogue where its marks would be", () => {
    const picture = ["▀".repeat(14), "▀".repeat(14)];
    const sheet = formatPhotoGrid([
      cell("DSC_0398.NEF", { rating: 5, label: "red", edited: true, picture }),
      cell("DSC_0500.NEF", { state: "new" }),
      cell("DSC_0502.NEF", { state: "removed" }),
      cell("DSC_0300.NEF", { state: "missing", edited: true }),
    ], richOptions(96));
    expect(shape(sheet ?? "")).toMatchInlineSnapshot(`
      "
      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀
      ▀▀▀▀▀▀▀▀▀▀▀▀▀▀
      DSC_0398         DSC_0500         DSC_0502         DSC_0300
      ★★★★★ ● ✱        ○ not imported   removed          ! file missing
      "
    `);
  });

  it("hands iTerm2 the stored JPEG, placed by the cursor, and steps past it instead of writing over it", () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const picture = gridPictureFromJpeg(jpeg, { width: 6048, height: 4024 });
    expect(picture).toEqual({ jpeg, rows: 5 });
    expect(gridPictureFromJpeg(jpeg, { width: 4024, height: 6048 })).toEqual({ jpeg, rows: 7 });
    expect(gridPictureFromJpeg(jpeg)).toEqual({ jpeg, rows: 5 });

    const lines = (formatPhotoGrid([cell("a.NEF", { picture }), cell("b.NEF", { state: "new" })], richOptions(96)) ?? "").split("\n");
    const file = `\x1b]1337;File=inline=1;size=4;width=14;height=5;preserveAspectRatio=1:${Buffer.from(jpeg).toString("base64")}\x07`;
    expect(lines).toEqual([
      // Room for the picture first, so drawing it on the last line can't scroll the screen under it.
      "", "", "", "",
      `\x1b[4A\x1b7${file}\x1b8\x1b[14C\x1b[3C\x1b[14C`,
      "", "", "", "",
      "a                b",
      "                 ‹muted›○ not imported‹/›",
    ]);
  });
});

describe("import", () => {
  it("says what it is about to do, and where a new catalogue lives", () => {
    const out = rich();
    expect(out.importPlan({ project: "Iceland 2026", newFiles: 412, gone: 3 }))
      .toBe("‹muted›Importing into‹/› Iceland 2026‹faint› · ‹/›‹muted›412 new‹/›‹faint› · ‹/›‹amber›3 files gone‹/›");
    expect(untag(out.importPlan({ project: "Card", newFiles: 9, started: { workingDir: String.raw`D:\Card\.safelight`, external: false } })).split("\n")).toEqual([
      String.raw`Starting a catalogue for Card in D:\Card\.safelight`,
      "Importing into Card · 9 new",
    ]);
    expect(untag(out.importPlan({ project: "Card", newFiles: 9, started: { workingDir: String.raw`C:\Users\a\external-catalogs\Card-3fa2c1d0`, external: true } })).split("\n")[0])
      .toBe(String.raw`Starting a catalogue for Card, kept separately at C:\Users\a\external-catalogs\Card-3fa2c1d0`);
  });

  it("says a dry run would do it, and changed nothing", () => {
    const plan = { project: "Card", newFiles: 9, dryRun: true, started: { workingDir: String.raw`D:\Card\.safelight`, external: false } };
    const expected = [
      String.raw`Would start a catalogue for Card in D:\Card\.safelight`,
      "Would import into Card · 9 new",
      "Dry run: nothing was changed.",
    ];
    expect(untag(rich().importPlan(plan)).split("\n")).toEqual(expected);
    expect(plain().importPlan(plan).split("\n")).toEqual(expected);
  });

  it("marks each file as it lands", () => {
    const out = rich();
    expect([
      out.importedFile({ path: "Day 2/DSC_0501.NEF", state: "ok" }),
      out.importedFile({ path: "Day 2/DSC_0502.NEF", state: "no-preview" }),
      out.importedFile({ path: "Day 2/DSC_0503.NEF", state: "failed" }),
      out.importedFile({ path: "Day 2/DSC_0504.NEF", state: "failed", error: "is 0 bytes" }),
    ]).toEqual([
      "‹ok›✓‹/› Day 2/DSC_0501.NEF",
      "‹ok›✓‹/› Day 2/DSC_0502.NEF   ‹muted›no preview yet‹/›",
      "‹lamp›✕‹/› Day 2/DSC_0503.NEF   couldn't be read",
      "‹lamp›✕‹/› Day 2/DSC_0504.NEF   is 0 bytes",
    ]);
  });

  const DONE: ImportSummary = {
    project: "Iceland 2026", imported: 410, total: 412, ms: 72_000,
    failed: ["DSC_0503.NEF", "DSC_0611.NEF"],
    moved: [{ from: "IMG_9.ARW", to: "Day 1/IMG_9.ARW" }],
    dropped: [{ relPath: "DSC_0101.NEF" }, { relPath: "DSC_0102.NEF", edited: true }, { relPath: "DSC_0140.NEF" }],
    pending: 0,
    stopped: null,
  };

  it("ends with what came in, what couldn't, what left and what moved", () => {
    expect(page(rich().importSummary(DONE))).toMatchInlineSnapshot(`
      "
      ‹ok›✓‹/› 410 imported into Iceland 2026 · 1 min 12 s
      ‹lamp›✕‹/› 2 couldn't be read: DSC_0503.NEF, DSC_0611.NEF
      ‹faint›·‹/› ‹muted›3 photos whose files are gone left the catalogue (1 had edits): DSC_0101.NEF, DSC_0102.NEF,‹/›
        ‹muted›DSC_0140.NEF‹/›
      ‹faint›·‹/› ‹muted›1 photo was found under a new name: IMG_9.ARW → Day 1/IMG_9.ARW‹/›
      "
    `);
  });

  it("says what is still to read after --quick, and why it stopped early", () => {
    const quick = untag(rich().importSummary({ ...DONE, failed: [], moved: [], dropped: [], pending: 380 })).split("\n");
    expect(quick).toEqual([
      "✓ 410 imported into Iceland 2026 · 1 min 12 s",
      "· 380 photos' camera data is still to read; Safelight reads it in the background, or run",
      "  import again.",
    ]);
    const none: ImportSummary = { ...DONE, imported: 137, failed: [], moved: [], dropped: [] };
    expect(rich().importSummary({ ...none, stopped: "interrupted" })).toBe("‹amber›!‹/› Stopped after 137 of 412. import carries on from there.");
    expect(untag(rich().importSummary({ ...none, stopped: "safelight-opened" })).split("\n")).toEqual([
      "! Safelight opened Iceland 2026, so the import stopped after 137 of 412. Safelight imports",
      "  the rest itself.",
    ]);
    expect(untag(rich().importSummary({ ...none, imported: 0, ms: undefined }))).toBe("✓ Nothing new to import into Iceland 2026");
  });

  it("names a handful of files and counts the rest", () => {
    const many = Array.from({ length: 9 }, (_, i) => `DSC_000${i}.NEF`);
    expect(untag(rich().importSummary({ ...DONE, imported: 0, failed: many, moved: [], dropped: [] })))
      .toBe("✕ 9 couldn't be read: DSC_0000.NEF, DSC_0001.NEF, DSC_0002.NEF, DSC_0003.NEF, DSC_0004.NEF\n  and 4 more");
  });

  it("is plain lines off a terminal: a state and a path for each file, then sentences", () => {
    const out = plain();
    expect(out.importPlan({ project: "Iceland 2026", newFiles: 412, gone: 1 })).toBe("Importing into Iceland 2026 · 412 new · 1 file gone");
    expect(out.importedFile({ path: "Day 2/DSC_0502.NEF", state: "no-preview" })).toBe("no-preview\tDay 2/DSC_0502.NEF");
    expect(out.importedFile({ path: "Day 2/DSC_0503.NEF", state: "failed", error: "is 0 bytes" })).toBe("failed\tDay 2/DSC_0503.NEF");
    expect(out.importSummary(DONE)).toBe([
      "410 imported into Iceland 2026 · 1 min 12 s",
      "2 couldn't be read: DSC_0503.NEF, DSC_0611.NEF",
      "3 photos whose files are gone left the catalogue (1 had edits): DSC_0101.NEF, DSC_0102.NEF, DSC_0140.NEF",
      "1 photo was found under a new name: IMG_9.ARW -> Day 1/IMG_9.ARW",
    ].join("\n"));
    expect(plain({ ...PLAIN, unicode: false }).importSummary(DONE).split("\n")[0]).toBe("410 imported into Iceland 2026 - 1 min 12 s");
  });
});

describe("keywords", () => {
  const rows = [{ keyword: "iceland", count: 412 }, { keyword: "black sand", count: 9 }];
  const each = [
    { photo: "DSC_0412.NEF", keywords: ["iceland", "black sand"] },
    { photo: "Day 2/DSC_0500.NEF", keywords: [] },
  ];

  it("lists the project's keywords with their counts in a column", () => {
    expect(rich().keywordTable(rows).split("\n")).toEqual(["iceland      ‹muted›412‹/›", "black sand     ‹muted›9‹/›"]);
    expect(rich().keywordTable([])).toBe("‹muted›No keywords.‹/›");
  });

  it("sets each photo's keywords after its name, and wraps a long list under its first word", () => {
    expect(rich().keywordList(each).split("\n")).toEqual([
      "DSC_0412.NEF         iceland‹faint› · ‹/›black sand",
      "Day 2/DSC_0500.NEF   ‹faint›·‹/›",
    ]);
    const long = untag(rich(48).keywordList([{ photo: "a.NEF", keywords: ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] }])).split("\n");
    expect(long.length).toBeGreaterThan(1);
    expect(long.slice(1).every((line) => line.startsWith(" ".repeat(8)))).toBe(true);
    expect(Math.max(...long.map(cells))).toBeLessThanOrEqual(45);
  });

  it("is tab-separated off a terminal", () => {
    expect(plain().keywordTable(rows)).toBe("iceland\t412\nblack sand\t9");
    expect(plain().keywordList(each)).toBe("DSC_0412.NEF\ticeland, black sand\nDay 2/DSC_0500.NEF\t");
  });
});

describe("forget", () => {
  const risk = { photos: 12, edited: ["DSC_0412.NEF", "DSC_0413.NEF"], command: "forget *.NEF --yes" };

  it("refuses with how many would lose edits and the line that goes ahead", () => {
    expect(plain().forgetProblem(risk)).toEqual({
      message: "2 of these 12 have edits that would be lost.",
      hint: "Add --yes to remove them anyway.",
      fix: "forget *.NEF --yes",
    });
    expect(plain().forgetProblem({ photos: 1, edited: ["a.NEF"] })).toEqual({ message: "It has edits that would be lost.", hint: "Add --yes to remove them anyway." });
    expect(plain().forgetProblem({ photos: 2, edited: ["a.NEF", "b.NEF"] }).message).toBe("Both have edits that would be lost.");
    expect(plain().forgetProblem({ photos: 3, edited: ["a.NEF", "b.NEF", "c.NEF"] }).message).toBe("All 3 have edits that would be lost.");
  });

  it("reads as an error card on a terminal and as the plain error everywhere else", () => {
    expect(page(rich().problem("error", rich().forgetProblem(risk)))).toMatchInlineSnapshot(`
      "
        ‹lamp›✕‹/› 2 of these 12 have edits that would be lost.
        ‹lamp›│‹/› ‹muted›Add --yes to remove them anyway.‹/›
        ‹lamp›╰‹/› ‹strong›forget‹/› *.NEF ‹muted›--yes‹/›
      "
    `);
    expect(plain().problem("error", plain().forgetProblem(risk)))
      .toBe("safelight: 2 of these 12 have edits that would be lost.\n           Add --yes to remove them anyway.");
  });

  it("draws the card a question sits under: what goes, what stays, and which photos lose edits", () => {
    expect(page(formatForgetCard(risk, richOptions(96)).trimEnd())).toMatchInlineSnapshot(`
      "
        ‹amber›╭‹/›‹amber›─‹/› ‹strong›Remove 12 photos from the catalogue‹/› ‹amber›────────────────────────────‹/›‹amber›╮‹/›
        ‹amber›│‹/› Their records, edit history and previews go.                     ‹amber›│‹/›
        ‹amber›│‹/› ‹muted›The files stay on disk and aren't imported again.‹/›                ‹amber›│‹/›
        ‹amber›│‹/›                                                                  ‹amber›│‹/›
        ‹amber›│‹/› ‹amber›!‹/› 2 of these 12 have edits that would be lost.                   ‹amber›│‹/›
        ‹amber›│‹/›   DSC_0412.NEF, DSC_0413.NEF                                     ‹amber›│‹/›
        ‹amber›╰──────────────────────────────────────────────────────────────────╯‹/›
      "
    `);
    const none = untag(formatForgetCard({ photos: 1, edited: [] }, richOptions(96)));
    expect(none).toContain("Remove 1 photo from the catalogue");
    expect(none).not.toContain("edits");
    expect(formatForgetCard(risk, PLAIN)).toBe("");
  });
});

describe("the prompt off a terminal", () => {
  it("carries the folder, the working set and read only, and is the bytes it was without them", () => {
    expect(formatPrompt({ projectName: "Iceland 2026" }, PLAIN)).toBe("Iceland 2026 › ");
    expect(formatPrompt({ projectName: "Iceland 2026", folder: "Day 2" }, PLAIN)).toBe("Iceland 2026/Day 2 › ");
    expect(formatPrompt({ projectName: "Iceland 2026", open: { name: "DSC_0412", at: 1, of: 1 } }, PLAIN)).toBe("Iceland 2026 › DSC_0412 › ");
    expect(formatPrompt({ projectName: "Iceland 2026", open: { name: "DSC_0412", at: 2, of: 3 } }, PLAIN)).toBe("Iceland 2026 › DSC_0412 2/3 › ");
    expect(formatPrompt({ projectName: "Iceland 2026", open: { of: 3 }, readOnly: true }, PLAIN)).toBe("Iceland 2026 › 3 photos (read only) › ");
    expect(formatPrompt({ projectName: "Iceland 2026", folder: "Day 2", busy: true }, { ...PLAIN, unicode: false })).toBe("Iceland 2026/Day 2 ... ");
  });
});

describe("export's closing lines", () => {
  const failed = [{ name: "DSC_0407.NEF", error: "can't be decoded" }];

  it("says what was written, where, how much and how long, then what failed", () => {
    expect(rich().exportSummary({ exported: 77, failed, folder: String.raw`..\wedding-web`, bytes: 117_440_512, ms: 72_000 }).split("\n")).toEqual([
      String.raw`‹ok›✓‹/› 77 exported to ..\wedding-web‹faint› · ‹/›‹muted›112.0 MB‹/›‹faint› · ‹/›‹muted›1 min 12 s‹/›`,
      "‹lamp›✕‹/› 1 failed: DSC_0407.NEF can't be decoded",
    ]);
    expect(untag(rich().exportSummary({ exported: 0, failed: [...failed, { name: "b.NEF", error: "is 0 bytes" }] }))).toBe("✕ 2 failed: DSC_0407.NEF, b.NEF");
    expect(untag(rich().exportSummary({ exported: 3, failed: [] }))).toBe("✓ 3 exported");
  });

  it("is the batch summary's bytes off a terminal", () => {
    const out = plain();
    expect(out.exportSummary({ exported: 77, failed, folder: "x", bytes: 1, ms: 1 })).toBe(out.summary({ photos: 78, stepEach: false, failed: 1, skipped: 0 }));
    expect(out.exportSummary({ exported: 3, failed: [] })).toBe("3 photos");
  });
});

function rig(options: OutputOptions, tty = { stdout: true, stderr: true }) {
  const stdout = sink(tty.stdout, options.width);
  const stderr = sink(tty.stderr, options.width);
  const out = createOutput({ stdout: stdout.stream, stderr: stderr.stream }, options);
  const frameOf = (chunks: readonly string[]): string =>
    stripMarkup(chunks[chunks.length - 1] ?? "").replace(/\x1b\[[?0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
  return { out, stdout, stderr, frame: () => frameOf(stderr.chunks), screen: () => frameOf(stdout.chunks) };
}

describe("a long job's finished rows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const state = (done: number, total: number) => ({
    label: "Exporting", done, total, startedAt: 1_000_000, items: [{ name: `DSC_${done + 1}.NEF`, state: "working" as const }],
  });
  const row = (out: Output, n: number): string => out.exported({ path: `DSC_${n}.jpg`, width: 2048, height: 1365, colourSpace: "sRGB", bytes: 1_468_006 });

  it("stay in scrollback while the job is 30 photos or fewer", () => {
    const { out, stdout, frame } = rig(richOptions(96, { motion: "full" }));
    out.progress(state(0, 30));
    for (let n = 1; n <= 7; n++) out.finished(row(out, n));
    expect(untag(stdout.text()).split("\n").filter((line) => line !== "")).toHaveLength(7);
    expect(frame()).not.toContain(".jpg");
    out.progress(null);
  });

  it("past 30, only the last five show, above the lamp, and they go when the job ends", () => {
    const { out, stdout, stderr, frame } = rig(richOptions(96, { motion: "full" }));
    out.progress(state(0, 78));
    for (let n = 1; n <= 7; n++) {
      vi.advanceTimersByTime(100);
      out.finished(row(out, n));
    }
    expect(stdout.text()).toBe("");
    expect(frame().split("\n")).toEqual([
      "  ✓ DSC_3.jpg   2048×1365   sRGB   1.4 MB",
      "  ✓ DSC_4.jpg   2048×1365   sRGB   1.4 MB",
      "  ✓ DSC_5.jpg   2048×1365   sRGB   1.4 MB",
      "  ✓ DSC_6.jpg   2048×1365   sRGB   1.4 MB",
      "  ✓ DSC_7.jpg   2048×1365   sRGB   1.4 MB",
      "  ● DSC_1.NEF   Exporting…",
      "",
      "  ────────────────────────────────────────────────   0 of 78",
    ]);
    out.progress(null);
    expect(stderr.chunks[stderr.chunks.length - 1]).toBe("\r\x1b[7A\x1b[J\x1b[?25h");
    out.print(out.exportSummary({ exported: 7, failed: [] }));
    expect(untag(stdout.text())).toBe("  ✓ 7 exported\n");

    out.progress(state(0, 78));
    expect(frame()).not.toContain(".jpg");
    out.progress(null);
  });

  it("all print with -v, to a pipe, and where stderr has no live region", () => {
    const verbose = rig(richOptions(96, {}, "verbose"));
    verbose.out.progress(state(0, 78));
    verbose.out.finished(row(verbose.out, 1));
    expect(untag(verbose.stdout.text())).toBe("  ✓ DSC_1.jpg   2048×1365   sRGB   1.4 MB\n");
    verbose.out.progress(null);

    const piped = rig(richOptions(96, { rich: { stdout: false, stderr: true } }), { stdout: false, stderr: true });
    piped.out.progress(state(0, 78));
    piped.out.finished(row(piped.out, 1));
    expect(piped.stdout.text()).toBe(`${piped.out.exported({ path: "DSC_1.jpg", width: 2048, height: 1365, colourSpace: "sRGB", bytes: 1_468_006 })}\n`);
    expect(piped.stdout.text()).not.toContain("✓");
    piped.out.progress(null);

    const redirected = rig(richOptions(96, { rich: { stdout: true, stderr: false } }), { stdout: true, stderr: false });
    redirected.out.progress(state(0, 78));
    redirected.out.finished(row(redirected.out, 1));
    expect(untag(redirected.stdout.text())).toContain("✓ DSC_1.jpg");

    const quiet = rig(richOptions(96, {}, "quiet"));
    quiet.out.finished(row(quiet.out, 1));
    expect(quiet.stdout.text()).toBe("");
  });

  it("an import shows its files, each named while it is read, then its camera data on one line", () => {
    const { out, stdout, frame } = rig(richOptions(96, { motion: "full" }));
    out.importProgress({ phase: "files", done: 137, total: 412, reading: ["Day 2/DSC_0504.NEF", "Day 2/DSC_0505.NEF"], startedAt: 1_000_000 - 68_000 });
    for (const [at, name] of ["Day 2/DSC_0501.NEF", "Day 2/DSC_0502.NEF", "Day 2/DSC_0503.NEF"].entries()) {
      vi.advanceTimersByTime(100);
      out.finished(out.importedFile({ path: name, state: (["ok", "no-preview", "failed"] as const)[at] }));
    }
    expect(stdout.text()).toBe("");
    expect(frame().split("\n")).toEqual([
      "  ✓ Day 2/DSC_0501.NEF",
      "  ✓ Day 2/DSC_0502.NEF   no preview yet",
      "  ✕ Day 2/DSC_0503.NEF   couldn't be read",
      "  ● Day 2/DSC_0504.NEF   reading…  +1 more",
      "",
      "  ━━━━━━━━━━━━━━━━────────────────────────────────   137 of 412 · about 2 min left",
    ]);

    vi.advanceTimersByTime(50);
    out.importProgress({ phase: "camera-data", done: 37, total: 380, startedAt: Date.now() - 12_000 });
    expect(frame()).toBe("  ● Reading camera data…  12.0 s   ━━╸─────────────────────   37 of 380 · about 2 min left");
    out.importProgress(null);
    expect(frame()).toBe("");
  });

  it("an import off a terminal is the one progress line", () => {
    const { out, stderr } = rig({ ...PLAIN, width: 96 }, { stdout: false, stderr: true });
    out.importProgress({ phase: "camera-data", done: 37, total: 380, startedAt: 0 });
    expect(stderr.text()).toBe("\rReading camera data   37/380  ━━──────────────────");
  });
});

describe("doctor on a terminal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says what to do once: a value that ends with its own hint loses the ending", () => {
    const text = untag(rich().doctor([
      { label: "Graphics", value: "not known yet: open Safelight once", status: "info", hint: "Open Safelight once so it records its graphics backend." },
      { label: "Settings", value: "not shared yet: open Safelight once", status: "warn", hint: "Open Safelight once." },
      { label: "Project", value: String.raw`D:\Photos: free to write`, status: "ok", hint: "Nothing to do." },
      { label: "Ranges", value: "unknown for Retinex: open Safelight once", status: "warn", hint: "Safelight writes each extension's ranges the first time it runs with it." },
    ])).split("\n");
    expect(text).toEqual([
      "· Graphics   not known yet",
      "             Open Safelight once so it records its graphics backend.",
      "! Settings   not shared yet",
      "             Open Safelight once.",
      String.raw`✓ Project    D:\Photos: free to write`,
      "             Nothing to do.",
      "! Ranges     unknown for Retinex: open Safelight once",
      "             Safelight writes each extension's ranges the first time it runs with it.",
      "",
      "2 notes",
    ]);
  });

  it("keeps the whole value in the plain list, which has no hints", () => {
    expect(plain().doctor([{ label: "Settings", value: "not shared yet: open Safelight once", status: "warn", hint: "Open Safelight once." }]))
      .toBe("! Settings  not shared yet: open Safelight once");
  });

  const gate = <T>() => {
    let open: (value: T) => void = () => {};
    const done = new Promise<T>((resolve) => { open = resolve; });
    return { done, open };
  };

  it("starts every row as a lamp and settles each into its mark as its check finishes", async () => {
    const { out, stdout, screen } = rig(richOptions(96, { motion: "full" }));
    const app = gate<void>();
    const extensions = gate<void>();
    const checks: DoctorCheck[] = [
      { label: "App", run: async () => { await app.done; return { label: "App", value: "Safelight 3.3.0", status: "ok" }; } },
      {
        label: "Extensions",
        run: async () => {
          await extensions.done;
          return [
            { label: "Extensions", value: "14 installed", status: "info" },
            { label: "Catalogue hooks", value: "XMP runs when Safelight saves", status: "warn", hint: "Make edits that need them in Safelight." },
          ];
        },
      },
    ];
    const run = out.checklist(checks);
    expect(screen().split("\n")).toEqual(["  ● App", "  ● Extensions"]);
    const drawn = stdout.chunks.length;
    await vi.advanceTimersByTimeAsync(160);
    expect(stdout.chunks.length).toBe(drawn + 2);

    app.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(screen().split("\n")).toEqual(["  ✓ App          Safelight 3.3.0", "  ● Extensions"]);

    extensions.open();
    const items = await run;
    expect(items.map((item) => item.label)).toEqual(["App", "Extensions", "Catalogue hooks"]);
    expect(untag(stdout.chunks[stdout.chunks.length - 1])).toBe([
      "\r\x1b[1A\x1b[J  ✓ App               Safelight 3.3.0",
      "  · Extensions        14 installed",
      "  ! Catalogue hooks   XMP runs when Safelight saves",
      "                      Make edits that need them in Safelight.",
      "",
      "  1 note",
      "\x1b[?25h",
    ].join("\n"));
    expect(stdout.stream.write).toBe(Object.getPrototypeOf(stdout.stream).write);
    await vi.advanceTimersByTimeAsync(500);
    expect(stdout.chunks[stdout.chunks.length - 1]).toContain("1 note");
  });

  it("prints the plain list in one go off a terminal, and nothing with -q", async () => {
    const checks: DoctorCheck[] = [
      { label: "App", run: async () => ({ label: "App", value: "Safelight 3.3.0", status: "ok" }) },
      { label: "Engine", run: async () => ({ label: "Engine", value: "not found", status: "fail" }) },
    ];
    const piped = rig(PLAIN, { stdout: false, stderr: false });
    const items = await piped.out.checklist(checks);
    expect(piped.stdout.text()).toBe(`${piped.out.doctor(items)}\n`);
    expect(piped.stdout.chunks).toHaveLength(1);

    const quiet = rig(richOptions(96, {}, "quiet"));
    expect(await quiet.out.checklist(checks)).toEqual(items);
    expect(quiet.stdout.text()).toBe("");
  });

  it("puts the terminal back when a check throws", async () => {
    const { out, stdout } = rig(richOptions(96));
    await expect(out.checklist([{ label: "App", run: async () => { throw new Error("no"); } }])).rejects.toThrow("no");
    expect(stdout.chunks[stdout.chunks.length - 1]).toBe("\r\x1b[J\x1b[?25h");
    expect(stdout.stream.write).toBe(Object.getPrototypeOf(stdout.stream).write);
  });
});

describe("help", () => {
  const verbs = [
    { verb: "photos", group: "Look" as const, summary: "" },
    ...["ls", "import", "open", "forget"].map((verb) => ({ verb, group: "Library" as const, summary: "" })),
    { verb: "set", group: "Edit" as const, summary: "" },
  ];
  const groups = (text: string): string[] => untag(text).split("\n").filter((line) => /^(Look|Library|Edit) /.test(line));

  it("lists the Library group after Look, on a terminal and off it", () => {
    expect(groups(rich().help({ version: "3.3.0", verbs }))).toEqual(["Look         photos", "Library      ls  import  open  forget", "Edit         set"]);
    expect(groups(plain().help({ version: "3.3.0", verbs }))).toEqual(["Look         photos", "Library      ls   import   open   forget", "Edit         set"]);
  });
});
