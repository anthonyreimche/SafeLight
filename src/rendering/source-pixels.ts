// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A small 8-bit sRGB copy of the open photo's source, for searches that run on
// the CPU in the window (Heal's source pick). The worker's develop renderer
// makes it whenever the source changes (keepSourcePixels) and the worker posts
// it up to the window, which keeps the latest here for extensions
// (api.develop.sourcePixels). No renderer writes here itself: the export,
// histogram and thumbnail renderers draw other photos than the one open.

import { halfToFloatTable } from "@/raw/half-float";

/** RGBA8 rows from the top. */
export interface SourcePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

let current: SourcePixels | null = null;
const listeners = new Set<(pixels: SourcePixels) => void>();

/** The open photo's source is now `data`; an empty image clears it. */
export function setSourcePixels(data: Uint8ClampedArray, width: number, height: number): void {
  current = width > 0 && height > 0 ? { data, width, height } : null;
  if (current) for (const listener of listeners) listener(current);
}

/** The open photo's source pixels, or null before its first frame. */
export const sourcePixels = (): SourcePixels | null => current;

/** Calls `listener` with each new image; returns the unsubscribe. */
export function onSourcePixels(listener: (pixels: SourcePixels) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// The sRGB curve rounded to 8 bits, headroom clipped to white and negatives to
// black: the definition the encoding table below is built from.
function srgb8(v: number): number {
  const c = Math.max(0, v);
  const enc = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(255, enc * 255));
}

// SRGB8_STEPS[k − 1] is the least linear value srgb8 takes to k or above, for
// k = 1..255, found by bisecting down to adjacent doubles so the table agrees
// with srgb8 everywhere, not just near enough.
const SRGB8_STEPS = (() => {
  const steps = new Float64Array(255);
  for (let k = 1; k <= 255; k++) {
    let lo = k === 1 ? 0 : steps[k - 2];
    let hi = 1;
    for (;;) {
      const mid = lo + (hi - lo) / 2;
      if (mid <= lo || mid >= hi) break;
      if (srgb8(mid) >= k) hi = mid;
      else lo = mid;
    }
    steps[k - 1] = hi;
  }
  return steps;
})();

// srgb8 by a binary search through the steps: a 1024-edge search image is 2
// million channels, and a pow() each cost several times the box average. Each
// comparison sets one bit of the code without a branch, since noisy pixels
// would mispredict half of them. NaN passes no step and encodes to 0, as the
// clamped store does.
export function encodeSrgb8(v: number): number {
  let k = 0;
  k += +(v >= SRGB8_STEPS[k + 127]) << 7;
  k += +(v >= SRGB8_STEPS[k + 63]) << 6;
  k += +(v >= SRGB8_STEPS[k + 31]) << 5;
  k += +(v >= SRGB8_STEPS[k + 15]) << 4;
  k += +(v >= SRGB8_STEPS[k + 7]) << 3;
  k += +(v >= SRGB8_STEPS[k + 3]) << 2;
  k += +(v >= SRGB8_STEPS[k + 1]) << 1;
  k += +(v >= SRGB8_STEPS[k]);
  return k;
}

// The search image for a scene-linear RGBA source: box-averaged to a long edge
// of maxEdge in linear light, then encoded to 8-bit sRGB (headroom clips to
// white, negatives to black). Encoding after the downscale keeps the encode to
// the small image, which matters on a main-thread renderer. A cached preview's
// half floats are read in place, as the values they hold.
export function sourcePixelsFromLinear(
  src: Float32Array | Uint16Array,
  W: number,
  H: number,
  maxEdge: number,
): { data: Uint8ClampedArray; w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const halves = src instanceof Uint16Array ? halfToFloatTable() : null;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * W + sx) * 4;
          if (halves) {
            r += halves[src[si]]; g += halves[src[si + 1]]; b += halves[src[si + 2]];
          } else {
            r += src[si]; g += src[si + 1]; b += src[si + 2];
          }
          n++;
        }
      }
      const di = (y * w + x) * 4;
      out[di] = encodeSrgb8(r / n);
      out[di + 1] = encodeSrgb8(g / n);
      out[di + 2] = encodeSrgb8(b / n);
      out[di + 3] = 255;
    }
  }
  return { data: out, w, h };
}
