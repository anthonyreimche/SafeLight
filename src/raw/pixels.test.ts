// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import {
  CFA,
  demosaicBilinear,
  developRawPlane,
  developRawPlaneFloat,
  normalizePlane,
  toRGBA8,
  toRGBAFloat,
  unpackSamples,
  type DevelopOptions,
} from "./pixels";

const RGGB: [number, number, number, number] = [CFA.R, CFA.G, CFA.G, CFA.B];
const BGGR: [number, number, number, number] = [CFA.B, CFA.G, CFA.G, CFA.R];

const bytes = (...b: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(b);

const rgbAt = (rgb: Float32Array, index: number): number[] =>
  Array.from(rgb.subarray(index * 3, index * 3 + 3));

// Samples come back as float32, so exact equality is off the table.
function expectRgb(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 6));
}

describe("unpackSamples", () => {
  it("copies 8-bit samples verbatim", () => {
    expect(Array.from(unpackSamples(bytes(0, 127, 255), 8, 3, true))).toEqual([0, 127, 255]);
  });

  it("honours file endianness for 16-bit samples", () => {
    const packed = bytes(0x34, 0x12, 0xff, 0x00);
    expect(Array.from(unpackSamples(packed, 16, 2, true))).toEqual([0x1234, 0x00ff]);
    expect(Array.from(unpackSamples(packed, 16, 2, false))).toEqual([0x3412, 0xff00]);
  });

  it("reads 12-bit samples MSB-first regardless of endianness", () => {
    // 0x12 0x34 0x56 packs as 0x123 followed by 0x456.
    const packed = bytes(0x12, 0x34, 0x56);
    expect(Array.from(unpackSamples(packed, 12, 2, true))).toEqual([0x123, 0x456]);
    expect(Array.from(unpackSamples(packed, 12, 2, false))).toEqual([0x123, 0x456]);
  });

  it("reads 14-bit samples MSB-first across byte boundaries", () => {
    // Bit stream 00000000000001 11111111111110, padded out to four bytes.
    expect(Array.from(unpackSamples(bytes(0x00, 0x07, 0xff, 0xe0), 14, 2, true))).toEqual([
      1, 0x3ffe,
    ]);
  });

  it("zero-fills when the packed stream is short", () => {
    expect(Array.from(unpackSamples(bytes(9), 8, 3, true))).toEqual([9, 0, 0]);
    expect(Array.from(unpackSamples(bytes(0x12, 0x34, 0x56), 16, 3, true))).toEqual([0x3412, 0, 0]);
    expect(Array.from(unpackSamples(bytes(0xff), 12, 2, true))).toEqual([0xff0, 0]);
  });

  it("respects a view's offset into a larger buffer", () => {
    const strip = bytes(0xaa, 0xbb, 0x12, 0x34).subarray(2);
    expect(Array.from(unpackSamples(strip, 16, 1, false))).toEqual([0x1234]);
  });
});

describe("normalizePlane", () => {
  it("maps black to 0 and white to 1", () => {
    const out = normalizePlane(new Uint16Array([512, 16383]), 512, 16383);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(1, 6);
  });

  it("clamps below black but preserves highlight headroom above white", () => {
    const out = normalizePlane(new Uint16Array([0, 300, 20000]), 512, 16383);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo((20000 - 512) / (16383 - 512), 5);
    expect(out[2]).toBeGreaterThan(1);
  });

  it("yields a flat plane when black and white collapse", () => {
    const out = normalizePlane(new Uint16Array([600, 900]), 512, 512);
    expect(Array.from(out)).toEqual([0, 0]);
  });
});

describe("demosaicBilinear", () => {
  // 2x2 RGGB: R at (0,0), G at (1,0) and (0,1), B at (1,1). With edge clamping
  // every site's 3x3 neighbourhood reaches all four samples, so the two missing
  // channels resolve to 0.4 (red), the mean of the greens, and 0.9 (blue).
  const plane = new Float32Array([0.4, 0.5, 0.7, 0.9]);

  it("keeps the native sample and averages the missing channels", () => {
    const rgb = demosaicBilinear(plane, 2, 2, RGGB);

    expectRgb(rgbAt(rgb, 0), [0.4, 0.6, 0.9]);
    expectRgb(rgbAt(rgb, 1), [0.4, 0.5, 0.9]);
    expectRgb(rgbAt(rgb, 2), [0.4, 0.7, 0.9]);
    expectRgb(rgbAt(rgb, 3), [0.4, 0.6, 0.9]);
  });

  it("is pattern-agnostic: BGGR swaps red and blue", () => {
    const rggb = demosaicBilinear(plane, 2, 2, RGGB);
    const bggr = demosaicBilinear(plane, 2, 2, BGGR);

    for (let i = 0; i < 4; i++) {
      const [r, g, b] = rgbAt(rggb, i);
      expectRgb(rgbAt(bggr, i), [b, g, r]);
    }
  });

  it("leaves a flat plane grey everywhere", () => {
    const flat = new Float32Array(4 * 4).fill(0.25);
    const rgb = demosaicBilinear(flat, 4, 4, RGGB);

    expect(rgb).toHaveLength(4 * 4 * 3);
    for (const v of rgb) expect(v).toBeCloseTo(0.25, 6);
  });
});

