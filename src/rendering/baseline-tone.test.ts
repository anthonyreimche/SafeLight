// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { baselineExposureFor, baselineRefit, baselineTone } from "./baseline-tone";

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

// Process version 2 and later keep baselineTone where it runs and correct its
// result with baselineRefit further down, after the decode stages and clip
// recovery. Version 1 keeps baselineTone alone.
describe("baselineRefit after baselineTone (process version 2 and later)", () => {
  const v3 = (x: number): number => baselineRefit(baselineTone(x));
  const v3Stops = (x: number): number => Math.log2(v3(x) / x);

  it("anchors black and white", () => {
    expect(baselineRefit(0)).toBe(0);
    expect(baselineRefit(1)).toBeCloseTo(1, 12);
  });

  // The median lift of camera JPEGs over the scene-linear decode at each scene
  // level, pooled over 235 sample RAWs (Fujifilm and Sigma left out), as
  // measured on 2026-10-25. Version 2's curve was 0.3 EV too bright in the deep
  // shadows and 0.15-0.2 EV too dark from 10% grey up.
  const CAMERA_LIFT: [number, number][] = [
    [0.007, -0.75], [0.014, -0.57], [0.028, -0.21], [0.057, 0.39], [0.098, 0.96],
    [0.147, 0.89], [0.22, 0.94], [0.329, 0.71], [0.49, 0.51], [0.714, 0.29],
  ];

  it("tracks the pooled camera curve from deep shadow to near white", () => {
    for (const [x, ev] of CAMERA_LIFT) expect(Math.abs(v3Stops(x) - ev)).toBeLessThan(0.15);
  });

  it("only ever brightens with more light", () => {
    let previous = 0;
    for (let i = 1; i <= 2000; i++) {
      const y = v3(i / 2000);
      expect(y).toBeGreaterThan(previous);
      previous = y;
    }
  });

  it("passes highlight headroom above white through untouched", () => {
    expect(baselineRefit(1.5)).toBeCloseTo(1.5, 12);
    expect(baselineRefit(4)).toBeCloseTo(4, 12);
  });

  it("keeps its shape from black to white", () => {
    const pinned: [number, number][] = [
      [0.001, 0.0005725170819229953],
      [0.01, 0.005950759684537949],
      [0.05, 0.06101178551324947],
      [0.18, 0.3510256633107162],
      [0.5, 0.7017960398169455],
      [0.9, 0.9453047082982979],
    ];
    for (const [x, y] of pinned) expect(v3(x)).toBeCloseTo(y, 12);
  });

  it("carries channels below black through along its slope at black", () => {
    // It bends hard just above black, so its slope there is read closer in.
    const slopeAtBlack = baselineRefit(1e-12) / 1e-12;
    for (const x of [-1e-4, -0.01, -0.1, -0.5]) {
      expect(baselineRefit(x)).toBeCloseTo(x * slopeAtBlack, 7);
    }
  });

  it("meets that continuation at black without a step or a kink", () => {
    const h = 1e-8;
    expect(baselineRefit(-h)).toBeCloseTo(0, 6);
    const below = (baselineRefit(0) - baselineRefit(-h)) / h;
    const above = (baselineRefit(h) - baselineRefit(0)) / h;
    expect(below).toBeCloseTo(above, 5);
  });
});

describe("baselineExposureFor", () => {
  // Fitted per maker on the same probe, as a gain after the refit curve. Only
  // makers with 15 or more sample files whose 90% bootstrap interval excludes
  // zero have one.
  it("gives Sony, Nikon, Pentax and Panasonic bodies their measured offsets", () => {
    expect(baselineExposureFor("SONY", "ILCE-7M3")).toBe(0.31);
    expect(baselineExposureFor("NIKON CORPORATION", "NIKON D850")).toBe(0.21);
    expect(baselineExposureFor("PENTAX Corporation", "PENTAX K-5")).toBe(-0.28);
    expect(baselineExposureFor("Panasonic", "DC-G9")).toBe(-0.25);
  });

  it("reads a Pentax body sold under Ricoh's name by its model", () => {
    expect(baselineExposureFor("RICOH IMAGING COMPANY, LTD.", "PENTAX K-1")).toBe(-0.28);
    expect(baselineExposureFor("RICOH IMAGING COMPANY, LTD.", "GR III")).toBe(0);
  });

  it("leaves every other maker, and a photo with no make, on the pooled curve", () => {
    for (const make of ["Canon", "OLYMPUS IMAGING CORP.", "FUJIFILM", "LEICA CAMERA AG", "SIGMA"]) {
      expect(baselineExposureFor(make, "")).toBe(0);
    }
    expect(baselineExposureFor(undefined, undefined)).toBe(0);
  });

  it("matches makes whatever their case", () => {
    expect(baselineExposureFor("sony", undefined)).toBe(0.31);
    expect(baselineExposureFor("Nikon", undefined)).toBe(0.21);
  });

  it("doesn't take a maker's name inside another word for the maker", () => {
    expect(baselineExposureFor("Sonyx Optics", undefined)).toBe(0);
  });
});
