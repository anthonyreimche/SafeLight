// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { contentAwareFill } from "./content-aware-fill";

type RGB = [number, number, number];

function image(
  w: number,
  h: number,
  colorAt: (x: number, y: number) => RGB,
  alpha = 255,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = alpha;
    }
  }
  return data;
}

function rectHole(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const hole = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) hole[y * w + x] = 1;
  return hole;
}

const rgbAt = (data: Uint8ClampedArray, w: number, x: number, y: number): RGB => {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};

function holePixels(hole: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < hole.length; i++) if (hole[i]) out.push(i);
  return out;
}

describe("contentAwareFill", () => {
  it("returns an untouched copy when there is nothing to synthesise", () => {
    const W = 8;
    const H = 8;
    const src = image(W, H, (x, y) => [x * 8, y * 8, 40]);
    const out = contentAwareFill(src, W, H, new Uint8Array(W * H));
    expect(out).not.toBe(src);
    expect([...out]).toEqual([...src]);
  });

  it("returns an untouched copy when the whole frame is a hole (no known texture)", () => {
    const W = 8;
    const H = 8;
    const src = image(W, H, (x, y) => [x * 8, y * 8, 40]);
    const hole = new Uint8Array(W * H).fill(1);
    expect([...contentAwareFill(src, W, H, hole)]).toEqual([...src]);
  });

  it("does not mutate the caller's buffer", () => {
    const W = 24;
    const H = 24;
    const src = image(W, H, () => [120, 60, 30]);
    const before = [...src];
    contentAwareFill(src, W, H, rectHole(W, H, 10, 10, 13, 13));
    expect([...src]).toEqual(before);
  });

  it("replaces the hole with the surrounding tone and makes it opaque", () => {
    const W = 24;
    const H = 24;
    const hole = rectHole(W, H, 10, 10, 13, 13);
    const src = image(W, H, (x, y) => (hole[y * W + x] ? [0, 255, 0] : [120, 60, 30]), 0);
    const out = contentAwareFill(src, W, H, hole);
    for (const i of holePixels(hole)) {
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual([120, 60, 30]);
      expect(out[i * 4 + 3]).toBe(255);
    }
  });

  it("leaves known pixels — including their alpha — exactly as they were", () => {
    const W = 24;
    const H = 24;
    const hole = rectHole(W, H, 10, 10, 13, 13);
    const src = image(W, H, (x, y) => [(x * 9) % 256, (y * 11) % 256, (x + y) % 256], 128);
    const out = contentAwareFill(src, W, H, hole);
    for (let i = 0; i < W * H; i++) {
      if (hole[i]) continue;
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]]).toEqual([
        src[i * 4],
        src[i * 4 + 1],
        src[i * 4 + 2],
        src[i * 4 + 3],
      ]);
    }
  });

  it("is deterministic: the seeded PRNG makes identical calls byte-identical", () => {
    const W = 32;
    const H = 32;
    const hole = rectHole(W, H, 12, 12, 17, 17);
    const src = image(W, H, (x, y) => [(x * 13) % 256, (y * 7) % 256, (x * y) % 256]);
    expect([...contentAwareFill(src, W, H, hole)]).toEqual([
      ...contentAwareFill(src, W, H, hole),
    ]);
  });

  it("seeds the hole from the mean of the known pixels when no EM iteration runs", () => {
    const W = 20;
    const H = 20;
    const hole = rectHole(W, H, 8, 8, 11, 11);
    const src = image(W, H, (x, y) => (hole[y * W + x] ? [0, 255, 0] : [100, 100, 100]));
    const out = contentAwareFill(src, W, H, hole, { iters: 0 });
    // Diffusion alone: flood with the known mean, then relax — a flat surround
    // stays flat, so the seeded value is the surround itself.
    for (const i of holePixels(hole)) {
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual([100, 100, 100]);
    }
  });

  it("borrows texture from the region the hole sits in, not the frame average", () => {
    const W = 48;
    const H = 32;
    const RED: RGB = [200, 30, 30];
    const BLUE: RGB = [30, 30, 200];
    const hole = rectHole(W, H, 8, 14, 11, 17);
    const src = image(W, H, (x) => (x < 24 ? RED : BLUE));
    const out = contentAwareFill(src, W, H, hole);
    // The naive mean of the frame would be halfway to blue; real patch synthesis
    // pulls from the red half the hole is buried in.
    for (const i of holePixels(hole)) {
      const [r, g, b] = rgbAt(out, W, i % W, (i / W) | 0);
      expect(r).toBeGreaterThan(150);
      expect(g).toBeLessThan(80);
      expect(b).toBeLessThan(80);
    }
  });

  it("honours a smaller patch radius", () => {
    const W = 20;
    const H = 20;
    const hole = rectHole(W, H, 9, 9, 10, 10);
    const src = image(W, H, () => [77, 88, 99]);
    const out = contentAwareFill(src, W, H, hole, { patch: 1, iters: 2 });
    for (const i of holePixels(hole)) {
      expect(rgbAt(out, W, i % W, (i / W) | 0)).toEqual([77, 88, 99]);
    }
  });

  it("survives a frame smaller than the patch window", () => {
    const W = 4;
    const H = 4;
    const hole = rectHole(W, H, 1, 1, 2, 2);
    const src = image(W, H, (x, y) => (hole[y * W + x] ? [0, 255, 0] : [45, 45, 45]), 0);
    const out = contentAwareFill(src, W, H, hole);
    for (const i of holePixels(hole)) {
      expect(rgbAt(out, W, i % W, (i / W) | 0)).toEqual([45, 45, 45]);
      expect(out[i * 4 + 3]).toBe(255);
    }
  });

  it("fills a hole that runs to the frame border", () => {
    const W = 24;
    const H = 24;
    const hole = rectHole(W, H, 0, 0, 3, 3);
    const src = image(W, H, (x, y) => (hole[y * W + x] ? [0, 255, 0] : [64, 96, 128]));
    const out = contentAwareFill(src, W, H, hole);
    for (const i of holePixels(hole)) {
      expect(rgbAt(out, W, i % W, (i / W) | 0)).toEqual([64, 96, 128]);
    }
  });
});
