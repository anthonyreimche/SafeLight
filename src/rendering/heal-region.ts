// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The pixels a heal or clone spot touches, on one level of the heal search
// image. The interior is the blemish it replaces; copied is every pixel its
// source supplies (the interior plus the feather the patch fades out over);
// the band is the original pixels around the interior, which the patch is
// blended over or meets at the seam. The source search compares bands, checks
// what would replace the interior, and keeps every copied pixel off the
// blemish.

import type { BrushDab, RetouchSpot } from "@/catalog/types";

// What a spot covers, in source UV with lengths in image-height units: a
// circle whose feather (0..1) fades out beyond its radius, as applyRetouch
// draws it, or a brush stroke's dabs in paint order.
export type HealRegion =
  | { kind: "circle"; x: number; y: number; radius: number; feather: number }
  | { kind: "brush"; dabs: BrushDab[] };

// A brush pixel covered at least this much is blemish; any coverage is copied.
const BRUSH_INTERIOR = 0.5;
// Narrowest seam band in level pixels, so a dust spot still has surroundings.
const MIN_BAND_PX = 3;
// Band and interior are thinned to about this many points.
const MAX_BAND_POINTS = 256;
const MAX_INTERIOR_POINTS = 128;
// Level choice: the band at most this wide, and the region able to clear
// itself within this many pixels (which bounds the search window).
const MAX_BAND_PX = 12;
const MAX_ESCAPE_PX = 96;
// A stroke's escape is measured across this many directions, 22.5° apart, so
// one of them is within 11.25° of square to a straight stroke at any slant.
const ESCAPE_DIRECTIONS = 8;

const OUTSIDE = 0;
const COPIED = 1;
const INTERIOR = 2;

export interface Bounds {
  minDx: number;
  maxDx: number;
  minDy: number;
  maxDy: number;
}

// Pixels as horizontal runs, row by row (level pixels): row y's runs are the
// inclusive [first, last] x pairs in xs from start[y − y0] up to
// start[y − y0 + 1], left to right.
export interface RowRuns {
  y0: number;
  h: number;
  start: Int32Array; // h + 1 offsets into xs
  xs: Int32Array;
}

export interface RegionRaster {
  ax: number; // anchor in level pixels (pixel centres at integers)
  ay: number;
  bandPx: number; // seam band width
  interior: Int32Array; // x, y pairs, thinned
  band: Int32Array; // x, y pairs, thinned
  bandWeight: Float32Array; // per band point: 1 at the blemish's edge, falling outward
  copied: Int32Array; // x, y pairs, every copied pixel
  // The same copied pixels, and every interior pixel, as row runs: a whole-pixel
  // move lands copied pixels on the blemish exactly when shifted runs meet.
  copiedRuns: RowRuns;
  interiorRuns: RowRuns;
  // Offsets from the anchor bounding every copied and band pixel, every copied
  // pixel, and every interior pixel.
  bounds: Bounds;
  copiedBounds: Bounds;
  interiorBounds: Bounds;
  reach: number; // farthest copied or band pixel from the anchor
  copiedReach: number;
  interiorReach: number;
  // Distance in level pixels from the pixel nearest (x, y) to the nearest
  // interior pixel, 0 on the blemish. Pixels off the rasterised grid are at
  // least its margin away and report that.
  distToInterior(x: number, y: number): number;
}

export function spotRegion(s: RetouchSpot): HealRegion {
  return s.shape === "brush" && s.dabs && s.dabs.length > 0
    ? { kind: "brush", dabs: s.dabs }
    : { kind: "circle", x: s.dstX, y: s.dstY, radius: s.radius, feather: s.feather / 100 };
}

const paintDabs = (dabs: BrushDab[]) => dabs.filter((d) => !d.erase);

// The point rotation and scale act about, and that a found source is reported
// for: the circle's centre, or the mean of a stroke's paint dabs (of all its
// dabs when it has no paint, so the overlay's fallback offset stays finite).
export function regionAnchor(region: HealRegion): { x: number; y: number } {
  if (region.kind === "circle") return { x: region.x, y: region.y };
  const painted = paintDabs(region.dabs);
  const paint = painted.length > 0 ? painted : region.dabs;
  let sx = 0;
  let sy = 0;
  for (const d of paint) {
    sx += d.x;
    sy += d.y;
  }
  return { x: sx / paint.length, y: sy / paint.length };
}

