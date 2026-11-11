// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A cached develop preview is half floats. It uploads as its halves and builds
// its mip chain from them, and must hold exactly what converting it to floats
// first held, at every level.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHalf, halfToFloat32 } from "@/raw/half-float";
import { capFloatToEdge, capHalfToEdge, mipChain } from "./source-cache";

vi.mock("@/raw/half-float", { spy: true });

/** `n` RGBA texels of scene-linear values as a cache stores them: negatives,
 *  tiny values in the subnormal halves, highlight headroom and the half maximum. */
function cachedHalves(n: number, seed: number): Uint16Array {
  let s = seed;
  const random = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
  const floats = new Float32Array(n * 4).map(() => (random() - 0.2) * 2 ** (random() * 40 - 24));
  floats.set([0, -0, 2 ** -24, 65504, -65504, 1e-7].slice(0, floats.length));
  return encodeHalf(floats);
}

const bits = (data: Float32Array | Uint16Array) =>
  data instanceof Uint16Array ? [...data] : [...new Uint32Array(data.buffer, data.byteOffset, data.length)];

const SIZES: [number, number][] = [[1, 1], [1, 9], [9, 1], [7, 5], [8, 8], [13, 3], [16, 11], [33, 2]];

beforeEach(() => {
  vi.mocked(halfToFloat32).mockClear();
});

describe("mipChain", () => {
  it.each(SIZES)("builds a %i × %i cached source's levels as from its floats", (w, h) => {
    const halves = cachedHalves(w * h, w * 31 + h);
    const fromFloats = [...mipChain(halfToFloat32(halves), w, h)];
    vi.mocked(halfToFloat32).mockClear();
    const fromHalves = [...mipChain(halves, w, h)];

    expect(fromHalves.map((l) => [l.w, l.h])).toEqual(fromFloats.map((l) => [l.w, l.h]));
    expect(fromHalves[0].data).toBe(halves);
    for (let level = 1; level < fromFloats.length; level++) {
      expect(fromHalves[level].data).toBeInstanceOf(Float32Array);
      expect(bits(fromHalves[level].data)).toEqual(bits(fromFloats[level].data));
    }
    expect(halfToFloat32).not.toHaveBeenCalled();
  });

  it("ends at a 1 × 1 level", () => {
    const chain = [...mipChain(cachedHalves(12 * 5, 3), 12, 5)];
    expect(chain.map((l) => [l.w, l.h])).toEqual([[12, 5], [6, 2], [3, 1], [1, 1]]);
  });
});

describe("capHalfToEdge", () => {
  it("keeps the halves of a source that fits, unconverted", () => {
    const halves = cachedHalves(16 * 9, 5);
    const capped = capHalfToEdge(halves, 16, 9, 16);
    expect(capped).toEqual({ data: halves, width: 16, height: 9 });
    expect(capped.data).toBe(halves);
    expect(halfToFloat32).not.toHaveBeenCalled();
  });

  it("averages one that doesn't down as the floats it holds", () => {
    const halves = cachedHalves(37 * 23, 9);
    const want = capFloatToEdge(halfToFloat32(halves), 37, 23, 16);
    const got = capHalfToEdge(halves, 37, 23, 16);
    expect([got.width, got.height]).toEqual([want.width, want.height]);
    expect(got.data).toBeInstanceOf(Float32Array);
    expect(bits(got.data)).toEqual(bits(want.data));
  });

  it.each([[37, 23, 16], [23, 37, 16], [301, 199, 64], [64, 3, 10], [9, 9, 1], [1000, 7, 333]])(
    "averages a %i × %i source down to %i from its halves in place, bit for bit",
    (w, h, edge) => {
      const halves = cachedHalves(w * h, w * 131 + h * 7 + edge);
      const want = capFloatToEdge(halfToFloat32(halves), w, h, edge);
      vi.mocked(halfToFloat32).mockClear();

      const got = capHalfToEdge(halves, w, h, edge);

      expect(halfToFloat32).not.toHaveBeenCalled();
      expect([got.width, got.height]).toEqual([want.width, want.height]);
      expect(got.data).toBeInstanceOf(Float32Array);
      expect(bits(got.data)).toEqual(bits(want.data));
    },
  );
});
