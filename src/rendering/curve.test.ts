// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the tone-curve evaluator and the LUTs the renderer uploads from it.
// Run with `npm test`.

import { describe, it, expect } from "vitest";
import {
  buildCurveLUT,
  buildMaskCurveLUT,
  buildRGBCurveLUT,
  makeCurveEvaluator,
} from "./curve";
import { defaultToneCurves } from "@/catalog/types";
import type { CurvePoint, ToneCurves } from "@/catalog/types";

function curves(over: Partial<ToneCurves> = {}): ToneCurves {
  return { ...defaultToneCurves(), ...over };
}

// Evenly spaced inputs across the full domain, and the curve's answers to them.
const GRID = Array.from({ length: 201 }, (_, i) => i / 200);

function sample(f: (x: number) => number): number[] {
  return GRID.map(f);
}

describe("makeCurveEvaluator", () => {
  it("is the identity when given no points", () => {
    const f = makeCurveEvaluator([]);
    expect(f(0)).toBe(0);
    expect(f(0.37)).toBe(0.37);
    expect(f(1)).toBe(1);
  });

  it("is a clamped constant for a single point", () => {
    expect(makeCurveEvaluator([{ x: 0.2, y: 0.6 }])(0.9)).toBe(0.6);
    expect(makeCurveEvaluator([{ x: 0.2, y: 1.4 }])(0)).toBe(1);
    expect(makeCurveEvaluator([{ x: 0.2, y: -0.3 }])(1)).toBe(0);
  });

  it("reproduces the two-point identity ramp exactly", () => {
    const f = makeCurveEvaluator([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    for (const x of [0, 0.125, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(f(x)).toBeCloseTo(x, 12);
    }
  });

  it("interpolates through every control point", () => {
    const pts: CurvePoint[] = [
      { x: 0, y: 0.05 },
      { x: 0.25, y: 0.1 },
      { x: 0.5, y: 0.62 },
      { x: 0.8, y: 0.7 },
      { x: 1, y: 0.95 },
    ];
    const f = makeCurveEvaluator(pts);
    for (const p of pts) expect(f(p.x)).toBeCloseTo(p.y, 12);
  });

  it("holds the endpoint values outside the control-point range", () => {
    const f = makeCurveEvaluator([
      { x: 0.2, y: 0.3 },
      { x: 0.8, y: 0.9 },
    ]);
    expect(f(0)).toBeCloseTo(0.3, 12);
    expect(f(0.1)).toBeCloseTo(0.3, 12);
    expect(f(1)).toBeCloseTo(0.9, 12);
  });

  it("stays monotone and free of overshoot through a hard step", () => {
    // Fritsch–Carlson's whole point: a near-vertical segment must not make the
    // curve dip below the previous point or bulge past the next one.
    const f = makeCurveEvaluator([
      { x: 0, y: 0 },
      { x: 0.45, y: 0.1 },
      { x: 0.5, y: 0.9 },
      { x: 1, y: 1 },
    ]);
    const ys = sample(f);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1]);
    expect(Math.min(...ys)).toBeCloseTo(0, 12);
    expect(Math.max(...ys)).toBeCloseTo(1, 12);
  });

  it("clamps output into 0..1 for out-of-range control points", () => {
    const f = makeCurveEvaluator([
      { x: 0, y: -0.4 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1.6 },
    ]);
    for (const y of sample(f)) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
  });

  it("sorts its input, so point order does not matter", () => {
    const ordered: CurvePoint[] = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.5 },
      { x: 0.7, y: 0.6 },
      { x: 1, y: 1 },
    ];
    const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];
    const a = makeCurveEvaluator(ordered);
    const b = makeCurveEvaluator(shuffled);
    for (const x of GRID) expect(b(x)).toBe(a(x));
  });

  it("survives coincident x values without producing NaN", () => {
    const f = makeCurveEvaluator([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.3 },
      { x: 0.5, y: 0.7 },
      { x: 1, y: 1 },
    ]);
    for (const y of sample(f)) expect(Number.isFinite(y)).toBe(true);
  });
});

