// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { CONTRAST, EXPOSURE, HIGHLIGHTS, SHARPENING, TEMPERATURE, TINT, taggedLook, untag } from "../fixtures";
import { TAGGED } from "../fixtures";
import { lookOf } from "../look";
import { cells } from "../width";
import { pill, trustBadge } from "./badge";
import { barCells, barWidth, sliderBar, sliderDefault, sliderPosition } from "./bar";
import { card } from "./card";
import { valueDiff } from "./diff";
import { errorCard, notice } from "./error-card";
import { keyHints } from "./hints";
import { elapsedText, lamp, lampLine } from "./lamp";
import { panel } from "./panel";
import { aboutText, progressBar, progressCount, remainingMs } from "./progress";
import { grid } from "./table";
import { dayName, timeline } from "./timeline";

const look = taggedLook(96);
const ascii = taggedLook(96, { glyphs: "ascii" });
const basic = taggedLook(96, { glyphs: "basic" });
const bar = (info: typeof EXPOSURE, value: number, was?: number, size = 21, on = look): string => sliderBar({ info, value, was, cells: size }, on);

describe("sliderBar", () => {
  it("shows only the tick at the default", () => {
    expect(bar(EXPOSURE, 0)).toBe("‹faint›──────────‹/›‹muted›┼‹/›‹faint›──────────‹/›");
  });

  it("fills from the default to the thumb, either way", () => {
    expect(untag(bar(EXPOSURE, 2.5))).toBe("──────────┼━━━━●─────");
    expect(untag(bar(HIGHLIGHTS, -40))).toBe("──────●╺━━┼──────────");
    expect(bar(EXPOSURE, 2.5)).toBe("‹faint›──────────‹/›‹muted›┼‹/›‹amber›━━━━●‹/›‹faint›─────‹/›");
  });

  it("puts the tick at the default, not at zero", () => {
    expect(untag(bar(SHARPENING, 25))).toBe("───┼─────────────────");
    expect(untag(bar(SHARPENING, 90))).toBe("───┼━━━━━━━━●────────");
  });

  it("draws a value with no default as a thumb on a bare track", () => {
    expect(sliderDefault(TEMPERATURE)).toBeUndefined();
    expect(untag(bar(TEMPERATURE, 5600))).toBe("──────●──────────────");
  });

  it("follows the slider's own curve where it has one", () => {
    expect(sliderPosition(TEMPERATURE, 2000)).toBe(0);
    expect(sliderPosition(TEMPERATURE, 50000)).toBe(1);
    expect(sliderPosition(TEMPERATURE, 10000)).toBeCloseTo(0.5, 5);
    expect(sliderPosition(EXPOSURE, 9)).toBe(1);
    expect(sliderPosition(EXPOSURE, -9)).toBe(0);
  });

  it("shows the half the thumb sits in where the font has half cells", () => {
    expect(untag(bar(EXPOSURE, 2.3))).toBe("──────────┼━━━╸●─────");
    expect(untag(bar(EXPOSURE, 2.3, undefined, 21, basic))).toBe("──────────┼════●─────");
  });

  it("draws before and after: old ground dim, the stretch that moved bright", () => {
    expect(bar(EXPOSURE, 3, 1.5)).toBe("‹faint›──────────‹/›‹muted›┼‹/›‹amberDim›━━○‹/›‹amber›━━●‹/›‹faint›────‹/›");
    expect(untag(bar(HIGHLIGHTS, -40, 0))).toBe("──────●╺━━○──────────");
    expect(untag(bar(EXPOSURE, 1, 3))).toBe("──────────┼━●━━━○────");
    expect(untag(bar(EXPOSURE, -2, 2))).toBe("──────●╺━━┼━━━○──────");
  });

  it("still shows which way a move too small for a cell went", () => {
    expect(untag(bar(EXPOSURE, 5, 4.9))).toBe("──────────┼━━━━━━━━○●");
    expect(untag(bar(TEMPERATURE, 5150, 5200))).toBe("──────●○─────────────");
  });

  it("has an ASCII form with brackets, and is as wide as it says", () => {
    expect(untag(bar(EXPOSURE, 2.5, 1, 15, ascii))).toBe("[-------|.==o---]");
    expect(cells(bar(EXPOSURE, 2.5, 1, 15, ascii))).toBe(barWidth(15, ascii));
    expect(cells(bar(EXPOSURE, 2.5))).toBe(barWidth(21, look));
  });

  it("tints tracks that are colours in the app, in 24-bit colour only", () => {
    const truecolour = lookOf({ ...TAGGED, tier: "truecolour" }, 96);
    expect(sliderBar({ info: TEMPERATURE, value: 5600, cells: 3 }, truecolour))
      .toBe("\x1b[38;2;106;165;255m─\x1b[39m\x1b[38;2;245;165;36m●\x1b[39m\x1b[38;2;255;177;74m─\x1b[39m");
    expect(sliderBar({ info: TEMPERATURE, value: 5600, cells: 3 }, look)).toBe("‹faint›─‹/›‹amber›●‹/›‹faint›─‹/›");
    expect(sliderBar({ info: TINT, value: 0, was: 4, cells: 5 }, truecolour)).toContain("38;2;76;201;112");
  });

  it("gets narrower with the terminal, then goes", () => {
    expect([120, 96, 95, 72, 71, 50, 49].map(barCells)).toEqual([21, 21, 16, 16, 10, 10, 0]);
    expect(sliderBar({ info: { ...EXPOSURE, rangeUnknown: true }, value: 1, cells: 21 }, look)).toBe("");
    expect(sliderBar({ info: EXPOSURE, value: 1, cells: 0 }, look)).toBe("");
  });
});

