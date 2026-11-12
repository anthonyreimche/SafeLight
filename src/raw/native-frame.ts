// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Detail gain maps cut from one full-resolution frame's luminance. Develop draws
// a size-capped, box-averaged copy of the frame (the base); zoomed in, the
// renderer multiplies its linear luminance by native / base so native detail
// returns without replacing colours. A map snaps outward to whole pixels and
// reports the rectangle it really covers: a caller mapping (uv - rect.xy) /
// rect.wh lands on the cut pixels exactly.

import { halfBits, halfToFloatTable } from "./half-float";

/** A decoded frame's linear luminance at full size: one half float per pixel, rows top-down. */
export interface NativeLuma {
  data: Uint16Array;
  width: number;
  height: number;
}

/** A rectangle in fractions of a frame: x and y from the top-left corner. */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A detail gain map: one half float per pixel, rows top-down, covering `rect` of the frame. */
export interface DetailGain {
  data: Uint16Array<ArrayBuffer>;
  width: number;
  height: number;
  rect: FrameRect;
}

/** Frames above this many pixels are not held (512 MB of halves). */
export const NATIVE_FRAME_MAX_PIXELS = 64_000_000;

/** The whole-pixel box of `frame` that `rect` covers, grown outward to pixel
 *  edges and clamped to the frame; null when it is empty or `rect` is not
 *  finite. */
export function windowBox(
  rect: FrameRect,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  const { x, y, w, h } = rect;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w <= 0 || h <= 0) return null;
  const x0 = Math.max(0, Math.floor(x * width));
  const y0 = Math.max(0, Math.floor(y * height));
  const x1 = Math.min(width, Math.ceil((x + w) * width));
  const y1 = Math.min(height, Math.ceil((y + h) * height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The size a window of `boxW` x `boxH` frame pixels is cut at for an output
 *  of `outW` x `outH` pixels: never larger than the box (no upsampling),
 *  scaled by one factor on both axes so the aspect holds, at least 1 x 1. An
 *  output size that is not positive and finite sets no limit on its axis. */
export function windowSize(
  boxW: number,
  boxH: number,
  outW: number,
  outH: number,
): { width: number; height: number } {
  const limit = (out: number, box: number) => (Number.isFinite(out) && out > 0 ? out / box : 1);
  const scale = Math.min(1, limit(outW, boxW), limit(outH, boxH));
  return {
    width: Math.max(1, Math.round(boxW * scale)),
    height: Math.max(1, Math.round(boxH * scale)),
  };
}

export const DETAIL_GAIN_MIN = 0.125;
export const DETAIL_GAIN_MAX = 8;

// Keeps the ratio finite where either luminance is 0.
const GAIN_EPSILON = 1e-4;

const fitsBase = (frame: NativeLuma, baseW: number, baseH: number): boolean =>
  frame.data.length === frame.width * frame.height &&
  Number.isInteger(baseW) &&
  Number.isInteger(baseH) &&
  baseW > 0 &&
  baseH > 0 &&
  baseW < frame.width &&
  baseH < frame.height;

// The mean luminance of the frame pixels base texels [i0, i1] x [j0, j1] are
// averaged from, row by row: the boxes downsampleFloatRGBA cuts.
function baseCells(
  frame: NativeLuma,
  baseW: number,
  baseH: number,
  i0: number,
  i1: number,
  j0: number,
  j1: number,
): Float32Array<ArrayBuffer> {
  const { data, width: W, height: H } = frame;
  const table = halfToFloatTable();
  const cellsW = i1 - i0 + 1;
  const cells = new Float32Array(cellsW * (j1 - j0 + 1));
  for (let j = j0; j <= j1; j++) {
    const y0 = Math.floor((j * H) / baseH);
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * H) / baseH));
    for (let i = i0; i <= i1; i++) {
      const x0 = Math.floor((i * W) / baseW);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * W) / baseW));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, s = y * W + x0; x < x1; x++, s++) sum += table[data[s]];
      }
      cells[(j - j0) * cellsW + (i - i0)] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return cells;
}

