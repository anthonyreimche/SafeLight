// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeSrgb8,
  onSourcePixels,
  setSourcePixels,
  sourcePixels,
  sourcePixelsFromLinear,
} from "./source-pixels";

describe("encodeSrgb8", () => {
  // The reference: the sRGB curve rounded to 8 bits, headroom clipped to white
  // and negatives to black, stored as the search image stores it.
  const stored = new Uint8ClampedArray(1);
  const reference = (v: number) => {
    const c = Math.max(0, v);
    const enc = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    stored[0] = Math.round(Math.min(255, enc * 255));
    return stored[0];
  };
  // v moved by n representable doubles (v > 0).
  const bits = new Float64Array(1);
  const word = new BigInt64Array(bits.buffer);
  const ulps = (v: number, n: number) => {
    bits[0] = v;
    word[0] += BigInt(n);
    return bits[0];
  };

  it("encodes every linear value exactly as the sRGB curve rounds it", () => {
    const values = [0, -0, -1e-12, -0.05, -3, 0.0031308, 1, 1.0000001, 1.85, 12, 1e30, Infinity, -Infinity, NaN];
    for (let i = 0; i <= 200000; i++) values.push(i / 160000);
    // Either side of every step from k − 1 to k: the curve's inverse at k − ½,
    // then a few doubles and a few tiny fractions away.
    for (let k = 1; k <= 255; k++) {
      const e = (k - 0.5) / 255;
      const t = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
      for (let n = -8; n <= 8; n++) values.push(ulps(t, n));
      for (const f of [1e-12, 1e-9, 1e-6, 1e-3]) values.push(t * (1 - f), t * (1 + f));
    }
    const wrong = values.filter((v) => encodeSrgb8(v) !== reference(v));
    expect(wrong).toEqual([]);
  });
});

// The search image, built from a scene-linear RAW source: averaged down in
// linear light, then encoded to 8-bit sRGB.
describe("sourcePixelsFromLinear", () => {
  const rgba = (...px: number[][]) => new Float32Array(px.flat());

  it("averages in linear light before encoding", () => {
    // The mean of 0.2 and 0 is 0.1 linear, which encodes to 89.
    const { data, w, h } = sourcePixelsFromLinear(rgba([0.2, 0.2, 0.2, 1], [0, 0, 0, 1]), 2, 1, 1);
    expect([w, h]).toEqual([1, 1]);
    expect([...data]).toEqual([89, 89, 89, 255]);
  });

  it("encodes a source that already fits texel for texel", () => {
    const { data } = sourcePixelsFromLinear(rgba([0.18, 1, 0.001, 1]), 1, 1, 384);
    expect([...data]).toEqual([118, 255, 3, 255]);
  });

  it("clips headroom to white and negatives to black", () => {
    const { data } = sourcePixelsFromLinear(rgba([1.85, -0.05, 12, 1]), 1, 1, 384);
    expect([...data]).toEqual([255, 0, 255, 255]);
  });

  it("caps the long edge and keeps the RGBA8 layout", () => {
    const src = new Float32Array(1000 * 500 * 4).fill(0.5);
    const { data, w, h } = sourcePixelsFromLinear(src, 1000, 500, 384);
    expect([w, h]).toEqual([384, 192]);
    expect(data).toBeInstanceOf(Uint8ClampedArray);
    expect(data).toHaveLength(384 * 192 * 4);
    expect([...data.subarray(0, 4)]).toEqual([188, 188, 188, 255]);
  });
});

describe("the open photo's source pixels", () => {
  afterEach(() => setSourcePixels(new Uint8ClampedArray(0), 0, 0));

  it("hold the last image set, and none while it is empty", () => {
    const data = new Uint8ClampedArray([1, 2, 3, 255]);
    setSourcePixels(data, 1, 1);
    expect(sourcePixels()).toEqual({ data, width: 1, height: 1 });
    setSourcePixels(new Uint8ClampedArray(0), 0, 0);
    expect(sourcePixels()).toBeNull();
  });

  it("tell each listener of a new image until it stops listening", () => {
    const listener = vi.fn();
    const stop = onSourcePixels(listener);
    const data = new Uint8ClampedArray(4);
    setSourcePixels(data, 1, 1);
    expect(listener).toHaveBeenCalledWith({ data, width: 1, height: 1 });
    stop();
    setSourcePixels(data, 1, 1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
