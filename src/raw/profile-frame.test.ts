// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A non-RAW photo's 8-bit codes become linear Rec.709 halves through the input
// profile resolver's transform: each channel's table, then the matrix, with
// nothing clamped. The frame is then averaged down to the edge the caller
// renders from and turned upright, as a RAW decode's is.

import { describe, expect, it } from "vitest";
import type { InputTransform } from "@/extensions/api/develop";
import { encodeHalf, halfToFloat32 } from "./half-float";
import { capFloatToEdge } from "@/rendering/webgl/source-cache";
import { rotateFloatRGBA } from "@/catalog/orient";
import { linearizeCodes } from "./profile-frame";

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function table(values: number[]): Float32Array {
  return Float32Array.from(values);
}

function transform(trc: number[][], toRec709 = IDENTITY): InputTransform {
  return { trc: [table(trc[0]), table(trc[1]), table(trc[2])], toRec709 };
}

/** sRGB's transfer, sampled at `n` even steps. */
function srgbTable(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
}

/** The spec's arithmetic for one code, done the long way. */
function curve(t: Float32Array, code: number): number {
  const n = t.length;
  const p = (code / 255) * (n - 1);
  const i = Math.min(n - 2, Math.floor(p));
  return t[i] + (t[i + 1] - t[i]) * (p - i);
}

/** Per pixel, the frame as floats: what the conversion caps and turns. */
function reference(codes: Uint8ClampedArray, w: number, h: number, t: InputTransform): Float32Array {
  const m = t.toRec709;
  const out = new Float32Array(w * h * 4);
  for (let o = 0; o < out.length; o += 4) {
    const v = [0, 1, 2].map((k) => curve(t.trc[k], codes[o + k]));
    for (let j = 0; j < 3; j++) out[o + j] = m[j * 3] * v[0] + m[j * 3 + 1] * v[1] + m[j * 3 + 2] * v[2];
    out[o + 3] = codes[o + 3] / 255;
  }
  return out;
}

function randomCodes(n: number, seed: number): Uint8ClampedArray {
  let s = seed;
  return Uint8ClampedArray.from({ length: n * 4 }, () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s % 256;
  });
}

const P3_TO_REC709 = [
  1.2249, -0.2247, 0,
  -0.0420, 1.0419, 0,
  -0.0197, -0.0786, 1.0979,
];