describe("toRGBA8", () => {
  it("encodes linear light to sRGB and forces opaque alpha", () => {
    const out = toRGBA8(new Float32Array([0, 0.5, 1]), 1, 1);
    // sRGB(0.5) = 0.73536, which quantises to 188.
    expect(Array.from(out)).toEqual([0, 188, 255, 255]);
  });

  it("uses the linear segment below the sRGB knee", () => {
    // 0.002 * 12.92 * 255 = 6.59.
    expect(toRGBA8(new Float32Array([0.002, 0, 0]), 1, 1)[0]).toBe(7);
  });

  it("clamps out-of-range linear values", () => {
    const out = toRGBA8(new Float32Array([-0.2, 1.5, 0]), 1, 1);
    expect(Array.from(out)).toEqual([0, 255, 0, 255]);
  });

  it("normalizes white balance against green so a grey gain is a no-op", () => {
    const rgb = new Float32Array([0.2, 0.4, 0.6]);
    expect(Array.from(toRGBA8(rgb, 1, 1, [2, 2, 2]))).toEqual(Array.from(toRGBA8(rgb, 1, 1)));
  });

  it("falls back to unit green gain when the green multiplier is zero", () => {
    const rgb = new Float32Array([0.25, 0.5, 0.75]);
    expect(Array.from(toRGBA8(rgb, 1, 1, [1, 0, 1]))).toEqual(Array.from(toRGBA8(rgb, 1, 1)));
  });
});

describe("toRGBAFloat", () => {
  it("applies green-normalized gains with no sRGB encode and no ceiling", () => {
    const out = toRGBAFloat(new Float32Array([0.3, 0.4, 0.25]), 1, 1, [4, 2, 3]);

    expectRgb(Array.from(out.subarray(0, 3)), [0.6, 0.4, 0.375]);
    expect(out[3]).toBe(1);
  });

  it("clamps negative samples to zero", () => {
    const out = toRGBAFloat(new Float32Array([-0.5, -0.1, 0.2]), 1, 1);
    expectRgb(Array.from(out.subarray(0, 3)), [0, 0, 0.2]);
  });

  it("lifts a clipped channel to the pixel's brightest channel", () => {
    // Green is clipped; the red gain pushes red past it, so green follows red.
    const out = toRGBAFloat(new Float32Array([0.6, 1, 0.3]), 1, 1, [2, 1, 1]);
    expectRgb(Array.from(out.subarray(0, 3)), [1.2, 1.2, 0.3]);
  });

  it("renders a fully blown pixel neutral rather than white-balance tinted", () => {
    const out = toRGBAFloat(new Float32Array([1, 1, 1]), 1, 1, [2, 1, 1.5]);
    expectRgb(Array.from(out.subarray(0, 3)), [2, 2, 2]);
  });

  it("leaves unclipped pixels untouched by the reconstruction", () => {
    const out = toRGBAFloat(new Float32Array([0.9, 0.8, 0.7]), 1, 1);
    expectRgb(Array.from(out.subarray(0, 3)), [0.9, 0.8, 0.7]);
  });
});

describe("developRawPlane", () => {
  const opts: DevelopOptions = { width: 2, height: 2, black: 0, white: 255, cfa: RGGB };

  it("runs normalize -> demosaic -> sRGB in one pass", () => {
    // Only the red site is lit, so no pixel picks up green or blue.
    const out = developRawPlane(new Uint16Array([255, 0, 0, 0]), opts);

    expect(out).toHaveLength(2 * 2 * 4);
    expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(out.subarray(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it("develops a saturated plane to opaque white", () => {
    const out = developRawPlane(new Uint16Array([255, 255, 255, 255]), opts);
    expect(Array.from(out)).toEqual(Array.from({ length: 16 }, () => 255));
  });

  it("subtracts the black level before demosaicing", () => {
    const out = developRawPlane(new Uint16Array([64, 64, 64, 64]), { ...opts, black: 64 });
    expect(Array.from(out)).toEqual(
      Array.from({ length: 16 }, (_, i) => (i % 4 === 3 ? 255 : 0)),
    );
  });
});

describe("developRawPlaneFloat", () => {
  const opts: DevelopOptions = { width: 2, height: 2, black: 0, white: 255, cfa: RGGB };

  it("returns linear RGBA with unit alpha", () => {
    const out = developRawPlaneFloat(new Uint16Array([255, 128, 128, 64]), opts);

    expect(out).toHaveLength(2 * 2 * 4);
    expect(out[0]).toBeCloseTo(1, 6);
    // Linear, so the green sample keeps its normalized value (no sRGB lift).
    expect(out[1]).toBeCloseTo(128 / 255, 5);
    expect(out[3]).toBe(1);
  });

  it("keeps headroom above 1.0 that the 8-bit path would clip", () => {
    const out = developRawPlaneFloat(new Uint16Array([255, 0, 0, 0]), { ...opts, white: 128 });

    expect(out[0]).toBeGreaterThan(1);
    expect(developRawPlane(new Uint16Array([255, 0, 0, 0]), { ...opts, white: 128 })[0]).toBe(255);
  });
});
