// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The icon pipeline's pure parts: which drawing each .ico size comes from, and
// the BMP encoder the NSIS installer artwork goes through.

import { describe, expect, it } from "vitest";
import path from "node:path";
import { ICO_SIZES, INSTALLER_SCALES, encodeBmp24, iconSourceFor, installerArtSize } from "./make-icon.cjs";

const base = (size: number) => path.basename(iconSourceFor(size).file);

describe("iconSourceFor", () => {
  it("uses the pixel-fitted drawings below 48 px and the master above", () => {
    expect(ICO_SIZES.map((s) => [s, base(s)])).toEqual([
      [16, "safelight-icon-16.svg"],
      [24, "safelight-icon-32.svg"],
      [32, "safelight-icon-32.svg"],
      [48, "favicon.svg"],
      [64, "favicon.svg"],
      [128, "favicon.svg"],
      [256, "favicon.svg"],
    ]);
  });

  it("reports the grid each drawing is drawn on", () => {
    expect([16, 32, 256].map((s) => iconSourceFor(s).grid)).toEqual([16, 32, 1024]);
  });
});

describe("encodeBmp24", () => {
  // 2 x 2, rows top to bottom: red, green / blue, white.
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const bmp = encodeBmp24(rgb, 2, 2);

  it("writes a 24-bit uncompressed bottom-up header", () => {
    expect(bmp.toString("ascii", 0, 2)).toBe("BM");
    expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    expect(bmp.readUInt32LE(10)).toBe(54);
    expect(bmp.readInt32LE(18)).toBe(2);
    expect(bmp.readInt32LE(22)).toBe(2);
    expect(bmp.readUInt16LE(28)).toBe(24);
    expect(bmp.readUInt32LE(30)).toBe(0);
  });

  it("pads rows to 4 bytes and stores BGR from the bottom row up", () => {
    expect(bmp.length).toBe(54 + 8 * 2);
    expect([...bmp.subarray(54, 62)]).toEqual([255, 0, 0, 255, 255, 255, 0, 0]);
    expect([...bmp.subarray(62, 70)]).toEqual([0, 0, 255, 0, 255, 0, 0, 0]);
  });
});

describe("installer art sizes", () => {
  it("draws every common Windows scaling", () => {
    expect(INSTALLER_SCALES).toEqual([100, 125, 150, 175, 200, 250, 300]);
  });

  it("scales the 100 % canvas and rounds to whole pixels", () => {
    expect(INSTALLER_SCALES.map((s) => installerArtSize([164, 340], s))).toEqual([
      [164, 340],
      [205, 425],
      [246, 510],
      [287, 595],
      [328, 680],
      [410, 850],
      [492, 1020],
    ]);
    expect(installerArtSize([150, 57], 175)).toEqual([263, 100]);
  });
});