describe("linearizeCodes", () => {
  it("reads each code through its own channel's table, interpolated between samples", () => {
    const codes = Uint8ClampedArray.from([0, 128, 255, 255, 64, 64, 64, 128]);
    const t = transform([[0, 1], [0, 0.1, 1], [0, 0.25, 0.5, 2]]);

    const { data, width, height } = linearizeCodes(codes, 2, 1, t, 0);

    expect([width, height]).toEqual([2, 1]);
    const got = [...halfToFloat32(data)];
    const want = [0, curve(t.trc[1], 128), 2, 1, 64 / 255, curve(t.trc[1], 64), curve(t.trc[2], 64), 128 / 255];
    expect(got).toEqual([...halfToFloat32(encodeHalf(Float32Array.from(want)))]);
  });

  it("applies the matrix row by row and clamps nothing, so out-of-sRGB colour stays negative", () => {
    // Pure P3 green: no sRGB has it, so red and blue go below zero.
    const codes = Uint8ClampedArray.from([0, 255, 0, 255]);
    const t: InputTransform = { trc: [srgbTable(4096), srgbTable(4096), srgbTable(4096)], toRec709: P3_TO_REC709 };

    const [r, g, b, a] = halfToFloat32(linearizeCodes(codes, 1, 1, t, 0).data);

    expect(r).toBeCloseTo(-0.2247, 3);
    expect(g).toBeCloseTo(1.0419, 3);
    expect(b).toBeCloseTo(-0.0786, 3);
    expect(a).toBe(1);
  });

  it("keeps values above one and below zero that the tables themselves give", () => {
    const codes = Uint8ClampedArray.from([0, 255, 255, 255]);
    const t = transform([[-0.5, 0.5], [0, 8], [0, 1]]);

    expect([...halfToFloat32(linearizeCodes(codes, 1, 1, t, 0).data)]).toEqual([-0.5, 8, 1, 1]);
  });

  it("matches the per-pixel arithmetic at full size on random codes", () => {
    const codes = randomCodes(13 * 7, 3);
    const t: InputTransform = { trc: [srgbTable(256), srgbTable(17), srgbTable(2)], toRec709: P3_TO_REC709 };

    const got = linearizeCodes(codes, 13, 7, t, 0);

    expect([...got.data]).toEqual([...encodeHalf(reference(codes, 13, 7, t))]);
  });

  it.each([[37, 23, 16], [23, 37, 16], [64, 3, 10], [5, 5, 1]])(
    "averages a %i × %i frame down to a long edge of %i as the float cap does",
    (w, h, edge) => {
      const codes = randomCodes(w * h, w * 7 + h);
      const t: InputTransform = { trc: [srgbTable(1024), srgbTable(1024), srgbTable(1024)], toRec709: P3_TO_REC709 };
      const want = capFloatToEdge(reference(codes, w, h, t), w, h, edge);

      const got = linearizeCodes(codes, w, h, t, 0, edge);

      expect([got.width, got.height]).toEqual([want.width, want.height]);
      const floats = halfToFloat32(got.data);
      // Half precision: within one part in a thousand of each float.
      const off = [...want.data].filter((v, i) => Math.abs(floats[i] - v) > 1e-3 * Math.max(1, Math.abs(v)));
      expect(off).toEqual([]);
    },
  );

  it("leaves a frame that fits its edge at full size", () => {
    const codes = randomCodes(6 * 4, 1);
    const t = transform([[0, 1], [0, 1], [0, 1]]);

    expect(linearizeCodes(codes, 6, 4, t, 0, 6)).toEqual(linearizeCodes(codes, 6, 4, t, 0));
    expect(linearizeCodes(codes, 6, 4, t, 0, 6).width).toBe(6);
  });

  it.each([90, 180, 270, -90, 450])("turns the frame by %i° as a decode is turned", (turn) => {
    const codes = randomCodes(5 * 3, turn + 400);
    const t = transform([[0, 1], [0, 0.5, 1], [0, 1]]);
    const want = rotateFloatRGBA(reference(codes, 5, 3, t), 5, 3, turn);

    const got = linearizeCodes(codes, 5, 3, t, turn);

    expect([got.width, got.height]).toEqual([want.width, want.height]);
    expect([...got.data]).toEqual([...encodeHalf(want.data)]);
  });

  it("turns after it averages down", () => {
    const codes = randomCodes(30 * 20, 9);
    const t = transform([[0, 1], [0, 1], [0, 1]]);
    const capped = linearizeCodes(codes, 30, 20, t, 0, 12);
    const want = rotateFloatRGBA(halfToFloat32(capped.data), capped.width, capped.height, 90);

    const got = linearizeCodes(codes, 30, 20, t, 90, 12);

    expect([got.width, got.height]).toEqual([8, 12]);
    expect([...got.data]).toEqual([...encodeHalf(want.data)]);
  });

  // A pass's radius in source pixels scales by the decoded size (uSourceSize):
  // the frame before it was averaged down, turned as the frame is.
  it("reports the decoded size before the cap, turned", () => {
    const codes = randomCodes(30 * 20, 9);
    const t = transform([[0, 1], [0, 1], [0, 1]]);

    expect(linearizeCodes(codes, 30, 20, t, 90, 12)).toMatchObject({ fullWidth: 20, fullHeight: 30 });
    expect(linearizeCodes(codes, 30, 20, t, 0, 12)).toMatchObject({ fullWidth: 30, fullHeight: 20 });
    expect(linearizeCodes(codes, 30, 20, t, 180)).toMatchObject({ width: 30, fullWidth: 30, fullHeight: 20 });
  });
});
