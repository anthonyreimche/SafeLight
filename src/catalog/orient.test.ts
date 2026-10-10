// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { previewUprightRotation, rotateFloatRGBA } from "./orient";

// Landscape sensor dims and portrait (pre-uprighted) dims for the aspect gate.
const LAND = { w: 6000, h: 4000 };
const PORT = { w: 4000, h: 6000 };

describe("previewUprightRotation", () => {
  it("applies the full EXIF rotation to a sensor-native (landscape) preview", () => {
    // Orientation 6 → 90° upright. A still-landscape preview is sensor-native.
    expect(previewUprightRotation(LAND.w, LAND.h, 90, 6)).toBe(90);
    // Orientation 8 → 270°.
    expect(previewUprightRotation(LAND.w, LAND.h, 270, 8)).toBe(270);
  });

  it("leaves an already-uprighted (portrait) quarter-turn preview unrotated", () => {
    // The camera baked the rotation into the preview pixels already.
    expect(previewUprightRotation(PORT.w, PORT.h, 90, 6)).toBe(0);
    expect(previewUprightRotation(PORT.w, PORT.h, 270, 8)).toBe(0);
  });

  it("does nothing for an upright (orientation 1) landscape preview", () => {
    expect(previewUprightRotation(LAND.w, LAND.h, 0, 1)).toBe(0);
    expect(previewUprightRotation(LAND.w, LAND.h, 0, undefined)).toBe(0);
  });

  it("applies 180° regardless of aspect (can't be told apart by aspect)", () => {
    expect(previewUprightRotation(LAND.w, LAND.h, 180, 3)).toBe(180);
  });

  it("always applies the manual portion on top of the EXIF portion", () => {
    // photo.rotation 180 with EXIF orientation 6 (90°) → 90° manual turn.
    // Sensor-native preview: 90 (EXIF) + 90 (manual) = 180.
    expect(previewUprightRotation(LAND.w, LAND.h, 180, 6)).toBe(180);
    // Pre-uprighted preview: EXIF portion gated to 0, manual 90 still applies.
    expect(previewUprightRotation(PORT.w, PORT.h, 180, 6)).toBe(90);
  });
});

// Pixels are four distinct floats (one above 1, as in linear HDR data), so a
// swapped channel, a dropped alpha or a clamp shows up as a different value.
const A = [0.1, 0.2, 0.3, 0.4];
const B = [1.5, 0.6, 0.7, 0.25];
const buf = (...px: number[][]) => Float32Array.from(px.flat());

describe("rotateFloatRGBA", () => {
  it("returns the same buffer at 0 and 360 degrees", () => {
    const input = buf(A, B);
    const zero = rotateFloatRGBA(input, 2, 1, 0);
    expect(zero.data).toBe(input);
    expect([zero.width, zero.height]).toEqual([2, 1]);
    expect(rotateFloatRGBA(input, 2, 1, 360).data).toBe(input);
  });

  it("turns a 2x1 [A,B] row into the column [A;B] at 90 degrees", () => {
    const out = rotateFloatRGBA(buf(A, B), 2, 1, 90);
    expect([out.width, out.height]).toEqual([1, 2]);
    expect(out.data).toEqual(buf(A, B));
  });

  it("reverses a 2x1 [A,B] row at 180 degrees and leaves the input alone", () => {
    const input = buf(A, B);
    const out = rotateFloatRGBA(input, 2, 1, 180);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(out.data).toEqual(buf(B, A));
    expect(out.data).not.toBe(input);
    expect(input).toEqual(buf(A, B));
  });

  it("turns a 2x1 [A,B] row into the column [B;A] at 270 degrees", () => {
    const out = rotateFloatRGBA(buf(A, B), 2, 1, 270);
    expect([out.width, out.height]).toEqual([1, 2]);
    expect(out.data).toEqual(buf(B, A));
  });

  it("treats -90 as 270 and 450 as 90", () => {
    const back = rotateFloatRGBA(buf(A, B), 2, 1, -90);
    expect([back.width, back.height]).toEqual([1, 2]);
    expect(back.data).toEqual(buf(B, A));
    const wrapped = rotateFloatRGBA(buf(A, B), 2, 1, 450);
    expect([wrapped.width, wrapped.height]).toEqual([1, 2]);
    expect(wrapped.data).toEqual(buf(A, B));
  });

  describe("on a 3x2 image", () => {
    // a b c
    // d e f
    const p = (n: number) => [n, n + 0.25, n + 0.5, n + 0.75];
    const image = () => buf(p(1), p(2), p(3), p(4), p(5), p(6));

    it("rotates clockwise at 90 degrees into a 2x3 image", () => {
      const out = rotateFloatRGBA(image(), 3, 2, 90);
      expect([out.width, out.height]).toEqual([2, 3]);
      // d a
      // e b
      // f c
      expect(out.data).toEqual(buf(p(4), p(1), p(5), p(2), p(6), p(3)));
    });

    it("rotates half a turn at 180 degrees and keeps the 3x2 size", () => {
      const out = rotateFloatRGBA(image(), 3, 2, 180);
      expect([out.width, out.height]).toEqual([3, 2]);
      // f e d
      // c b a
      expect(out.data).toEqual(buf(p(6), p(5), p(4), p(3), p(2), p(1)));
    });

    it("rotates anticlockwise at 270 degrees into a 2x3 image", () => {
      const out = rotateFloatRGBA(image(), 3, 2, 270);
      expect([out.width, out.height]).toEqual([2, 3]);
      // c f
      // b e
      // a d
      expect(out.data).toEqual(buf(p(3), p(6), p(2), p(5), p(1), p(4)));
    });
  });
});