describe("panel", () => {
  it("sets the title and a note into the top edge", () => {
    expect(panel({ title: "Title", note: "right note", body: ["body", ""], width: 34 }, look).map(untag)).toEqual([
      "╭─ Title ─────────── right note ─╮",
      "│ body                           │",
      "│                                │",
      "╰────────────────────────────────╯",
    ]);
  });

  it("keeps every line the same width, drops the note first, then cuts the title", () => {
    for (const width of [40, 24, 14]) {
      const lines = panel({ title: look.theme.paint("strong", "Pyramid Local Contrast"), note: "! unverified", body: ["x"], width }, look);
      expect(lines.map(cells)).toEqual([width, width, width]);
    }
    expect(untag(panel({ title: "Pyramid Local Contrast", note: "! unverified", body: [], width: 30 }, look)[0])).toBe("╭─ Pyramid Local Contrast ───╮");
    expect(untag(panel({ title: "Pyramid Local Contrast", note: "! unverified", body: [], width: 16 }, look)[0])).toBe("╭─ Pyramid L… ─╮");
  });

  it("is amber when it is asking, and square or ASCII where the font needs it", () => {
    expect(panel({ body: ["x"], width: 9, tone: "amber" }, look)[2]).toBe("‹amber›╰───────╯‹/›");
    expect(untag(panel({ body: ["x"], width: 9 }, basic)[0])).toBe("┌───────┐");
    expect(panel({ title: "T", body: ["x"], width: 9 }, ascii).map(untag)).toEqual(["+- T ---+", "| x     |", "+-------+"]);
  });
});

describe("badges and hints", () => {
  it("has a quiet badge for each trust level and a pill for the one that stops you", () => {
    expect(trustBadge("verified", look)).toBe("‹ok›✓‹/› verified");
    expect(trustBadge("official", look)).toBe("‹lamp›●‹/› official");
    expect(trustBadge("unverified", look)).toBe("‹amber›! unverified‹/›");
    expect(trustBadge("banned", look)).toBe("‹pill.lamp› banned ‹/›");
    expect(pill("read only", "amber", look)).toBe("‹pill.amber› read only ‹/›");
    expect(trustBadge("verified", ascii)).toBe("‹ok›ok‹/› verified");
  });

  it("lists at most five keys and drops from the right when narrow", () => {
    const hints = [["↑↓", "move"], ["enter", "choose"], ["tab", "mark"], ["esc", "back"], ["type to filter", ""], ["f1", "help"]] as const;
    expect(keyHints(hints, 80, look)).toBe("↑↓ ‹muted›move‹/›‹faint› · ‹/›enter ‹muted›choose‹/›‹faint› · ‹/›tab ‹muted›mark‹/›‹faint› · ‹/›esc ‹muted›back‹/›‹faint› · ‹/›type to filter");
    expect(untag(keyHints(hints, 30, look))).toBe("↑↓ move · enter choose");
    expect(untag(keyHints(hints, 40, ascii))).toBe("up/down move - enter choose - tab mark");
  });
});

