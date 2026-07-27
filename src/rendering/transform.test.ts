// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the geometry matrices behind Transform/straighten. The forward and
// inverse builders must stay exact inverses of each other: the shader samples
// through the inverse while every crop-constraint hit test walks the forward.
// Run with `npm test`.

import { describe, it, expect } from "vitest";
import {
  buildForwardTransform,
  buildInverseTransform,
  mat3Apply,
  mat3ColumnMajor,
  type Mat3,
} from "./transform";
import { DEFAULT_TRANSFORM } from "@/catalog/types";
import type { TransformParams } from "@/catalog/types";

function params(over: Partial<TransformParams> = {}): TransformParams {
  return { ...DEFAULT_TRANSFORM, ...over };
}

const UNIT: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0.5, 0.5],
  [0.2, 0.85],
];

describe("mat3Apply", () => {
  it("applies an affine map", () => {
    const m: Mat3 = [1, 0, 0.25, 0, 1, -0.5, 0, 0, 1];
    expect(mat3Apply(m, 0.5, 0.5)).toEqual({ x: 0.75, y: 0 });
  });

  it("divides through by w for a projective map", () => {
    const m: Mat3 = [1, 0, 0, 0, 1, 0, 0, 1, 1];
    expect(mat3Apply(m, 0.4, 1)).toEqual({ x: 0.2, y: 0.5 });
  });

  it("substitutes a tiny w rather than dividing by zero", () => {
    const m: Mat3 = [0, 0, 1, 0, 0, 1, 0, 1, 0];
    const p = mat3Apply(m, 0, 0);
    expect(p.x).toBe(1e6);
    expect(p.y).toBe(1e6);
  });
});

describe("mat3ColumnMajor", () => {
  it("transposes row-major storage into GL order", () => {
    const m: Mat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const gl = mat3ColumnMajor(m);
    expect(gl).toBeInstanceOf(Float32Array);
    expect(Array.from(gl)).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });
});

describe("buildForwardTransform / buildInverseTransform", () => {
  it("are the identity map with no adjustments", () => {
    const fwd = buildForwardTransform(0, params(), 1.5);
    const inv = buildInverseTransform(0, params(), 1.5);
    for (const [u, v] of UNIT) {
      expect(mat3Apply(fwd, u, v).x).toBeCloseTo(u, 12);
      expect(mat3Apply(fwd, u, v).y).toBeCloseTo(v, 12);
      expect(mat3Apply(inv, u, v).x).toBeCloseTo(u, 12);
      expect(mat3Apply(inv, u, v).y).toBeCloseTo(v, 12);
    }
  });

  it("invert each other with every slider engaged", () => {
    const t = params({
      perspectiveH: -35,
      perspectiveV: 60,
      aspect: 40,
      scale: 130,
      offsetX: 25,
      offsetY: -15,
      flipH: true,
      flipV: true,
    });
    const fwd = buildForwardTransform(7.5, t, 1.5);
    const inv = buildInverseTransform(7.5, t, 1.5);
    for (const [u, v] of UNIT) {
      const p = mat3Apply(fwd, u, v);
      const back = mat3Apply(inv, p.x, p.y);
      expect(back.x).toBeCloseTo(u, 10);
      expect(back.y).toBeCloseTo(v, 10);
    }
  });

  it("turns the frame a quarter turn at 90° straighten", () => {
    // Square image, so a quarter turn maps corners onto corners exactly.
    const fwd = buildForwardTransform(90, params(), 1);
    const corners: [[number, number], [number, number]][] = [
      [[1, 0], [0, 0]],
      [[1, 1], [1, 0]],
      [[0, 1], [1, 1]],
      [[0, 0], [0, 1]],
    ];
    for (const [[u, v], [x, y]] of corners) {
      const p = mat3Apply(fwd, u, v);
      expect(p.x).toBeCloseTo(x, 12);
      expect(p.y).toBeCloseTo(y, 12);
    }
  });

  it("mirrors about the frame centre for flipH / flipV", () => {
    const h = buildForwardTransform(0, params({ flipH: true }), 1.5);
    expect(mat3Apply(h, 0, 0.3).x).toBeCloseTo(1, 12);
    expect(mat3Apply(h, 0.25, 0.3).x).toBeCloseTo(0.75, 12);
    expect(mat3Apply(h, 0.25, 0.3).y).toBeCloseTo(0.3, 12);

    const v = buildForwardTransform(0, params({ flipV: true }), 1.5);
    expect(mat3Apply(v, 0.25, 0.2).y).toBeCloseTo(0.8, 12);
    expect(mat3Apply(v, 0.25, 0.2).x).toBeCloseTo(0.25, 12);
  });

  it("zooms about the centre: scale 300 doubles the frame", () => {
    // s = 2^((scale-100)/200), so 300 is a 2× zoom.
    const fwd = buildForwardTransform(0, params({ scale: 300 }), 1);
    expect(mat3Apply(fwd, 1, 0.5).x).toBeCloseTo(1.5, 12);
    expect(mat3Apply(fwd, 0.5, 0.5).x).toBeCloseTo(0.5, 12);

    const inv = buildInverseTransform(0, params({ scale: 300 }), 1);
    expect(mat3Apply(inv, 0.75, 0.5).x).toBeCloseTo(0.625, 12);
    expect(mat3Apply(inv, 0.5, 0.5).y).toBeCloseTo(0.5, 12);
  });

  it("pans by half a frame at offset 100, independent of aspect", () => {
    for (const aspect of [1, 2]) {
      const fwd = buildForwardTransform(0, params({ offsetX: 100 }), aspect);
      expect(mat3Apply(fwd, 0.5, 0.5).x).toBeCloseTo(1, 12);
    }
    const fwd = buildForwardTransform(0, params({ offsetY: -50 }), 1.5);
    expect(mat3Apply(fwd, 0.5, 0.5).y).toBeCloseTo(0.25, 12);
  });

  it("stretches horizontally for the aspect slider", () => {
    // as = 1.5^(aspect/100): the horizontal half-extent grows by 1.5.
    const fwd = buildForwardTransform(0, params({ aspect: 100 }), 1);
    expect(mat3Apply(fwd, 1, 0.5).x).toBeCloseTo(1.25, 12);
    expect(mat3Apply(fwd, 0.5, 1).y).toBeCloseTo(0.5 + 0.5 / 1.5, 12);
  });

  it("keystones the frame for a vertical perspective tilt", () => {
    // gv = (perspectiveV/100)·0.6 = 0.3, so w = 1 + 0.3·Y and the top edge
    // (Y = −0.5) widens by 1/0.85 while the bottom narrows to 1/1.15.
    const fwd = buildForwardTransform(0, params({ perspectiveV: 50 }), 1);
    const top = mat3Apply(fwd, 1, 0).x - mat3Apply(fwd, 0, 0).x;
    const bottom = mat3Apply(fwd, 1, 1).x - mat3Apply(fwd, 0, 1).x;
    expect(top).toBeCloseTo(1 / 0.85, 12);
    expect(bottom).toBeCloseTo(1 / 1.15, 12);
    expect(top).toBeGreaterThan(bottom);
  });
});
