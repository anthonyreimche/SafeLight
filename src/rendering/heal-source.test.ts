// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { findHealSource, healColorOffset, setHealSourceImage } from "./heal-source";
import type { HealSource } from "./heal-source";

type RGB = [number, number, number];

function image(w: number, h: number, colorAt: (x: number, y: number) => RGB): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const gray = (v: number) => (): RGB => [v, v, v];

// Nearest texel under a UV coordinate, matching the module's uv -> pixel mapping.
function pixelAt(data: Uint8ClampedArray, w: number, h: number, uvx: number, uvy: number): RGB {
  const x = Math.min(w - 1, Math.max(0, Math.round(uvx * w - 0.5)));
  const y = Math.min(h - 1, Math.max(0, Math.round(uvy * h - 0.5)));
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

const useImage = (w: number, h: number, colorAt: (x: number, y: number) => RGB) => {
  const data = image(w, h, colorAt);
  setHealSourceImage(data, w, h);
  return data;
};

// Cleared frame — both entry points bail out on a zero-size image.
const clearImage = () => setHealSourceImage(new Uint8ClampedArray(0), 0, 0);

// Flat mid-grey with one dark disc, in UV coordinates.
const blemishedFrame = (size: number, bx: number, by: number, br: number) =>
  useImage(size, size, (x, y) =>
    Math.hypot((x + 0.5) / size - bx, (y + 0.5) / size - by) < br
      ? [20, 20, 20]
      : [128, 128, 128],
  );

// Every case below expects a usable candidate; the null path has its own test.
function healSourceAt(dstX: number, dstY: number, radius: number, aspect: number): HealSource {
  const src = findHealSource(dstX, dstY, radius, aspect);
  if (!src) throw new Error("findHealSource found no candidate");
  return src;
}

describe("healColorOffset", () => {
  it("returns no shift when the frame is empty", () => {
    clearImage();
    expect(healColorOffset(0.5, 0.5, 0.3, 0.3, 0.05, 1)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("returns no shift when source and destination sit on the same tone", () => {
    useImage(64, 64, gray(128));
    const off = healColorOffset(0.7, 0.5, 0.3, 0.5, 0.05, 1);
    expect(off.r).toBeCloseTo(0, 6);
    expect(off.g).toBeCloseTo(0, 6);
    expect(off.b).toBeCloseTo(0, 6);
  });

  it("measures the surround difference as an encoded 0..1 offset", () => {
    // Split down the middle: the src ring sits entirely in the dark half, the
    // dst ring entirely in the light half, so the offset is the plain difference.
    useImage(64, 64, (x) => (x < 32 ? [60, 60, 60] : [150, 100, 40]));
    const off = healColorOffset(0.75, 0.5, 0.25, 0.5, 0.05, 1);
    expect(off.r).toBeCloseTo((150 - 60) / 255, 5);
    expect(off.g).toBeCloseTo((100 - 60) / 255, 5);
    expect(off.b).toBeCloseTo((40 - 60) / 255, 5);
  });

  it("clamps the offset to ±0.5 on a full black-to-white swing", () => {
    useImage(64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
    expect(healColorOffset(0.75, 0.5, 0.25, 0.5, 0.05, 1)).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    expect(healColorOffset(0.25, 0.5, 0.75, 0.5, 0.05, 1)).toEqual({
      r: -0.5,
      g: -0.5,
      b: -0.5,
    });
  });

  it("keeps the ring inside the frame for a spot on the edge", () => {
    useImage(64, 64, gray(200));
    const off = healColorOffset(0.0, 0.0, 0.5, 0.5, 0.2, 1);
    // Edge clamping repeats border texels, so a flat frame still measures flat.
    expect(off.r).toBeCloseTo(0, 6);
    expect(Number.isFinite(off.g)).toBe(true);
  });
});

describe("findHealSource", () => {
  it("returns null when the frame is empty", () => {
    clearImage();
    expect(findHealSource(0.5, 0.5, 0.05, 1)).toBeNull();
  });

  it("takes the nearest candidate at identity on a featureless frame", () => {
    useImage(64, 64, gray(128));
    // Every candidate scores a perfect zero, so the first one tried wins: the
    // closest search ring (2.6r) at angle 0.
    const src = healSourceAt(0.5, 0.5, 0.05, 1);
    expect(src.x).toBeCloseTo(0.5 + 0.05 * 2.6, 6);
    expect(src.y).toBeCloseTo(0.5, 6);
    expect(src.angle).toBe(0);
    expect(src.scale).toBe(1);
    expect(src.r).toBeCloseTo(0, 6);
    expect(src.g).toBeCloseTo(0, 6);
    expect(src.b).toBeCloseTo(0, 6);
  });

  it("compresses the search horizontally by the image aspect", () => {
    useImage(64, 64, gray(128));
    const src = healSourceAt(0.5, 0.5, 0.05, 2);
    expect(src.x).toBeCloseTo(0.5 + (0.05 * 2.6) / 2, 6);
    expect(src.y).toBeCloseTo(0.5, 6);
  });

  it("never picks a source that could overlap the spot it heals", () => {
    useImage(96, 96, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * 3 + y * 5) % 256]);
    for (const radius of [0.02, 0.05, 0.09]) {
      const src = healSourceAt(0.5, 0.5, radius, 1);
      // Candidate rings start at 2.6r, so a same-radius copy can never reach back
      // into the destination disc.
      expect(Math.hypot(src.x - 0.5, src.y - 0.5)).toBeGreaterThanOrEqual(2.6 * radius - 1e-9);
    }
  });

  it("keeps the source inside the frame margin for a corner spot", () => {
    useImage(96, 96, (x, y) => [(x * 11) % 256, (y * 5) % 256, 90]);
    for (const [dstX, dstY] of [
      [0.06, 0.06],
      [0.94, 0.06],
      [0.06, 0.94],
      [0.94, 0.94],
    ]) {
      const src = healSourceAt(dstX, dstY, 0.02, 1);
      expect(src.x).toBeGreaterThanOrEqual(0.02);
      expect(src.x).toBeLessThanOrEqual(0.98);
      expect(src.y).toBeGreaterThanOrEqual(0.02);
      expect(src.y).toBeLessThanOrEqual(0.98);
    }
  });

  it("returns a transform from the searched rotation and scale sets", () => {
    useImage(96, 96, (x, y) => [(x * 7 + y * 3) % 256, (y * 9) % 256, (x * 2) % 256]);
    const src = healSourceAt(0.5, 0.5, 0.06, 1);
    const angles = [-30, -20, -10, 0, 10, 20, 30].map((d) => (d * Math.PI) / 180);
    expect(angles.some((a) => Math.abs(a - src.angle) < 1e-12)).toBe(true);
    expect([0.85, 0.92, 1.0, 1.09, 1.18]).toContain(src.scale);
    for (const c of [src.r, src.g, src.b]) {
      expect(c).toBeGreaterThanOrEqual(-0.5);
      expect(c).toBeLessThanOrEqual(0.5);
    }
  });

  it("rejects a candidate whose interior carries its own blemish", () => {
    const R = 0.05;
    // A second blemish inside the nearest candidate's interior (offset half a
    // radius from its centre, small enough that no descriptor ring reaches it).
    // The nearest candidate is the one that wins on a flat frame, so only the
    // interior-outlier penalty can push the search past it.
    const bx = 0.5 + R * 2.6;
    const by = 0.5 + R * 0.5;
    const data = blemishedFrame(256, bx, by, R * 0.3);
    const src = healSourceAt(0.5, 0.5, R, 1);
    // Farther off than the interior probe radius (0.5r): the copied core is clean.
    expect(Math.hypot(src.x - bx, src.y - by)).toBeGreaterThan(R * 0.5);
    expect(pixelAt(data, 256, 256, src.x, src.y)).toEqual([128, 128, 128]);
  });

  it("misses a blemish that the destination's own outer ring reads as structure", () => {
    // Characterises current behaviour, not desired behaviour — see the report:
    // the destination's outer descriptor ring (1.85 * 1.4r = 2.59r) all but
    // coincides with the nearest candidate ring (2.6r), so a blemish sitting
    // there inflates dStruct, lifts featureThresh above the blemish's own
    // contrast, and the rejection never fires.
    const R = 0.05;
    const bx = 0.5 + R * 2.6;
    const data = blemishedFrame(256, bx, 0.5, R * 0.7);
    const src = healSourceAt(0.5, 0.5, R, 1);
    expect(src.x).toBeCloseTo(bx, 6);
    expect(src.y).toBeCloseTo(0.5, 6);
    expect(pixelAt(data, 256, 256, src.x, src.y)).toEqual([20, 20, 20]);
  });

  it("welcomes a continuation of the edge the spot already sits on", () => {
    // A hard horizontal edge through the whole frame: every candidate's interior
    // swings as much as the destination's surround, so nothing is penalised and
    // the nearest identity match still wins.
    useImage(128, 128, (_x, y) => (y < 64 ? [40, 40, 40] : [210, 210, 210]));
    const src = healSourceAt(0.5, 0.5, 0.05, 1);
    expect(src.angle).toBe(0);
    expect(src.scale).toBe(1);
    expect(Math.abs(src.y - 0.5)).toBeLessThan(1e-9);
  });
});