/** The luminance of a `baseW` x `baseH` box-averaged copy of `frame`, one value
 *  per base texel: what every cut of that frame against that base divides by,
 *  so a holder works it out once (cutDetailGain's `base`). Null for a frame no
 *  larger than the base. */
export function baseLuma(frame: NativeLuma, baseW: number, baseH: number): Float32Array<ArrayBuffer> | null {
  return fitsBase(frame, baseW, baseH) ? baseCells(frame, baseW, baseH, 0, baseW - 1, 0, baseH - 1) : null;
}

/** The gain map for the part of `frame` that `rect` covers, at most `outW` x `outH` pixels: each value is the frame's luminance there over the luminance a `baseW` x `baseH` box-averaged copy of the frame shows there under bilinear filtering. `base` is that copy's luminance when the caller holds it (baseLuma); without it the part the cut needs is worked out here. Null for an empty window or a frame no larger than its base. */
export function cutDetailGain(
  frame: NativeLuma,
  rect: FrameRect,
  outW: number,
  outH: number,
  baseW: number,
  baseH: number,
  base?: Float32Array,
): DetailGain | null {
  const { data, width: W, height: H } = frame;
  if (!fitsBase(frame, baseW, baseH)) return null;
  if (base && base.length !== baseW * baseH) return null;
  const box = windowBox(rect, W, H);
  if (!box) return null;
  const { width, height } = windowSize(box.w, box.h, outW, outH);
  const table = halfToFloatTable();

  // Per output column and row: the two base texels a linear tap at its centre
  // blends (clamped to the grid) and the weight of the second.
  const taps = (count: number, origin: number, span: number, whole: number, baseCount: number) => {
    const first = new Int32Array(count);
    const second = new Int32Array(count);
    const weight = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const f = ((origin + ((k + 0.5) * span) / count) / whole) * baseCount - 0.5;
      const i = Math.floor(f);
      first[k] = Math.min(baseCount - 1, Math.max(0, i));
      second[k] = Math.min(baseCount - 1, Math.max(0, i + 1));
      weight[k] = f - i;
    }
    return { first, second, weight };
  };
  const cols = taps(width, box.x, box.w, W, baseW);
  const rows = taps(height, box.y, box.h, H, baseH);

  const i0 = base ? 0 : cols.first[0];
  const j0 = base ? 0 : rows.first[0];
  const gridW = base ? baseW : cols.second[width - 1] - i0 + 1;
  const grid = base ?? baseCells(frame, baseW, baseH, i0, cols.second[width - 1], j0, rows.second[height - 1]);

  const out = new Uint16Array(width * height);
  const scaled = width !== box.w || height !== box.h;
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * box.h) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * box.h) / height));
    const rowA = (rows.first[y] - j0) * gridW - i0;
    const rowB = (rows.second[y] - j0) * gridW - i0;
    const wy = rows.weight[y];
    for (let x = 0; x < width; x++) {
      let numerator: number;
      if (scaled) {
        const sx0 = Math.floor((x * box.w) / width);
        const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * box.w) / width));
        let sum = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0, s = (box.y + sy) * W + box.x + sx0; sx < sx1; sx++, s++) sum += table[data[s]];
        }
        numerator = sum / ((sy1 - sy0) * (sx1 - sx0));
      } else {
        numerator = table[data[(box.y + y) * W + box.x + x]];
      }
      const a = cols.first[x];
      const b = cols.second[x];
      const wx = cols.weight[x];
      const top = grid[rowA + a] * (1 - wx) + grid[rowA + b] * wx;
      const bottom = grid[rowB + a] * (1 - wx) + grid[rowB + b] * wx;
      const gain = (numerator + GAIN_EPSILON) / (top * (1 - wy) + bottom * wy + GAIN_EPSILON);
      out[y * width + x] = halfBits(Math.min(DETAIL_GAIN_MAX, Math.max(DETAIL_GAIN_MIN, gain)));
    }
  }
  return { data: out, width, height, rect: { x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H } };
}