describe("grid", () => {
  it("aligns styled cells and gives an empty column no room", () => {
    expect(grid([["‹strong›a‹/›", "", "1"], ["bbb", "", "‹muted›22‹/›"]], [{}, {}, { align: "right" }])).toEqual([
      "‹strong›a‹/›      1",
      "bbb   ‹muted›22‹/›",
    ]);
  });
});

describe("lamp", () => {
  const moving = taggedLook(96, { motion: "full", tier: "256" });

  it("breathes between ember and lamp red without changing its glyph", () => {
    const frames = [0, 400, 800, 1200, 1600].map((ms) => lamp(ms, moving));
    expect(frames.every((frame) => frame.includes("●"))).toBe(true);
    expect(frames[0]).toBe(frames[4]);
    expect(frames[0]).not.toBe(frames[2]);
    expect(frames[2]).toBe(moving.theme.paint("lamp", "●"));
  });

  it("cycles glyphs where colour can't breathe, and holds still under reduced motion", () => {
    const plain = taggedLook(96, { motion: "full", glyphs: "ascii" });
    expect([0, 240, 480, 720, 960].map((ms) => untag(lamp(ms, plain)))).toEqual([".", "o", "O", "o", "."]);
    expect([0, 500, 900].map((ms) => lamp(ms, look))).toEqual(Array(3).fill("‹lamp›●‹/›"));
    expect(untag(lamp(300, ascii))).toBe("O");
  });

  it("shows the time once a second has gone by", () => {
    expect(lampLine("Starting the engine", 400, look)).toBe("‹lamp›●‹/› Starting the engine…");
    expect(lampLine("Starting the engine…", 2100, look)).toBe("‹lamp›●‹/› Starting the engine…  ‹muted›2.1 s‹/›");
    expect(elapsedText(72_400)).toBe("1 min 12 s");
  });
});

describe("progress", () => {
  it("draws a half-cell head and a faint track", () => {
    expect(progressBar(0.47, 10, look)).toBe("‹lamp›━━━━╸‹/›‹faint›─────‹/›");
    expect(untag(progressBar(0, 10, look))).toBe("──────────");
    expect(untag(progressBar(1, 10, look))).toBe("━━━━━━━━━━");
    expect(untag(progressBar(0.47, 10, ascii))).toBe("[====------]");
  });

  it("heats from ember at the tail to lamp red at the head", () => {
    const truecolour = lookOf({ ...TAGGED, tier: "truecolour" }, 96);
    const text = progressBar(0.3, 10, truecolour);
    expect(text.startsWith("\x1b[38;2;90;12;24m━")).toBe(true);
    expect(text).toContain("\x1b[38;2;243;34;63m━");
  });

  it("guesses the time left from the last five items, once two are done", () => {
    const items = [1000, 1000, 9000, 2000, 2000, 2000, 2000].map((ms, i) => ({ name: `p${i}`, state: "done" as const, ms }));
    expect(remainingMs({ label: "x", done: 1, total: 10, items: items.slice(0, 1) }, 0)).toBeNull();
    expect(remainingMs({ label: "x", done: 7, total: 10, items }, 0)).toBe(3 * 3400);
    expect(remainingMs({ label: "x", done: 4, total: 10, startedAt: 1000 }, 9000)).toBe(12_000);
    expect(remainingMs({ label: "x", done: 10, total: 10, items }, 0)).toBeNull();
    expect([3000, 38_000, 52_000, 70_000, 170_000].map(aboutText)).toEqual(["about 5 s", "about 40 s", "about 50 s", "about 1 min", "about 3 min"]);
  });

  it("writes a count with the time left, or bytes for a download, and never a percentage", () => {
    expect(progressCount({ label: "x", done: 37, total: 78, startedAt: 0 }, 37_000, look)).toBe("37 of 78‹faint› · ‹/›‹muted›about 40 s left‹/›");
    expect(progressCount({ label: "x", done: 1, total: 78 }, 0, look)).toBe("1 of 78");
    expect(progressCount({ label: "x", done: 0, total: 0, bytes: { done: 421_888, total: 1_153_434 } }, 0, look)).toBe("412 KB of 1.1 MB");
    expect(progressCount({ label: "x", done: 0, total: 0, bytes: { done: 421_888, total: null } }, 0, look)).toBe("412 KB");
  });
});

