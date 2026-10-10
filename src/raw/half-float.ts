// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// IEEE 754 binary16 ("half") conversion for the develop-preview cache. A
// scene-linear RAW carries highlight headroom above 1.0 and small negative
// components from the camera matrix; half keeps both at ~11 bits of relative
// precision in the same 2 bytes/channel as the old 16-bit sRGB cache. Written
// by hand because Float16Array isn't available in every runtime we target.

const HALF_MAX_BITS = 0x7bff;
const F32_INFINITY_BITS = 0x7f800000;
// 65504 (the largest finite half) as a float32 bit pattern: anything at or
// above it either is it or would round past it, so it clamps there.
const F32_HALF_MAX_BITS = 0x477fe000;
// 2^-14 (the smallest normal half) as a float32 bit pattern.
const F32_HALF_MIN_NORMAL_BITS = 0x38800000;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function halfBits(v: number): number {
  f32[0] = v;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const abs = bits & 0x7fffffff;
  if (abs > F32_INFINITY_BITS) return 0;
  if (abs >= F32_HALF_MAX_BITS) return sign | HALF_MAX_BITS;
  if (abs < F32_HALF_MIN_NORMAL_BITS) {
    // Subnormal: a whole number of 2^-24 steps. Scaling a float32 by a power
    // of two is exact in a double, so the tie test below is exact too.
    const steps = Math.abs(f32[0]) * 2 ** 24;
    let m = Math.floor(steps);
    const rest = steps - m;
    if (rest > 0.5 || (rest === 0.5 && (m & 1) === 1)) m++;
    return sign | m;
  }
  // Normal: rebias the exponent from 127 to 15 and round the 23-bit mantissa
  // to 10 bits, nearest-even (0xfff plus the kept LSB breaks ties upward
  // only when the kept mantissa is odd). A carry out of the mantissa bumps
  // the exponent, which is still the right result.
  const odd = (abs >>> 13) & 1;
  return sign | ((abs - ((127 - 15) << 23) + 0xfff + odd) >>> 13);
}

/** Float32 values to binary16 bit patterns, round-to-nearest-even. Values
 *  beyond ±65504 (and ±Infinity) clamp to ±65504; NaN becomes 0. */
export function encodeHalf(data: Float32Array): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = halfBits(data[i]);
  return out;
}

let halfToFloatLut: Float32Array | null = null;

function lut(): Float32Array {
  if (halfToFloatLut) return halfToFloatLut;
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) table[h] = sign * mant * 2 ** -24;
    else if (exp === 31) table[h] = mant ? NaN : sign * Infinity;
    else table[h] = sign * (1 + mant / 1024) * 2 ** (exp - 15);
  }
  halfToFloatLut = table;
  return table;
}

/** binary16 bit patterns back to Float32 values, through a 65536-entry
 *  table built on first use. */
export function halfToFloat32(bits: Uint16Array): Float32Array<ArrayBuffer> {
  const table = lut();
  const out = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = table[bits[i]];
  return out;
}
