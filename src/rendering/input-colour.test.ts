// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { buildIccProfile } from "./color-space";
import { heifInputColour, iccInputColour, nclxInputColour, type InputColour } from "./input-colour";

const apply = (m: readonly number[], [r, g, b]: [number, number, number]) => [
  m[0] * r + m[1] * g + m[2] * b,
  m[3] * r + m[4] * g + m[5] * b,
  m[6] * r + m[7] * g + m[8] * b,
];

function expectClose(actual: readonly number[], expected: readonly number[], tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(tolerance));
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const P3_RED_IN_709 = [1.2249, -0.0421, -0.0196];
const REC2020_RED_IN_709 = [1.6605, -0.1246, -0.0182];
const nclx = (primaries: number, transfer: number) => ({ primaries, transfer, matrix: 0, fullRange: true });
const srgbDecode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

function expectSrgbCurves(colour: InputColour): void {
  for (const curve of colour.curves) {
    for (const v of [0, 0.02, 0.2, 0.5, 1]) expect(curve(v)).toBeCloseTo(srgbDecode(v), 6);
  }
}

describe("nclxInputColour", () => {
  it("reads Rec.709 primaries with the sRGB curve as is", () => {
    const colour = nclxInputColour(nclx(1, 13));
    expectClose(colour.toRec709, IDENTITY, 1e-9);
    expectSrgbCurves(colour);
    expect(colour.hdr).toBe(false);
  });

  it("maps Display P3 red outside Rec.709", () => {
    const { toRec709 } = nclxInputColour(nclx(12, 13));
    expectClose(apply(toRec709, [1, 0, 0]), P3_RED_IN_709, 1e-3);
    expectClose(apply(toRec709, [1, 1, 1]), [1, 1, 1], 1e-9);
  });

  it("maps Rec.2020 red", () => {
    expectClose(apply(nclxInputColour(nclx(9, 1)).toRec709, [1, 0, 0]), REC2020_RED_IN_709, 1e-3);
  });

  it("decodes each transfer it knows", () => {
    const at = (transfer: number, v: number) => nclxInputColour(nclx(1, transfer)).curves[0](v);
    for (const transfer of [1, 6, 14, 15]) {
      expect(at(transfer, 0.05)).toBeCloseTo(0.05 / 4.5, 9);
      expect(at(transfer, 0.5)).toBeCloseTo(Math.pow((0.5 + 0.099) / 1.099, 1 / 0.45), 9);
    }
    expect(at(4, 0.5)).toBeCloseTo(Math.pow(0.5, 2.2), 9);
    expect(at(5, 0.5)).toBeCloseTo(Math.pow(0.5, 2.8), 9);
    expect(at(8, 0.5)).toBe(0.5);
  });

  it("reads PQ and HLG codes as sRGB and says so", () => {
    for (const transfer of [16, 18]) {
      const colour = nclxInputColour(nclx(9, transfer));
      expect(colour.hdr).toBe(true);
      expectSrgbCurves(colour);
      expectClose(apply(colour.toRec709, [1, 0, 0]), REC2020_RED_IN_709, 1e-3);
    }
  });

  it("falls back to sRGB for codes it doesn't know", () => {
    const colour = nclxInputColour(nclx(2, 2));
    expect(colour.hdr).toBe(false);
    expectClose(colour.toRec709, IDENTITY, 1e-9);
    expectSrgbCurves(colour);
  });
});

describe("iccInputColour", () => {
  it("adapts a D50 matrix/TRC profile to Rec.709 D65", () => {
    const p3 = iccInputColour(buildIccProfile("display-p3"));
    expect(p3).not.toBeNull();
    expectClose(apply(p3!.toRec709, [1, 0, 0]), P3_RED_IN_709, 3e-3);
    expectClose(apply(p3!.toRec709, [1, 1, 1]), [1, 1, 1], 3e-3);
    expect(p3!.curves[1](0.5)).toBeCloseTo(srgbDecode(0.5), 3);

    const srgb = iccInputColour(buildIccProfile("srgb"));
    expectClose(srgb!.toRec709, IDENTITY, 3e-3);
  });

  it("refuses bytes that aren't an RGB matrix profile", () => {
    expect(iccInputColour(new Uint8Array(200))).toBeNull();
    expect(iccInputColour(buildIccProfile("srgb").slice(0, 140))).toBeNull();
  });
});

describe("heifInputColour", () => {
  it("prefers a readable ICC profile, keeps the NCLX HDR notice, defaults to sRGB", () => {
    const fromIcc = heifInputColour({ nclx: nclx(1, 13), icc: buildIccProfile("display-p3") });
    expectClose(apply(fromIcc.toRec709, [1, 0, 0]), P3_RED_IN_709, 3e-3);
    const fromNclx = heifInputColour({ nclx: nclx(12, 13), icc: new Uint8Array(10) });
    expectClose(apply(fromNclx.toRec709, [1, 0, 0]), P3_RED_IN_709, 1e-3);
    expect(heifInputColour({ nclx: nclx(9, 16), icc: null }).hdr).toBe(true);
    const none = heifInputColour({ nclx: null, icc: null });
    expectClose(none.toRec709, IDENTITY, 1e-9);
    expectSrgbCurves(none);
  });
});