describe("error card and notices", () => {
  it("is a red mark and a red bar: what happened, what to know, the fix to run", () => {
    expect(errorCard({ message: '"expsure" isn\'t one of this photo\'s values.', hint: "Did you mean exposure?", fix: "set DSC_0412.NEF exposure=+0.7" }, look)).toEqual([
      '‹lamp›✕‹/› "expsure" isn\'t one of this photo\'s values.',
      "‹lamp›│‹/› ‹muted›Did you mean exposure?‹/›",
      "‹lamp›╰‹/› ‹strong›set‹/› DSC_0412.NEF ‹amber›exposure‹/›‹faint›=‹/›‹strong›+0.7‹/›",
    ]);
    expect(errorCard({ message: "Stopped." }, look)).toEqual(["‹lamp›✕‹/› Stopped."]);
  });

  it("wraps a long message under its bar", () => {
    const lines = errorCard({ message: "word ".repeat(30).trim() }, taggedLook(44));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => cells(line) <= 41)).toBe(true);
    expect(lines[1].startsWith("‹lamp›│‹/› ")).toBe(true);
  });

  it("marks a notice with ✓ or !", () => {
    expect(notice("ok", { message: "Copied settings from DSC_0412.NEF" }, look)).toEqual(["‹ok›✓‹/› Copied settings from DSC_0412.NEF"]);
    expect(notice("warn", { message: "exposure 7 is past its limit.", hint: "It was set to 5 EV." }, look)).toEqual([
      "‹amber›!‹/› exposure 7 is past its limit.",
      "  ‹muted›It was set to 5 EV.‹/›",
    ]);
  });
});

describe("valueDiff", () => {
  const changes = [
    { label: "Exposure", value: "+0.70 EV", info: EXPOSURE, before: 0.5, after: 0.7 },
    { label: "Highlights", value: "−40", info: HIGHLIGHTS, before: 0, after: -40 },
    { label: "Temperature", value: "5600 K", info: TEMPERATURE, before: 5150, after: 5600 },
    { label: "Exposure", value: "+5.00 EV", info: EXPOSURE, before: 4.8, after: 5, clamped: true },
    { label: "Contrast", value: "0", info: CONTRAST, before: 12, after: 0 },
  ];

  it("lines up before → after, with the bar and a note", () => {
    expect(valueDiff(changes, look, { cells: 21 }).map(untag)).toEqual([
      "exposure      +0.50 → +0.70 EV   ──────────○●─────────",
      "highlights        0 → −40        ──────●╺━━○──────────",
      "temperature    5150 → 5600 K     ─────○●──────────────",
      "exposure      +4.80 → +5.00 EV   ──────────┼━━━━━━━━○●  limit",
      "contrast        +12 → 0          ──────────●○─────────  default",
    ]);
  });

  it("mutes the old value, and the new one too when it lands on the default", () => {
    const lines = valueDiff(changes, look, { cells: 0 });
    expect(lines[0]).toBe("exposure      ‹muted›+0.50‹/› ‹faint›→‹/› ‹strong›+0.70‹/›‹muted› EV‹/›");
    expect(lines[3]).toBe("exposure      ‹muted›+4.80‹/› ‹faint›→‹/› ‹strong›+5.00‹/›‹muted› EV‹/›  ‹amber›limit‹/›");
    expect(lines[4]).toBe("contrast        ‹muted›+12‹/› ‹faint›→‹/› ‹muted›0‹/›         ‹muted›default‹/›");
  });

  it("counts the number along with the thumb during the tween, and ends on the static row", () => {
    const one = [changes[0]];
    expect(untag(valueDiff(one, look, { cells: 21, t: 0 })[0])).toBe("exposure   +0.50 → +0.50 EV   ──────────┼●─────────");
    expect(untag(valueDiff(one, look, { cells: 21, t: 0.5 })[0])).toBe("exposure   +0.50 → +0.60 EV   ──────────○●─────────");
    expect(valueDiff(one, look, { cells: 21, t: 1 })).toEqual(valueDiff(one, look, { cells: 21 }));
  });

  it("falls back to the label and text for a change with no values", () => {
    expect(valueDiff([{ label: "Paste settings", value: "" }, { label: "Preset", value: "Warm film" }], look, { cells: 21 })).toEqual([
      "Paste settings",
      "Preset         Warm film",
    ]);
  });

  it("has an ASCII form", () => {
    expect(untag(valueDiff([changes[1]], ascii, { cells: 15 })[0])).toBe("highlights   0 -> -40   [----o==.-------]");
  });
});

