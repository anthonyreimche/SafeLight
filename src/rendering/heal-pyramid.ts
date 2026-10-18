// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The heal search image as a pyramid of box-halved levels, and the features a
// source search reads from one level: opponent colour and the gradient of
// lightly smoothed luma. Levels are built on first use (the worker's copy of
// this module never searches) and features only over the crop a search can
// reach, so a pick costs time in proportion to the spot, not the photo.

// Levels stop before the long edge drops below this.
const MIN_LEVEL_EDGE = 32;

export interface LevelPixels {
  w: number;
  h: number;
  data: ArrayLike<number>; // 0..255 per channel
  stride: 3 | 4; // channels per pixel; level 0 is the RGBA source itself
}

export class HealPyramid {
  readonly widths: number[] = [];
  readonly heights: number[] = [];
  private readonly levels: LevelPixels[] = [];

  constructor(data: Uint8ClampedArray, w: number, h: number) {
    this.levels.push({ w, h, data, stride: 4 });
    this.widths.push(w);
    this.heights.push(h);
    for (;;) {
      const nw = Math.floor(this.widths[this.widths.length - 1] / 2);
      const nh = Math.floor(this.heights[this.heights.length - 1] / 2);
      if (Math.min(nw, nh) < 1 || Math.max(nw, nh) < MIN_LEVEL_EDGE) break;
      this.widths.push(nw);
      this.heights.push(nh);
    }
  }

  get count(): number {
    return this.heights.length;
  }

  // Level i's pixels, box-halved from the level above on first request.
  pixels(i: number): LevelPixels {
    while (this.levels.length <= i) {
      const src = this.levels[this.levels.length - 1];
      const w = this.widths[this.levels.length];
      const h = this.heights[this.levels.length];
      const out = new Float32Array(w * h * 3);
      const s = src.stride;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const top = (2 * y * src.w + 2 * x) * s;
          const bottom = top + src.w * s;
          const o = (y * w + x) * 3;
          for (let c = 0; c < 3; c++) {
            out[o + c] =
              (src.data[top + c] + src.data[top + s + c] + src.data[bottom + c] + src.data[bottom + s + c]) / 4;
          }
        }
      }
      this.levels.push({ w, h, data: out, stride: 3 });
    }
    return this.levels[i];
  }
}

export interface FeatureCrop {
  x0: number; // crop origin in level pixels
  y0: number;
  w: number;
  h: number;
  // Opponent colour (0..255 scale): L = (R+G+B)/3, A = R − B, B = (R+B)/2 − G.
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
  // Gradient of L after a 3×3 binomial smooth (central differences).
  gx: Float32Array;
  gy: Float32Array;
}

// Features over the pixels [x0, x1] × [y0, y1] of a level, clamped to its
// frame. Smoothing and gradients read two pixels past the crop (clamped to the
// frame), so every value inside matches a whole-frame computation.
export function featureCrop(lv: LevelPixels, x0: number, y0: number, x1: number, y1: number): FeatureCrop {
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const w = Math.min(lv.w - 1, Math.ceil(x1)) - cx0 + 1;
  const h = Math.min(lv.h - 1, Math.ceil(y1)) - cy0 + 1;
  const ex0 = Math.max(0, cx0 - 2);
  const ey0 = Math.max(0, cy0 - 2);
  const ew = Math.min(lv.w - 1, cx0 + w + 1) - ex0 + 1;
  const eh = Math.min(lv.h - 1, cy0 + h + 1) - ey0 + 1;

  const luma = new Float32Array(ew * eh);
  for (let y = 0; y < eh; y++) {
    for (let x = 0; x < ew; x++) {
      const si = ((ey0 + y) * lv.w + ex0 + x) * lv.stride;
      luma[y * ew + x] = (lv.data[si] + lv.data[si + 1] + lv.data[si + 2]) / 3;
    }
  }
  const across = new Float32Array(ew * eh);
  for (let y = 0; y < eh; y++) {
    const row = y * ew;
    for (let x = 0; x < ew; x++) {
      across[row + x] = (luma[row + Math.max(0, x - 1)] + 2 * luma[row + x] + luma[row + Math.min(ew - 1, x + 1)]) / 4;
    }
  }
  const smooth = new Float32Array(ew * eh);
  for (let y = 0; y < eh; y++) {
    const up = Math.max(0, y - 1) * ew;
    const row = y * ew;
    const down = Math.min(eh - 1, y + 1) * ew;
    for (let x = 0; x < ew; x++) smooth[row + x] = (across[up + x] + 2 * across[row + x] + across[down + x]) / 4;
  }

  const L = new Float32Array(w * h);
  const A = new Float32Array(w * h);
  const B = new Float32Array(w * h);
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ey = cy0 + y - ey0;
    for (let x = 0; x < w; x++) {
      const ex = cx0 + x - ex0;
      const o = y * w + x;
      const si = ((cy0 + y) * lv.w + cx0 + x) * lv.stride;
      const r = lv.data[si];
      const g = lv.data[si + 1];
      const b = lv.data[si + 2];
      L[o] = (r + g + b) / 3;
      A[o] = r - b;
      B[o] = (r + b) / 2 - g;
      gx[o] = (smooth[ey * ew + Math.min(ew - 1, ex + 1)] - smooth[ey * ew + Math.max(0, ex - 1)]) / 2;
      gy[o] = (smooth[Math.min(eh - 1, ey + 1) * ew + ex] - smooth[Math.max(0, ey - 1) * ew + ex]) / 2;
    }
  }
  return { x0: cx0, y0: cy0, w, h, L, A, B, gx, gy };
}

// Dominant gradient orientation (radians, mod π) and its coherence — 0 for
// directionless texture, 1 for one straight edge — from structure-tensor sums.
export function orientation(jxx: number, jxy: number, jyy: number): { theta: number; coherence: number } {
  const trace = jxx + jyy;
  if (trace <= 1e-9) return { theta: 0, coherence: 0 };
  return {
    theta: 0.5 * Math.atan2(2 * jxy, jxx - jyy),
    coherence: Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy) / trace,
  };
}
