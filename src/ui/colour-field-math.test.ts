// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { cssRgb, fromHex, hslToRgb, patchAverage, rgbToHsl, toHex } from "./colour-field-math";

describe("hslToRgb / rgbToHsl", () => {
  it("maps the primaries and greys", () => {
    expect(hslToRgb(0, 100, 50)).toEqual([1, 0, 0]);
    expect(hslToRgb(120, 100, 50)).toEqual([0, 1, 0]);
    expect(hslToRgb(240, 100, 50)).toEqual([0, 0, 1]);
    expect(hslToRgb(77, 0, 50)).toEqual([0.5, 0.5, 0.5]);
    expect(hslToRgb(200, 100, 100)).toEqual([1, 1, 1]);
  });

  it("round-trips", () => {
    for (const [h, s, l] of [
      [30, 80, 40],
      [210, 35, 65],
      [355, 100, 50],
    ]) {
      const back = rgbToHsl(hslToRgb(h, s, l));
      expect(back.hue).toBeCloseTo(h, 6);
      expect(back.saturation).toBeCloseTo(s, 6);
      expect(back.lightness).toBeCloseTo(l, 6);
    }
  });

  it("gives a grey hue 0 and saturation 0", () => {
    expect(rgbToHsl([0.25, 0.25, 0.25])).toEqual({ hue: 0, saturation: 0, lightness: 25 });
  });
});

describe("hex", () => {
  it("formats rounded 8-bit values", () => {
    expect(toHex([1, 0.5, 0])).toBe("#ff8000");
  });

  it("parses with or without #, and 3 digits", () => {
    expect(fromHex("#00ff00")).toEqual([0, 1, 0]);
    expect(fromHex("ff0000")).toEqual([1, 0, 0]);
    expect(fromHex("#fff")).toEqual([1, 1, 1]);
  });

  it("refuses anything else", () => {
    expect(fromHex("#12345")).toBeNull();
    expect(fromHex("green")).toBeNull();
    expect(fromHex("")).toBeNull();
  });
});

describe("cssRgb", () => {
  it("writes 8-bit rgb() clamped to the range", () => {
    expect(cssRgb([1, 0.5, -0.2])).toBe("rgb(255, 128, 0)");
  });
});

describe("patchAverage", () => {
  it("averages the 5×5 patch around a pixel, clipped to the frame", () => {
    const w = 3;
    const h = 3;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set(i === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    const rgb = patchAverage(data, w, h, 0, 0);
    // The corner's patch clips to the 3×3 frame: 1 red of 9.
    expect(rgb).not.toBeNull();
    expect(rgb![0]).toBeCloseTo(1 / 9, 6);
    expect(rgb![2]).toBeCloseTo(8 / 9, 6);
  });
});
