// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { encodeHalf, halfToFloat32 } from "./half-float";

const bitsOf = (v: number) => encodeHalf(new Float32Array([v]))[0];
const roundTrip = (values: number[]) =>
  halfToFloat32(encodeHalf(new Float32Array(values)));

// Log-spaced across the whole normal half range, plus each power of two's
// neighbours, so every exponent and both rounding directions are exercised.
function normalRange(): number[] {
  const out: number[] = [];
  for (let e = -14; e <= 15; e++) {
    for (let k = 0; k < 64; k++) {
      out.push(Math.fround(2 ** (e + k / 64)));
    }
  }
  out.push(Math.fround(2 ** -14), 65504);
  return out.filter((v) => v >= 2 ** -14 && v <= 65504);
}

describe("encodeHalf", () => {
  it("produces the IEEE 754 binary16 bit patterns", () => {
    expect(bitsOf(1)).toBe(0x3c00);
    expect(bitsOf(-2)).toBe(0xc000);
    expect(bitsOf(0.5)).toBe(0x3800);
    expect(bitsOf(65504)).toBe(0x7bff);
    expect(bitsOf(2 ** -24)).toBe(0x0001);
    expect(bitsOf(1 / 3)).toBe(0x3555);
    expect(bitsOf(0)).toBe(0x0000);
  });

  it("rounds a tie to the even mantissa", () => {
    // 1 + 2^-11 sits exactly between 0x3C00 and 0x3C01; 1 + 3·2^-11 between
    // 0x3C01 and 0x3C02.
    expect(bitsOf(1 + 2 ** -11)).toBe(0x3c00);
    expect(bitsOf(1 + 3 * 2 ** -11)).toBe(0x3c02);
  });

  it("encodes subnormals and rounds them to the nearest step", () => {
    expect(bitsOf(3 * 2 ** -24)).toBe(0x0003);
    expect(bitsOf(1023 * 2 ** -24)).toBe(0x03ff);
    expect(bitsOf(2.5 * 2 ** -24)).toBe(0x0002);
    expect(bitsOf(-(2 ** -24))).toBe(0x8001);
    // Just under the smallest normal rounds up into it.
    expect(bitsOf(1023.75 * 2 ** -24)).toBe(0x0400);
  });

  it("clamps out-of-range values to the largest finite half", () => {
    expect(bitsOf(1e6)).toBe(0x7bff);
    expect(bitsOf(-1e6)).toBe(0xfbff);
    expect(bitsOf(65520)).toBe(0x7bff);
    expect(bitsOf(Infinity)).toBe(0x7bff);
    expect(bitsOf(-Infinity)).toBe(0xfbff);
  });

  it("encodes NaN as zero", () => {
    expect(bitsOf(NaN)).toBe(0x0000);
  });
});

describe("halfToFloat32", () => {
  it("decodes the pinned bit patterns", () => {
    const bits = new Uint16Array([
      0x3c00, 0xc000, 0x3800, 0x7bff, 0xfbff, 0x0001, 0x0400, 0x0000,
    ]);
    expect([...halfToFloat32(bits)]).toEqual([
      1, -2, 0.5, 65504, -65504, 2 ** -24, 2 ** -14, 0,
    ]);
  });

  it("round-trips the normal range within half precision", () => {
    const values = normalRange();
    const back = roundTrip(values);
    values.forEach((v, i) => {
      expect(Math.abs(back[i] - v)).toBeLessThanOrEqual(2 ** -11 * v);
    });
  });

  it("round-trips negative values within half precision", () => {
    const values = normalRange().map((v) => -v);
    const back = roundTrip(values);
    values.forEach((v, i) => {
      expect(Math.abs(back[i] - v)).toBeLessThanOrEqual(2 ** -11 * Math.abs(v));
    });
  });

  it("keeps the sign and headroom a scene-linear RAW carries", () => {
    const back = roundTrip([-0.05, 1.5, 1.85, 12]);
    expect(back[0]).toBeCloseTo(-0.05, 4);
    expect(back[1]).toBe(1.5);
    expect(back[2]).toBeCloseTo(1.85, 3);
    expect(back[3]).toBe(12);
  });
});
