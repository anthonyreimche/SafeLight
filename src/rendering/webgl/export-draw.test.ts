import { describe, expect, it } from "vitest";
import { quantise16 } from "./export-draw";

const reference = (v: number) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535));

describe("quantise16", () => {
  it("clips to the 16-bit range and maps NaN to 0", () => {
    expect(quantise16(Number.NaN)).toBe(0);
    expect(quantise16(-0)).toBe(0);
    expect(quantise16(-1e-30)).toBe(0);
    expect(quantise16(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(quantise16(1)).toBe(65535);
    expect(quantise16(1.5)).toBe(65535);
    expect(quantise16(Number.POSITIVE_INFINITY)).toBe(65535);
  });

  it("rounds half up like Math.round at every tie and one float32 step either side", () => {
    const f = new Float32Array(1);
    const misses: number[] = [];
    for (let code = 0; code < 65535; code++) {
      f[0] = (code + 0.5) / 65535;
      const tie = f[0];
      const bits = new Uint32Array(f.buffer);
      const at = bits[0];
      for (const b of [at - 1, at, at + 1]) {
        bits[0] = b;
        if (quantise16(f[0]) !== reference(f[0])) misses.push(f[0]);
      }
      f[0] = tie;
    }
    expect(misses).toEqual([]);
  });

  it("matches the rounding reference on random float32 samples", () => {
    const f = new Float32Array(200_000);
    let s = 12345;
    for (let i = 0; i < f.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      f[i] = (s / 0xffffffff) * 1.2 - 0.1;
    }
    expect(f.filter((v) => quantise16(v) !== reference(v))).toEqual(new Float32Array(0));
  });
});