// Seam band width in image-height units: the radius, or the widest paint dab.
export function regionBandWidth(region: HealRegion): number {
  if (region.kind === "circle") return region.radius;
  let widest = 0;
  for (const d of paintDabs(region.dabs)) widest = Math.max(widest, d.radius);
  return widest;
}

// The shortest move, in image-height units, that surely carries the copied
// pixels clear of themselves: their narrowest width over ESCAPE_DIRECTIONS
// directions (paint dabs' centres projected, ± their radius; x scaled by the
// aspect). A bounding box's narrower side would be about the whole length of a
// slanted stroke, and pick a level too coarse to see it.
export function regionEscape(region: HealRegion, aspect: number): number {
  if (region.kind === "circle") return 2 * region.radius * (1 + region.feather);
  const paint = paintDabs(region.dabs);
  if (paint.length === 0) return 0;
  let escape = Infinity;
  for (let i = 0; i < ESCAPE_DIRECTIONS; i++) {
    const a = (i * Math.PI) / ESCAPE_DIRECTIONS;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of paint) {
      const p = d.x * aspect * cos + d.y * sin;
      lo = Math.min(lo, p - d.radius);
      hi = Math.max(hi, p + d.radius);
    }
    escape = Math.min(escape, hi - lo);
  }
  return escape;
}

// The finest level on which the band and the escape both fit; the coarsest
// when none does.
export function pickLevel(bandWidth: number, escape: number, heights: number[]): number {
  for (let i = 0; i < heights.length; i++) {
    if (bandWidth * heights[i] <= MAX_BAND_PX && escape * heights[i] <= MAX_ESCAPE_PX) return i;
  }
  return heights.length - 1;
}

interface Grid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  margin: number; // least distance from the grid's edge to any copied pixel
  cls: Uint8Array; // OUTSIDE, COPIED or INTERIOR per pixel
}

// A grid over [bx0, bx1] × [by0, by1] grown by `margin`, clipped to the frame.
function gridAround(
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
  margin: number,
  w: number,
  h: number,
): Grid | null {
  const x0 = Math.max(0, Math.floor(bx0 - margin));
  const y0 = Math.max(0, Math.floor(by0 - margin));
  const x1 = Math.min(w - 1, Math.ceil(bx1 + margin));
  const y1 = Math.min(h - 1, Math.ceil(by1 + margin));
  if (x1 < x0 || y1 < y0) return null;
  const gw = x1 - x0 + 1;
  const gh = y1 - y0 + 1;
  return { x0, y0, w: gw, h: gh, margin, cls: new Uint8Array(gw * gh) };
}

function markInterior(g: Grid, x: number, y: number) {
  const gx = x - g.x0;
  const gy = y - g.y0;
  if (gx >= 0 && gy >= 0 && gx < g.w && gy < g.h) g.cls[gy * g.w + gx] = INTERIOR;
}

function circleGrid(c: { x: number; y: number; radius: number; feather: number }, w: number, h: number, bandPx: number) {
  const cx = c.x * w - 0.5;
  const cy = c.y * h - 0.5;
  const r = c.radius * h;
  const outer = r * (1 + c.feather);
  // Room for the band: one band width past the copied disc, plus two pixels,
  // since distances between pixels run up to a pixel past the continuous
  // disc's and the band must end before the grid does.
  const g = gridAround(cx - outer, cy - outer, cx + outer, cy + outer, bandPx + 2, w, h);
  if (!g) return null;
  let blemish = false;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const d = Math.hypot(g.x0 + x - cx, g.y0 + y - cy);
      const k = d < r ? INTERIOR : d < outer ? COPIED : OUTSIDE;
      g.cls[y * g.w + x] = k;
      if (k === INTERIOR) blemish = true;
    }
  }
  // A spot narrower than a pixel still blots out the pixel under its centre.
  if (!blemish) markInterior(g, Math.round(cx), Math.round(cy));
  return g;
}

