// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { baselineTone } from "./baseline-tone";

const toSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const stops = (x: number): number => Math.log2(baselineTone(x) / x);

/** Where a metered 18% grey card lands in raw full scale: cameras place it
 *  about three and a half stops below sensor clipping. */
const GREY_CARD = 0.09;

describe("baselineTone", () => {
  it("anchors black and white", () => {
    expect(baselineTone(0)).toBe(0);
    expect(baselineTone(1)).toBeCloseTo(1, 12);
  });

  // Targets are the median of what camera JPEG engines do to the same sensor
  // data, measured across makers on the sample library: a bare sRGB encode
  // leaves the card at display 0.33, cameras put it near 0.42.
  it("puts a metered grey card where a camera JPEG puts it", () => {
    expect(toSrgb(baselineTone(GREY_CARD))).toBeGreaterThan(0.40);
    expect(toSrgb(baselineTone(GREY_CARD))).toBeLessThan(0.45);
  });

  it("lifts 18% grey by about three quarters of a stop and mid-grey by a third", () => {
    expect(stops(0.18)).toBeGreaterThan(0.65);
    expect(stops(0.18)).toBeLessThan(0.9);
    expect(stops(0.5)).toBeGreaterThan(0.25);
    expect(stops(0.5)).toBeLessThan(0.5);
  });

  it("lets go of the highlights so bright surfaces keep their tone", () => {
    expect(stops(0.85)).toBeLessThan(0.12);
  });

  it("holds the shadows and crushes only the deepest, like a camera black point", () => {
    expect(Math.abs(stops(0.02))).toBeLessThan(0.2);
    expect(stops(0.01)).toBeGreaterThan(-0.6);
    expect(stops(0.01)).toBeLessThan(-0.1);
  });

  it("only ever brightens with more light", () => {
    let previous = 0;
    for (let i = 1; i <= 2000; i++) {
      const y = baselineTone(i / 2000);
      expect(y).toBeGreaterThan(previous);
      previous = y;
    }
  });

  it("passes highlight headroom above white through untouched", () => {
    // The recovery stage downstream needs the sensor's clipped-channel excess.
    expect(baselineTone(1.5)).toBeCloseTo(1.5, 12);
    expect(baselineTone(4)).toBeCloseTo(4, 12);
  });

  it("keeps its shape from black to white", () => {
    const pinned: [number, number][] = [
      [0.001, 0.000589638435340779],
      [0.01, 0.00766409281634631],
      [0.05, 0.0669422663243996],
      [0.18, 0.308539380864929],
      [0.5, 0.640004193311668],
      [0.9, 0.926848131761717],
    ];
    for (const [x, y] of pinned) expect(baselineTone(x)).toBeCloseTo(y, 12);
  });

  // A RAW decode carries colours outside the sRGB primaries as negative
  // channels; clipping them to black here would shift those colours' hue.
  it("carries channels below black through along its slope at black", () => {
    const slopeAtBlack = baselineTone(1e-9) / 1e-9;
    for (const x of [-1e-4, -0.01, -0.1, -0.5]) {
      expect(baselineTone(x)).toBeCloseTo(x * slopeAtBlack, 7);
    }
  });

  it("meets that continuation at black without a step or a kink", () => {
    const h = 1e-8;
    expect(baselineTone(-h)).toBeCloseTo(0, 6);
    const below = (baselineTone(0) - baselineTone(-h)) / h;
    const above = (baselineTone(h) - baselineTone(0)) / h;
    expect(below).toBeCloseTo(above, 5);
  });
});
