// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { HealPyramid, featureCrop, orientation } from "./heal-pyramid";

type RGB = [number, number, number];

function rgba(w: number, h: number, colorAt: (x: number, y: number) => RGB): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorAt(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return data;
}

describe("HealPyramid", () => {
  it("halves down to the last level whose long edge is at least 32", () => {
    const p = new HealPyramid(new Uint8ClampedArray(1024 * 683 * 4), 1024, 683);
    expect(p.widths).toEqual([1024, 512, 256, 128, 64, 32]);
    expect(p.heights).toEqual([683, 341, 170, 85, 42, 21]);
    expect(p.count).toBe(6);
  });

  it("keeps a source smaller than that as its only level", () => {
    expect(new HealPyramid(new Uint8ClampedArray(20 * 10 * 4), 20, 10).count).toBe(1);
  });

  it("serves level 0 straight from the RGBA source", () => {
    const data = rgba(40, 40, () => [1, 2, 3]);
    const lv = new HealPyramid(data, 40, 40).pixels(0);
    expect(lv.data).toBe(data);
    expect([lv.w, lv.h, lv.stride]).toEqual([40, 40, 4]);
  });

  it("box-averages each 2×2 block into the next level", () => {
    const p = new HealPyramid(rgba(64, 32, (x, y) => [x * 4, y * 8, 10]), 64, 32);
    const lv = p.pixels(1);
    expect([lv.w, lv.h, lv.stride]).toEqual([32, 16, 3]);
    // Pixel (3, 1) averages source x 6..7, y 2..3: R = mean(24, 28), G = mean(16, 24).
    const o = (1 * 32 + 3) * 3;
    expect([lv.data[o], lv.data[o + 1], lv.data[o + 2]]).toEqual([26, 20, 10]);
  });
});

describe("featureCrop", () => {
  const read = (m: Float32Array, c: { x0: number; y0: number; w: number }, x: number, y: number) =>
    m[(y - c.y0) * c.w + (x - c.x0)];

  it("converts to opponent colour", () => {
    const lv = new HealPyramid(rgba(40, 40, () => [200, 100, 50]), 40, 40).pixels(0);
    const c = featureCrop(lv, 10, 10, 12, 12);
    expect(c.L[0]).toBeCloseTo(350 / 3, 4);
    expect(c.A[0]).toBe(150);
    expect(c.B[0]).toBe(25);
    expect(c.gx[0]).toBe(0);
    expect(c.gy[0]).toBe(0);
  });

  it("finds the gradient across a vertical step edge", () => {
    const lv = new HealPyramid(rgba(40, 40, (x) => (x < 20 ? [0, 0, 0] : [80, 80, 80])), 40, 40).pixels(0);
    const c = featureCrop(lv, 0, 0, 39, 39);
    // The [1 2 1] smooth turns the step at 19|20 into 0, 20, 60, 80; central
    // differences peak either side of it.
    expect(read(c.gx, c, 19, 10)).toBeCloseTo(30, 5);
    expect(read(c.gx, c, 20, 10)).toBeCloseTo(30, 5);
    expect(read(c.gx, c, 5, 10)).toBe(0);
    expect(read(c.gy, c, 19, 10)).toBe(0);
  });

  it("matches a whole-frame computation inside a sub-crop", () => {
    const lv = new HealPyramid(
      rgba(50, 40, (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 23) % 256, (x * y) % 256]),
      50,
      40,
    ).pixels(0);
    const full = featureCrop(lv, 0, 0, 49, 39);
    const part = featureCrop(lv, 10, 5, 30, 25);
    expect([part.x0, part.y0, part.w, part.h]).toEqual([10, 5, 21, 21]);
    for (let y = 5; y <= 25; y++) {
      for (let x = 10; x <= 30; x++) {
        for (const k of ["L", "A", "B", "gx", "gy"] as const) {
          expect(read(part[k], part, x, y)).toBe(read(full[k], full, x, y));
        }
      }
    }
  });

  it("clamps the crop to the frame", () => {
    const lv = new HealPyramid(rgba(40, 40, () => [9, 9, 9]), 40, 40).pixels(0);
    const c = featureCrop(lv, -5, -5, 100, 100);
    expect([c.x0, c.y0, c.w, c.h]).toEqual([0, 0, 40, 40]);
  });
});

describe("orientation", () => {
  it("reads one straight edge as fully coherent", () => {
    expect(orientation(1, 0, 0)).toEqual({ theta: 0, coherence: 1 });
    const v = orientation(0, 0, 1);
    expect(v.theta).toBeCloseTo(Math.PI / 2, 12);
    expect(v.coherence).toBeCloseTo(1, 12);
  });

  it("reads directionless texture, or none, as incoherent", () => {
    expect(orientation(1, 0, 1).coherence).toBeCloseTo(0, 12);
    expect(orientation(0, 0, 0).coherence).toBe(0);
  });
});