function brushGrid(dabs: BrushDab[], w: number, h: number, bandPx: number) {
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  let widest = 0;
  for (const d of paintDabs(dabs)) {
    const cx = d.x * w - 0.5;
    const cy = d.y * h - 0.5;
    const R = d.radius * h;
    bx0 = Math.min(bx0, cx - R);
    by0 = Math.min(by0, cy - R);
    bx1 = Math.max(bx1, cx + R);
    by1 = Math.max(by1, cy + R);
    widest = Math.max(widest, R);
  }
  if (bx1 < bx0) return null;
  // Room for the band: the blemish can sit up to a dab radius inside the
  // copied box (more where an erase cut it back), plus one band width, plus two
  // pixels for distances measured between pixels rather than continuous shapes.
  const g = gridAround(bx0, by0, bx1, by1, widest + bandPx + 2, w, h);
  if (!g) return null;
  const cover = new Float32Array(g.w * g.h);
  for (const d of dabs) {
    const cx = d.x * w - 0.5;
    const cy = d.y * h - 0.5;
    const R = d.radius * h;
    if (R <= 0) continue;
    const core = R * (1 - Math.max(0, Math.min(1, d.feather)));
    const xa = Math.max(0, Math.floor(cx - R) - g.x0);
    const xb = Math.min(g.w - 1, Math.ceil(cx + R) - g.x0);
    const ya = Math.max(0, Math.floor(cy - R) - g.y0);
    const yb = Math.min(g.h - 1, Math.ceil(cy + R) - g.y0);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const dist = Math.hypot(g.x0 + x - cx, g.y0 + y - cy);
        // Solid inside the core, fading linearly to nothing at the rim, as
        // bakeCoverage draws a dab.
        const t = dist <= core ? 1 : dist < R ? (R - dist) / (R - core) : 0;
        if (t <= 0) continue;
        const i = y * g.w + x;
        cover[i] = d.erase ? cover[i] * (1 - t) : Math.max(cover[i], t);
      }
    }
  }
  let densest = -1;
  let densestCover = 0;
  for (let i = 0; i < cover.length; i++) {
    const c = cover[i];
    g.cls[i] = c >= BRUSH_INTERIOR ? INTERIOR : c > 0 ? COPIED : OUTSIDE;
    if (c > densestCover) {
      densestCover = c;
      densest = i;
    }
  }
  if (densestCover <= 0) return null; // erased away
  // Dabs too small or faint to reach half coverage still mark where they are.
  if (densestCover < BRUSH_INTERIOR) g.cls[densest] = INTERIOR;
  return g;
}

const FAR = 1e20;

