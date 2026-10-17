// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The icon pipeline's pure parts: the master's drawing grid, and the BMP
// encoder the NSIS installer artwork goes through.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICO_SIZES, INSTALLER_SCALES, encodeBmp24, installerArtSize, viewBoxSize } from "./make-icon.cjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("viewBoxSize", () => {
  it("reads the side of a square viewBox", () => {
    expect(viewBoxSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">')).toBe(512);
    expect(viewBoxSize('<svg viewBox="0 0 1024.5 1024.5" width="16">')).toBe(1024.5);
  });

  it("rejects an icon that isn't drawn on a square", () => {
    expect(() => viewBoxSize('<svg viewBox="0 0 512 256">')).toThrow(/square/);
    expect(() => viewBoxSize('<svg width="512" height="512">')).toThrow(/viewBox/);
  });

  it("finds the master's grid", () => {
    const master = fs.readFileSync(path.join(ROOT, "public", "favicon.svg"), "utf8");
    expect(viewBoxSize(master)).toBe(512);
  });
});

describe("ICO_SIZES", () => {
  it("covers Windows' small, list, tile and jumbo sizes", () => {
    expect(ICO_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256]);
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