describe("buildCurveLUT", () => {
  it("maps the identity ramp to a 1:1 table", () => {
    const lut = buildCurveLUT([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(lut).toBeInstanceOf(Uint8Array);
    expect(lut).toHaveLength(256);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBe(i);
  });

  it("inverts a descending curve", () => {
    const lut = buildCurveLUT([
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBe(255 - i);
  });

  it("clips control points outside 0..1 to the byte range", () => {
    const lut = buildCurveLUT([
      { x: 0, y: -0.5 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 2 },
    ]);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
  });
});

describe("buildRGBCurveLUT", () => {
  it("is a pure identity when the base profile is excluded", () => {
    const lut = buildRGBCurveLUT(curves(), false);
    expect(lut).toHaveLength(256 * 4);
    for (let i = 0; i < 256; i++) {
      expect(lut[i * 4]).toBe(i);
      expect(lut[i * 4 + 1]).toBe(i);
      expect(lut[i * 4 + 2]).toBe(i);
      expect(lut[i * 4 + 3]).toBe(255);
    }
  });

  it("bakes the Adobe Color baseline in by default", () => {
    const lut = buildRGBCurveLUT(curves());
    // The baseline is anchored at both ends and sits below the diagonal in
    // between — that's what gives the render LR's deep blacks.
    expect(lut[0]).toBe(0);
    expect(lut[255 * 4]).toBe(255);
    let belowDiagonal = 0;
    for (let i = 1; i < 255; i++) {
      expect(lut[i * 4]).toBeLessThanOrEqual(i);
      expect(lut[i * 4]).toBeGreaterThanOrEqual(lut[(i - 1) * 4]);
      if (lut[i * 4] < i) belowDiagonal++;
    }
    expect(belowDiagonal).toBeGreaterThan(200);
    // Control point (0.5 → 0.42): mid-grey lands on 0.42 · 255 ≈ 107.
    expect(lut[128 * 4]).toBeGreaterThanOrEqual(106);
    expect(lut[128 * 4]).toBeLessThanOrEqual(108);
  });

  it("applies the master curve before the per-channel curve", () => {
    // master halves, red then maps 0..1 onto 0.5..1 — so red = 0.5 + 0.25·x.
    // The reverse order would give 0.25 + 0.25·x, which the endpoints separate.
    const lut = buildRGBCurveLUT(
      curves({
        rgb: [
          { x: 0, y: 0 },
          { x: 1, y: 0.5 },
        ],
        red: [
          { x: 0, y: 0.5 },
          { x: 1, y: 1 },
        ],
      }),
      false,
    );
    expect(lut[0]).toBe(128); // 0.5 · 255, rounded
    expect(lut[255 * 4]).toBe(191); // 0.75 · 255
    expect(lut[255 * 4 + 1]).toBe(128); // green sees the master curve only
    expect(lut[255 * 4 + 2]).toBe(128);
  });
});

describe("buildMaskCurveLUT", () => {
  it("composes without the Adobe baseline", () => {
    const lut = buildMaskCurveLUT(curves());
    for (let i = 0; i < 256; i++) {
      expect(lut[i * 4]).toBe(i);
      expect(lut[i * 4 + 3]).toBe(255);
    }
  });

  it("writes into a caller-supplied atlas at the given offset", () => {
    const atlas = new Uint8Array(256 * 4 * 2);
    const returned = buildMaskCurveLUT(
      curves({
        rgb: [
          { x: 0, y: 1 },
          { x: 1, y: 0 },
        ],
      }),
      atlas,
      256 * 4,
    );
    expect(returned).toBe(atlas);
    expect(atlas.subarray(0, 256 * 4).every((b) => b === 0)).toBe(true);
    expect(atlas[256 * 4]).toBe(255);
    expect(atlas[256 * 4 + 255 * 4]).toBe(0);
  });
});