// Exact Euclidean distance from every grid pixel to the nearest interior
// pixel (Felzenszwalb & Huttenlocher's separable lower-envelope transform).
function distanceToInterior(g: Grid): Float32Array {
  const { w, h, cls } = g;
  const sq = new Float64Array(w * h);
  for (let i = 0; i < sq.length; i++) sq[i] = cls[i] === INTERIOR ? 0 : FAR;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = sq[y * w + x];
    lowerEnvelope(f, h, d, v, z);
    for (let y = 0; y < h; y++) sq[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = sq[y * w + x];
    lowerEnvelope(f, w, d, v, z);
    for (let x = 0; x < w; x++) sq[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(sq[i]);
  return out;
}

// One line of the transform: d[q] = min over p of (q − p)² + f[p].
function lowerEnvelope(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

// Keeps about `max` of `n` pixels, spread at random by a fixed hash of the
// position, so a spot always thins the same way and no grid aliases it.
function keeps(x: number, y: number, n: number, max: number): boolean {
  if (n <= max) return true;
  let k = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  k = Math.imul(k ^ (k >>> 15), 0x85ebca6b);
  k ^= k >>> 13;
  return (k >>> 0) / 4294967296 < max / n;
}

// The grid's pixels of class `least` or above (COPIED takes the interior too)
// as runs along each row.
function rowRuns(g: Grid, least: number): RowRuns {
  const start = new Int32Array(g.h + 1);
  const xs: number[] = [];
  for (let y = 0; y < g.h; y++) {
    start[y] = xs.length;
    const row = y * g.w;
    for (let x = 0; x < g.w; x++) {
      if (g.cls[row + x] < least) continue;
      const first = x;
      while (x + 1 < g.w && g.cls[row + x + 1] >= least) x++;
      xs.push(g.x0 + first, g.x0 + x);
    }
  }
  start[g.h] = xs.length;
  return { y0: g.y0, h: g.h, start, xs: Int32Array.from(xs) };
}

// Would moving `a` by the whole pixels (tx, ty) put any of its pixels on `b`?
export function runsMeet(a: RowRuns, b: RowRuns, tx: number, ty: number): boolean {
  const first = Math.max(a.y0, b.y0 - ty);
  const end = Math.min(a.y0 + a.h, b.y0 + b.h - ty);
  for (let y = first; y < end; y++) {
    let i = a.start[y - a.y0];
    const iEnd = a.start[y - a.y0 + 1];
    let j = b.start[y + ty - b.y0];
    const jEnd = b.start[y + ty - b.y0 + 1];
    while (i < iEnd && j < jEnd) {
      if (a.xs[i + 1] + tx < b.xs[j]) i += 2;
      else if (b.xs[j + 1] < a.xs[i] + tx) j += 2;
      else return true;
    }
  }
  return false;
}

const emptyBounds = (): Bounds => ({ minDx: Infinity, maxDx: -Infinity, minDy: Infinity, maxDy: -Infinity });

function grow(b: Bounds, dx: number, dy: number) {
  b.minDx = Math.min(b.minDx, dx);
  b.maxDx = Math.max(b.maxDx, dx);
  b.minDy = Math.min(b.minDy, dy);
  b.maxDy = Math.max(b.maxDy, dy);
}

// The region on a w × h level, clipped to its frame; null when nothing of it
// (or nothing around it) is in the frame.
export function rasterizeRegion(region: HealRegion, w: number, h: number): RegionRaster | null {
  const bandPx = Math.max(MIN_BAND_PX, regionBandWidth(region) * h);
  const g = region.kind === "circle" ? circleGrid(region, w, h, bandPx) : brushGrid(region.dabs, w, h, bandPx);
  if (!g) return null;
  const dist = distanceToInterior(g);
  let nInterior = 0;
  let copiedBeyond = 0;
  for (let i = 0; i < g.cls.length; i++) {
    if (g.cls[i] === INTERIOR) nInterior++;
    else if (g.cls[i] === COPIED) copiedBeyond = Math.max(copiedBeyond, dist[i]);
  }
  if (nInterior === 0) return null;
  const outer = copiedBeyond + bandPx;
  let nBand = 0;
  for (let i = 0; i < g.cls.length; i++) if (g.cls[i] !== INTERIOR && dist[i] <= outer) nBand++;
  if (nBand === 0) return null;

  const a = regionAnchor(region);
  const ax = a.x * w - 0.5;
  const ay = a.y * h - 0.5;
  const interior: number[] = [];
  const band: number[] = [];
  const bandWeight: number[] = [];
  const copied: number[] = [];
  const bounds = emptyBounds();
  const copiedBounds = emptyBounds();
  const interiorBounds = emptyBounds();
  let reach = 0;
  let copiedReach = 0;
  let interiorReach = 0;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      const k = g.cls[i];
      const inBand = k !== INTERIOR && dist[i] <= outer;
      if (k === OUTSIDE && !inBand) continue;
      const px = g.x0 + x;
      const py = g.y0 + y;
      const dx = px - ax;
      const dy = py - ay;
      const r = Math.hypot(dx, dy);
      grow(bounds, dx, dy);
      reach = Math.max(reach, r);
      if (k !== OUTSIDE) {
        copied.push(px, py);
        grow(copiedBounds, dx, dy);
        copiedReach = Math.max(copiedReach, r);
      }
      if (k === INTERIOR) {
        grow(interiorBounds, dx, dy);
        interiorReach = Math.max(interiorReach, r);
        if (keeps(px, py, nInterior, MAX_INTERIOR_POINTS)) interior.push(px, py);
      }
      if (inBand && keeps(px, py, nBand, MAX_BAND_POINTS)) {
        band.push(px, py);
        bandWeight.push(1 - dist[i] / (outer + 1));
      }
    }
  }
  if (interior.length === 0 || band.length === 0) return null;
  return {
    ax,
    ay,
    bandPx,
    interior: Int32Array.from(interior),
    band: Int32Array.from(band),
    bandWeight: Float32Array.from(bandWeight),
    copied: Int32Array.from(copied),
    copiedRuns: rowRuns(g, COPIED),
    interiorRuns: rowRuns(g, INTERIOR),
    bounds,
    copiedBounds,
    interiorBounds,
    reach,
    copiedReach,
    interiorReach,
    distToInterior: (x, y) => {
      const gx = Math.round(x) - g.x0;
      const gy = Math.round(y) - g.y0;
      return gx < 0 || gy < 0 || gx >= g.w || gy >= g.h ? g.margin : dist[gy * g.w + gx];
    },
  };
}
