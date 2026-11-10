import { describe, expect, it } from "vitest";
import { PROBE_PX, probeMean } from "./readback";

const identity = (c: number): number => c;

function patch(texel: (i: number) => [number, number, number]): Float32Array {
  const raw = new Float32Array(PROBE_PX * PROBE_PX * 4);
  for (let i = 0; i < PROBE_PX * PROBE_PX; i++) raw.set([...texel(i), 1], i * 4);
  return raw;
}

describe("probeMean", () => {
  it("averages every texel of a finite patch", () => {
    const raw = patch((i) => [i, 0.5, 2]);
    const [r, g, b] = probeMean(raw, identity)!;
    expect(r).toBeCloseTo(12, 6);
    expect(g).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(2, 6);
  });

  it("takes each channel through the linearizer before averaging", () => {
    const raw = patch(() => [2, 4, 6]);
    expect(probeMean(raw, (c) => c / 2)).toEqual([1, 2, 3]);
  });

  it("skips a texel with a NaN channel and averages the rest", () => {
    const raw = patch((i) => (i === 3 ? [NaN, 1, 1] : [i, 1, 1]));
    const [r, g, b] = probeMean(raw, identity)!;
    expect(r).toBeCloseTo((300 - 3) / 24, 6);
    expect(g).toBeCloseTo(1, 6);
    expect(b).toBeCloseTo(1, 6);
  });

  it("skips a texel with an infinite channel the same way", () => {
    const raw = patch((i) => (i === 0 ? [1, Infinity, 1] : [1, 2, 1]));
    expect(probeMean(raw, identity)).toEqual([1, 2, 1]);
  });

  it("skips a texel whose linearized value is not finite", () => {
    const raw = patch((i) => (i === 0 ? [-1, 1, 1] : [1, 1, 1]));
    expect(probeMean(raw, (c) => Math.sqrt(c))).toEqual([1, 1, 1]);
  });

  it("answers null when no texel is finite", () => {
    expect(probeMean(patch(() => [NaN, NaN, NaN]), identity)).toBeNull();
  });
});
