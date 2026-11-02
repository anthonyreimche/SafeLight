// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The 3x3 matrix helpers the colour code and the photo's geometry share.

import { describe, it, expect } from "vitest";
import { mat3Apply, mat3ColumnMajor, mat3Invert, type Mat3 } from "./transform";
import { REC709_TO_REC2020 } from "./stage-space";

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

describe("mat3Invert", () => {
  it("inverts a diagonal matrix", () => {
    const m: Mat3 = [2, 0, 0, 0, 3, 0, 0, 0, 4];
    const inv = mat3Invert(m);
    expect(inv[0]).toBeCloseTo(0.5, 12);
    expect(inv[4]).toBeCloseTo(1 / 3, 12);
    expect(inv[8]).toBeCloseTo(0.25, 12);
    expect(inv[1]).toBeCloseTo(0, 12);
    expect(inv[2]).toBeCloseTo(0, 12);
  });

  it("computes an inverse that gives identity when multiplied with the original", () => {
    // A well-conditioned 2D rotation scaled by 1.5
    const cos05 = Math.cos(0.5);
    const sin05 = Math.sin(0.5);
    const scale = 1.5;
    const m: Mat3 = [
      scale * cos05, scale * -sin05, 0,
      scale * sin05, scale * cos05, 0,
      0, 0, 1,
    ];
    const inv = mat3Invert(m);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += m[r * 3 + k] * inv[k * 3 + c];
        expect(sum).toBeCloseTo(r === c ? 1 : 0, 12);
      }
  });

  it("handles dense asymmetric matrices (all 9 entries non-zero)", () => {
    const m = REC709_TO_REC2020;
    const inv = mat3Invert(m);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += m[r * 3 + k] * inv[k * 3 + c];
        expect(sum).toBeCloseTo(r === c ? 1 : 0, 12);
      }
  });
});
