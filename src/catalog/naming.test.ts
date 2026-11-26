// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import type { ExifData } from "./types";
import { NAME_TOKENS, expandName, renderFolder, renderName, unknownTokens, type NameSubject } from "./naming";

function subject(filename: string, exif: ExifData = {}, extra: Partial<NameSubject> = {}): NameSubject {
  return { filename, exif, ...extra };
}

const shot = subject("DSC_0042.NEF", {
  cameraMake: "NIKON CORPORATION",
  cameraModel: "Z8",
  lens: "NIKKOR Z 24-70mm f/2.8 S",
  iso: 400,
  aperture: 2.8,
  shutterSpeed: "1/250",
  focalLength: 35,
  dateTimeOriginal: "2026:06:30 14:05:42",
});

describe("renderName", () => {
  it("fills tokens and counts the sequence from the batch index", () => {
    const options = { seqStart: 1, seqStep: 1, seqPad: 3 };
    expect(renderName("{date}_{model}_{seq}", shot, { ...options, index: 0 })).toBe("20260630_Z8_001");
    expect(renderName("{date}_{model}_{seq}", shot, { ...options, index: 1 })).toBe("20260630_Z8_002");
  });

  it("collapses the separators an empty token leaves", () => {
    expect(renderName("{date}_{model}_{seq}", subject("c.NEF", { cameraModel: "Z8" }), { index: 2 })).toBe("Z8_003");
  });

  it("falls back to dateCreated when the EXIF has no capture time", () => {
    const at = new Date(2025, 0, 2, 3, 4, 5).getTime();
    expect(renderName("{yyyy}-{mon}-{day}_{time}", subject("a.jpg", {}, { dateCreated: at }))).toBe("2025-01-02_030405");
  });

  it("names the original, its extension and its folder", () => {
    expect(renderName("{folder}-{name}.{ext}", subject("IMG_1.CR3", {}, { folderName: "100CANON" }))).toBe(
      "100CANON-IMG_1.CR3",
    );
  });

  it("letters the batch spreadsheet-style, in either case", () => {
    expect(renderName("{name}-{letter}", subject("a.jpg"), { index: 26 })).toBe("a-aa");
    expect(renderName("{LETTER}", subject("a.jpg"), { index: 1 })).toBe("B");
  });

  it("takes a width for the sequence", () => {
    expect(renderName("{seq:5}", shot, { index: 6, seqStart: 10, seqStep: 2 })).toBe("00022");
  });

  it("renders the camera fields filename-safe", () => {
    expect(renderName("{make} {lens} {iso} {fnum} {shutter} {focal}", shot)).toBe(
      "NIKON CORPORATION NIKKOR Z 24-70mm f_2.8 S 400 f2.8 1_250 35mm",
    );
  });

  it("reads subseconds as a decimal fraction, padded or cut to the width", () => {
    const burst = (subsec?: string) =>
      subject("a.NEF", { dateTimeOriginal: "2026:07:15 12:08:41", subSecTimeOriginal: subsec });
    const template = "{yyyy}{mon}{day}_{hour}{min}{sec}.{subsec}";
    expect(renderName(template, burst("541"))).toBe("20260715_120841.541");
    expect(renderName(template, burst("5"))).toBe("20260715_120841.500");
    expect(renderName(template, burst("541977"))).toBe("20260715_120841.541");
    expect(renderName("{sec}.{subsec:2}", burst("541"))).toBe("41.54");
    expect(renderName("{sec}.{subsec:6}", burst("541"))).toBe("41.541000");
    expect(renderName(template, burst(undefined))).toBe("20260715_120841");
  });

  it("matches token names regardless of case, but for the letters", () => {
    expect(renderName("{YYYY}{Mon}", shot)).toBe("202606");
  });

  it("drops unknown tokens and applies the case mode", () => {
    expect(renderName("{name}{nope}", shot, { caseMode: "lower" })).toBe("dsc_0042");
    expect(renderName("{name}", shot, { caseMode: "upper" })).toBe("DSC_0042");
  });

  it("keeps literal text but makes it filename-safe, trimming edge separators", () => {
    expect(renderName("_a:b?{name}. ", shot)).toBe("a_b_DSC_0042");
  });
});

describe("renderFolder", () => {
  it("renders each segment and joins them with slashes", () => {
    expect(renderFolder("{yyyy}/{yyyy}-{mon}-{day}", shot)).toBe("2026/2026-06-30");
  });

  it("drops segments that render empty and accepts either slash", () => {
    expect(renderFolder("Cards\\{lens}/{yyyy}//x", subject("a.jpg"))).toBe("Cards/x");
  });

  it("never lets a segment climb out", () => {
    expect(renderFolder("../{model}/./a", shot)).toBe("Z8/a");
  });

  it("is empty for a template that renders nothing", () => {
    expect(renderFolder("{yyyy}", subject("a.jpg"))).toBe("");
  });
});

describe("expandName", () => {
  it("expands tokens in free text without making them filename-safe", () => {
    expect(expandName("{yyyy}-{mon}-{day} {name} #{seq}", shot, { index: 4 })).toBe("2026-06-30 DSC_0042 #005");
    expect(expandName("{shutter}", shot)).toBe("1/250");
  });

  it("keeps unknown tokens and plain text as written", () => {
    expect(expandName("Score {home}-{away}", shot)).toBe("Score {home}-{away}");
    expect(expandName("Plain, text.", shot)).toBe("Plain, text.");
  });
});

describe("unknownTokens", () => {
  it("lists the tokens it doesn't know, once each", () => {
    expect(unknownTokens("{name}{subsec}{letter}{LETTER}{x}{x}{Y}")).toEqual(["x", "Y"]);
  });
});

describe("NAME_TOKENS", () => {
  it("offers every token it knows, each rendering", () => {
    const inserts = NAME_TOKENS.flatMap((g) => g.tokens.map((t) => t.insert));
    expect(inserts).toContain("{subsec}");
    expect(unknownTokens(inserts.join(""))).toEqual([]);
  });
});