describe("card", () => {
  it("puts name, version and trust in the top edge, the category at the right", () => {
    expect(card({
      name: "Local Contrast", version: "1.0.0", trust: "verified", category: "tone",
      description: "Lifts fine detail without halos, in two modes.", command: "install local-contrast",
    }, 68, look).map(untag)).toEqual([
      "╭─ Local Contrast  1.0.0 ───────────────────────────── ✓ verified ─╮",
      "│ Lifts fine detail without halos, in two modes.              tone │",
      "│ install local-contrast                                           │",
      "╰──────────────────────────────────────────────────────────────────╯",
    ]);
  });

  it("holds a long description to two lines and loses the category when narrow", () => {
    const long = "A description that goes on and on, far past what a card can hold on the two lines it is given, and then keeps going.";
    const lines = card({ name: "Bad One", version: "0.1.0", trust: "banned", category: "detail", description: long }, 50, taggedLook(60));
    expect(lines.length).toBe(4);
    expect(lines.every((line) => cells(line) === 50)).toBe(true);
    expect(untag(lines[2])).toContain("…");
    expect(lines.join("\n")).not.toContain("detail");
    expect(lines[0]).toContain("‹pill.lamp› banned ‹/›");
  });
});

describe("timeline", () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime();
  const at = (day: number, hour: number, minute: number): number => new Date(2026, 10, day, hour, minute).getTime();
  const rows = [
    { index: 1, label: "Opened", timestamp: at(12, 16, 20), current: false },
    { index: 2, label: "Paste settings", timestamp: at(14, 13, 40), current: false },
    { index: 3, label: "Temperature", timestamp: at(14, 13, 58), current: false },
    { index: 4, label: "Exposure, Contrast", timestamp: at(14, 14, 2), current: true },
    { index: 5, label: "Detail", timestamp: at(14, 14, 10), current: false },
    { index: 6, label: "Local Contrast", timestamp: at(14, 14, 12), current: false },
  ];

  it("runs oldest first, grouped by day, with undone steps hollow under a dashed stem", () => {
    expect(timeline([...rows].reverse(), now, look).map(untag)).toEqual([
      "Nov 12",
      "●  1  Opened               16:20",
      "│",
      "Today",
      "●  2  Paste settings       13:40",
      "●  3  Temperature          13:58",
      "◉  4  Exposure, Contrast   14:02   you are here",
      "┆",
      "○  5  Detail               14:10",
      "○  6  Local Contrast       14:12",
    ]);
  });

  it("makes the current step amber and strong, and sets undone ones back", () => {
    const lines = timeline(rows, now, look);
    expect(lines[6]).toBe("‹amber›◉‹/›  4  ‹strong›Exposure, Contrast‹/›   ‹muted›14:02‹/›   ‹amber›you are here‹/›");
    expect(lines[7]).toBe("‹faint›┆‹/›");
    expect(lines[8]).toBe("‹faint›○‹/›  ‹muted›5‹/›  ‹muted›Detail‹/›               ‹muted›14:10‹/›");
  });

  it("names days the way people do", () => {
    expect(dayName(at(14, 0, 5), now)).toBe("Today");
    expect(dayName(at(13, 23, 55), now)).toBe("Yesterday");
    expect(dayName(at(2, 9, 0), now)).toBe("Nov 2");
    expect(dayName(new Date(2025, 11, 31, 9, 0).getTime(), now)).toBe("Dec 31, 2025");
    expect(dayName(0, now)).toBe("");
  });

  it("leaves out days and times it doesn't know", () => {
    expect(timeline([{ index: 0, label: "Opened", timestamp: 0, current: true }], now, look).map(untag)).toEqual(["◉  0  Opened   you are here"]);
  });
});
