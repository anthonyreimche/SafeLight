// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Auto-pick a heal source, plus the rotation, scale and colour shift that make
// the copied patch blend into the spot's surroundings.
//
// The source is chosen by what the surroundings look like rather than by raw
// colour: edges that carry on across the seam, the same amount of detail, the
// same arrangement of colour, and an interior free of a stray blemish of its
// own. The search runs on the finest pyramid level where the spot's seam band
// is at most 12 px wide (3 px at the least) and a move of at most 96 px clears
// the spot of itself, so a large or long spot can push it coarser
// (heal-region's pickLevel). It runs in two passes: a coarse grid of plain
// copies over a window around the spot, then a pixel hill-climb from the few
// best and, for circles, a rotation read off the edge direction on both sides
// (settled to a quarter pixel) and a small scale search, each kept only when
// it clearly beats what came before (the plain copy, then the turned one).
// Brush strokes copy with an offset only (applyRetouch's brush branch), so
// they never turn or scale.
// The band's mean colour difference is returned as an additive offset so the
// patch is recoloured to match.

import { HealPyramid, featureCrop, orientation } from "./heal-pyramid";
import type { FeatureCrop } from "./heal-pyramid";
import { pickLevel, rasterizeRegion, regionBandWidth, regionEscape, runsMeet } from "./heal-region";
import type { Bounds, HealRegion, RegionRaster } from "./heal-region";

let img: Uint8ClampedArray | null = null;
let iw = 0;
let ih = 0;
let pyramid: HealPyramid | null = null;

export function setHealSourceImage(data: Uint8ClampedArray, w: number, h: number) {
  img = data;
  iw = w;
  ih = h;
  pyramid = w > 0 && h > 0 ? new HealPyramid(data, w, h) : null;
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
// the small image, which matters on a main-thread renderer.
export function healImageFromLinear(
  src: Float32Array,
  W: number,
  H: number,
  maxEdge: number,
): { data: Uint8ClampedArray; w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const out = new Uint8ClampedArray(w * h * 4);
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
          r += src[si]; g += src[si + 1]; b += src[si + 2]; n++;
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

// Bilinear sample in UV space, clamped to the frame. Returns 0..255 RGB. Bilinear
// (not nearest) so rotation/scale matching is smooth rather than aliased.
function sample(uvx: number, uvy: number): [number, number, number] {
  const fx = Math.min(iw - 1, Math.max(0, uvx * iw - 0.5));
  const fy = Math.min(ih - 1, Math.max(0, uvy * ih - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(iw - 1, x0 + 1);
  const y1 = Math.min(ih - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * iw + x0) * 4;
  const i10 = (y0 * iw + x1) * 4;
  const i01 = (y1 * iw + x0) * 4;
  const i11 = (y1 * iw + x1) * 4;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = img![i00 + c] + (img![i10 + c] - img![i00 + c]) * tx;
    const b = img![i01 + c] + (img![i11 + c] - img![i01 + c]) * tx;
    out[c] = a + (b - a) * ty;
  }
  return out;
}

export interface HealSource {
  x: number; // source anchor (UV): the circle's centre, or a stroke's paint-dab centroid
  y: number;
  angle: number; // radians; source rotation applied before copying
  scale: number; // source scale applied before copying
  r: number; // additive colour offset (encoded 0..1 space), source -> dest match
  g: number;
  b: number;
}

// Mean colour offset (encoded 0..1) that shifts a source's surroundings toward
// the destination's. Used when the user drags the source manually, so recolour
// keeps matching without re-running the full search.
export function healColorOffset(
  dstX: number,
  dstY: number,
  srcX: number,
  srcY: number,
  radius: number,
  aspect: number,
): { r: number; g: number; b: number } {
  if (!img || iw === 0 || ih === 0) return { r: 0, g: 0, b: 0 };
  const RING = 12;
  const ringR = Math.max(radius * 1.4, 0.01);
  let dR = 0, dG = 0, dB = 0, sR = 0, sG = 0, sB = 0;
  for (let k = 0; k < RING; k++) {
    const a = (k / RING) * Math.PI * 2;
    const cx = (Math.cos(a) * ringR) / aspect;
    const cy = Math.sin(a) * ringR;
    const [dr, dg, db] = sample(dstX + cx, dstY + cy);
    const [sr, sg, sb] = sample(srcX + cx, srcY + cy);
    dR += dr; dG += dg; dB += db;
    sR += sr; sG += sg; sB += sb;
  }
  const clamp = (v: number) => Math.max(-0.5, Math.min(0.5, v / RING / 255));
  return { r: clamp(dR - sR), g: clamp(dG - sG), b: clamp(dB - sB) };
}

// ---- Source search --------------------------------------------------------

// Cost weights; every term is dimensionless and the tests pin what they add
// up to.
const W_EDGE = 2;
const W_TEXTURE = 0.5;
const W_LAYOUT = 1;
const W_INTERIOR = 1;
const W_DISTANCE = 0.005;
// Heal recolours the patch, so its mean colour matters little; clone copies it
// verbatim.
const W_MEAN = { heal: 0.02, clone: 1.5 } as const;
// Squared luma gradient (0..255 per pixel) below which a surface reads as flat.
const NOISE2 = 9;
// Detail levels within this ratio read as the same texture. A spot's own
// interior is often a little busier or calmer than its band (on a stripe's
// slope, say), so a finer grading would pull the source off the structure.
const TEXTURE_TOLERANCE = 1.5;
// Floor on the band's sector spread (squared 0..255), so flat surroundings
// don't magnify noise into layout differences.
const LAYOUT_FLOOR = 25;
// Mean colour distance (0..255) that costs one unit at weight 1.
const MEAN_SCALE = 32;
// An interior pixel more than K·σ + FLOOR from its band's mean colour is an
// outlier; GAIN scales the summed excess.
const OUTLIER_K = 2.5;
const OUTLIER_FLOOR = 12;
const OUTLIER_GAIN = 4;
// An interior this many times busier than its own band holds a feature.
const BUSY_RATIO = 4;
// Angular sectors around the anchor for the colour layout.
const SECTORS = 8;
// The search window: the region's escape plus this many band widths.
const WINDOW_BANDS = 10;
// The coarse grid takes at most this many steps across the window and scores
// about this many band and interior points.
const COARSE_STEPS = 72;
const COARSE_BAND_POINTS = 64;
const COARSE_INTERIOR_POINTS = 32;
// Coarse candidates refined, kept at least a band width apart.
const KEEP = 16;
// Steps one climb may take: a seed starts within a coarse stride or so of its
// optimum, so this only stops a long drift down a gentle slope eating the budget.
const MAX_CLIMB = 32;
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
// Scales a circle's source may take; the crop leaves room for the smallest.
const SCALES = [0.85, 0.92, 1.09, 1.18];
// Rotation is tried only where both sides have a clear edge direction, fine-
// tuned in these steps (degrees).
const MIN_COHERENCE = 0.3;
const FINE_STEPS_DEG = [5, 2.5];
// A turn must cost at most this fraction of the plain copy, and a scale this
// fraction of the unscaled placement it starts from.
const ADOPT = 0.85;
// Sub-pixel steps (level pixels) that settle a turned copy's position.
const POLISH_STEPS = [0.5, 0.25];
// Bound checks tolerate float error on whole-pixel sums.
const EDGE_SLACK = 1e-6;

type Mode = "heal" | "clone";

// Where a patch comes from: the source anchor's offset from the destination's
// in level pixels, and the patch's rotation and scale.
interface Placement {
  tx: number;
  ty: number;
  angle: number;
  scale: number;
}

interface Scored extends Placement {
  cost: number;
}

interface Search {
  rr: RegionRaster;
  crop: FeatureCrop;
  w: number; // level size
  h: number;
  window: number; // farthest offset tried, level pixels
  meanWeight: number;
  rotatable: boolean; // circles turn and scale; brush strokes only shift
  destTheta: number; // the destination band's edge direction (mod π)
  destCoherence: number;
  dest: Float32Array; // per band point: L, A, B, gx, gy at the destination
  sector: Uint8Array; // per band point: its sector around the anchor
}

// Scratch for the hot loops (single-threaded and never re-entered).
const feat = new Float64Array(5);
const at = new Float64Array(2);
const secW = new Float64Array(SECTORS);
const secD = new Float64Array(SECTORS * 3);
const secC = new Float64Array(SECTORS * 3);
// The last costed placement's band means: destination L, A, B, then source.
const bandMeans = new Float64Array(6);

// The five features at (x, y) into `feat`: straight reads on whole pixels,
// bilinear between them.
function readFeatures(c: FeatureCrop, x: number, y: number, whole: boolean) {
  if (whole) {
    const i = (y - c.y0) * c.w + (x - c.x0);
    feat[0] = c.L[i];
    feat[1] = c.A[i];
    feat[2] = c.B[i];
    feat[3] = c.gx[i];
    feat[4] = c.gy[i];
    return;
  }
  const fx = Math.min(c.w - 1, Math.max(0, x - c.x0));
  const fy = Math.min(c.h - 1, Math.max(0, y - c.y0));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(c.w - 1, x0 + 1);
  const y1 = Math.min(c.h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = y0 * c.w + x0;
  const i10 = y0 * c.w + x1;
  const i01 = y1 * c.w + x0;
  const i11 = y1 * c.w + x1;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const mix = (m: Float32Array) => m[i00] * w00 + m[i10] * w10 + m[i01] * w01 + m[i11] * w11;
  feat[0] = mix(c.L);
  feat[1] = mix(c.A);
  feat[2] = mix(c.B);
  feat[3] = mix(c.gx);
  feat[4] = mix(c.gy);
}

// Where the patch fetches destination pixel (x, y) from, into `at`: the
// inverse rotation and scale about the source anchor, as applyRetouch does.
function sourceOf(rr: RegionRaster, p: Placement, cos: number, sin: number, x: number, y: number) {
  if (p.angle === 0 && p.scale === 1) {
    at[0] = x + p.tx;
    at[1] = y + p.ty;
    return;
  }
  const ox = x - rr.ax;
  const oy = y - rr.ay;
  const inv = 1 / p.scale;
  at[0] = rr.ax + p.tx + (cos * ox + sin * oy) * inv;
  at[1] = rr.ay + p.ty + (-sin * ox + cos * oy) * inv;
}

// Does every source pixel (the band's too, unless lenient) lie in the frame?
function fitsFrame(s: Search, p: Placement, whole: boolean, lenient: boolean): boolean {
  const { rr } = s;
  const sx = rr.ax + p.tx;
  const sy = rr.ay + p.ty;
  const lastX = s.w - 1 + EDGE_SLACK;
  const lastY = s.h - 1 + EDGE_SLACK;
  if (whole) {
    const b = lenient ? rr.copiedBounds : rr.bounds;
    return (
      sx + b.minDx >= -EDGE_SLACK && sx + b.maxDx <= lastX && sy + b.minDy >= -EDGE_SLACK && sy + b.maxDy <= lastY
    );
  }
  const r = (lenient ? rr.copiedReach : rr.reach) / p.scale;
  return sx - r >= -EDGE_SLACK && sx + r <= lastX && sy - r >= -EDGE_SLACK && sy + r <= lastY;
}

// Would the patch copy any pixel of the blemish? On whole pixels, a copied
// pixel must not land on a blemish pixel (exact). A fetch between pixels blends
// the pixels around it, each within a diagonal step of its nearest centre, so
// that centre must sit 1 + √½ (more than √2) from the blemish.
function overlapsBlemish(s: Search, p: Placement, whole: boolean): boolean {
  const { rr } = s;
  if (Math.hypot(p.tx, p.ty) > rr.interiorReach + rr.copiedReach / p.scale + 2) return false;
  if (whole) {
    const c = rr.copiedBounds;
    const b = rr.interiorBounds;
    if (
      p.tx + c.maxDx < b.minDx - 1 ||
      p.tx + c.minDx > b.maxDx + 1 ||
      p.ty + c.maxDy < b.minDy - 1 ||
      p.ty + c.minDy > b.maxDy + 1
    ) {
      return false;
    }
    // Row runs rather than a walk of every copied pixel: a slanted stroke's box
    // never separates, and its thousands of pixels would be walked per candidate.
    return runsMeet(rr.copiedRuns, rr.interiorRuns, Math.round(p.tx), Math.round(p.ty));
  }
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  const clear = 1 + Math.SQRT1_2;
  for (let k = 0; k < rr.copied.length; k += 2) {
    sourceOf(rr, p, cos, sin, rr.copied[k], rr.copied[k + 1]);
    if (rr.distToInterior(at[0], at[1]) < clear) return true;
  }
  return false;
}

// How far a mean squared gradient `e` runs past `ratio` times `ref`, in log
// units: 0 while it stays within.
function detailExcess(e: number, ref: number, ratio: number): number {
  return Math.max(0, Math.log((e + NOISE2) / (ref + NOISE2)) - Math.log(ratio));
}

// What copying from `p` costs: Infinity when the source leaves the frame or
// would copy the blemish. Scores every `bandStep`th band point and
// `interiorStep`th interior point, and leaves the band means in `bandMeans`.
function placementCost(s: Search, p: Placement, bandStep: number, interiorStep: number, lenient: boolean): number {
  const { rr, crop } = s;
  const whole = p.angle === 0 && p.scale === 1;
  if (!fitsFrame(s, p, whole, lenient) || overlapsBlemish(s, p, whole)) return Infinity;
  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  const inv = 1 / p.scale;
  const lastX = s.w - 1;
  const lastY = s.h - 1;

  secW.fill(0);
  secD.fill(0);
  secC.fill(0);
  let sw = 0;
  let dEnergy = 0;
  let cEnergy = 0;
  let dot = 0;
  let cSquare = 0;
  let dL = 0, dA = 0, dB = 0, cL = 0, cA = 0, cB = 0;
  const nBand = rr.band.length / 2;
  for (let k = 0; k < nBand; k += bandStep) {
    sourceOf(rr, p, cos, sin, rr.band[2 * k], rr.band[2 * k + 1]);
    const qx = at[0];
    const qy = at[1];
    if (lenient && (qx < 0 || qy < 0 || qx > lastX || qy > lastY)) continue;
    readFeatures(crop, qx, qy, whole);
    const wt = rr.bandWeight[k];
    const o = 5 * k;
    const DL = s.dest[o], DA = s.dest[o + 1], DB = s.dest[o + 2], Dgx = s.dest[o + 3], Dgy = s.dest[o + 4];
    const L = feat[0], A = feat[1], B = feat[2];
    // The source gradient as it lands: turned with the patch, steeper when shrunk.
    const gx = (cos * feat[3] - sin * feat[4]) * inv;
    const gy = (sin * feat[3] + cos * feat[4]) * inv;
    sw += wt;
    dL += wt * DL;
    dA += wt * DA;
    dB += wt * DB;
    cL += wt * L;
    cA += wt * A;
    cB += wt * B;
    cSquare += wt * (L * L + A * A + B * B);
    dEnergy += wt * (Dgx * Dgx + Dgy * Dgy);
    cEnergy += wt * (gx * gx + gy * gy);
    dot += wt * (Dgx * gx + Dgy * gy);
    const sec = s.sector[k];
    secW[sec] += wt;
    secD[3 * sec] += wt * DL;
    secD[3 * sec + 1] += wt * DA;
    secD[3 * sec + 2] += wt * DB;
    secC[3 * sec] += wt * L;
    secC[3 * sec + 1] += wt * A;
    secC[3 * sec + 2] += wt * B;
  }
  if (sw <= 0) return Infinity;
  bandMeans[0] = dL / sw;
  bandMeans[1] = dA / sw;
  bandMeans[2] = dB / sw;
  bandMeans[3] = cL / sw;
  bandMeans[4] = cA / sw;
  bandMeans[5] = cB / sw;
  const dE = dEnergy / sw;
  const cE = cEnergy / sw;

  // Edges: do the destination's edges carry on into the source's? Weighted by
  // how much edge the destination has, so flat surroundings leave it out.
  const ncc = dEnergy > 1e-9 && cEnergy > 1e-9 ? dot / Math.sqrt(dEnergy * cEnergy) : 0;
  const edge = (dE / (dE + NOISE2)) * (1 - ncc);

  // Colour layout: each sector's offset from its side's mean, compared.
  let spread = 0;
  let mismatch = 0;
  let sectorWeight = 0;
  for (let k = 0; k < SECTORS; k++) {
    const wk = secW[k];
    if (wk <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const d = secD[3 * k + c] / wk - bandMeans[c];
      const m = secC[3 * k + c] / wk - bandMeans[3 + c];
      spread += wk * d * d;
      mismatch += wk * (d - m) * (d - m);
    }
    sectorWeight += wk;
  }
  const layout = mismatch / sectorWeight / (spread / sectorWeight + LAYOUT_FLOOR);

  const mL = bandMeans[0] - bandMeans[3];
  const mA = bandMeans[1] - bandMeans[4];
  const mB = bandMeans[2] - bandMeans[5];
  const mean = Math.sqrt(mL * mL + mA * mA + mB * mB) / MEAN_SCALE;

  // Interior: what would replace the blemish, judged against its own band, so
  // an edge running through both is welcome and a lone feature is not.
  const cVar = Math.max(
    0,
    cSquare / sw - (bandMeans[3] * bandMeans[3] + bandMeans[4] * bandMeans[4] + bandMeans[5] * bandMeans[5]),
  );
  const tau = OUTLIER_K * Math.sqrt(cVar) + OUTLIER_FLOOR;
  let iEnergy = 0;
  let excess = 0;
  let scored = 0;
  const nInterior = rr.interior.length / 2;
  for (let k = 0; k < nInterior; k += interiorStep) {
    sourceOf(rr, p, cos, sin, rr.interior[2 * k], rr.interior[2 * k + 1]);
    readFeatures(crop, at[0], at[1], whole);
    iEnergy += (feat[3] * feat[3] + feat[4] * feat[4]) * inv * inv;
    const eL = feat[0] - bandMeans[3];
    const eA = feat[1] - bandMeans[4];
    const eB = feat[2] - bandMeans[5];
    const dev = Math.sqrt(eL * eL + eA * eA + eB * eB);
    if (dev > tau) excess += (dev - tau) / tau;
    scored++;
  }
  const iE = scored > 0 ? iEnergy / scored : cE;
  // The band's detail against the destination's, either way. One-sided for the
  // interior: an edge through the spot makes its inside busier than the band
  // around it, and a feature of its own is `busy`'s business, so only an
  // interior calmer than the band (grain replaced by smooth) counts here.
  const texture =
    Math.max(detailExcess(cE, dE, TEXTURE_TOLERANCE), detailExcess(dE, cE, TEXTURE_TOLERANCE)) +
    detailExcess(dE, iE, TEXTURE_TOLERANCE);
  const outliers = scored > 0 ? (OUTLIER_GAIN * excess) / scored : 0;
  const busy = detailExcess(iE, cE, BUSY_RATIO);
  const distance = Math.hypot(p.tx, p.ty) / rr.bandPx;

  return (
    W_EDGE * edge +
    W_TEXTURE * texture +
    W_LAYOUT * layout +
    s.meanWeight * mean +
    W_INTERIOR * (outliers + busy) +
    W_DISTANCE * distance
  );
}

function buildSearch(
  rr: RegionRaster,
  crop: FeatureCrop,
  w: number,
  h: number,
  window: number,
  mode: Mode,
  rotatable: boolean,
): Search {
  const n = rr.band.length / 2;
  const dest = new Float32Array(5 * n);
  const sector = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const bx = rr.band[2 * k];
    const by = rr.band[2 * k + 1];
    readFeatures(crop, bx, by, true);
    dest.set(feat, 5 * k);
    const turn = (Math.atan2(by - rr.ay, bx - rr.ax) + Math.PI) / (2 * Math.PI);
    sector[k] = Math.min(SECTORS - 1, Math.floor(turn * SECTORS));
  }
  const edge = bandOrientation(rr, crop, w, h, 0, 0, false);
  return {
    rr,
    crop,
    w,
    h,
    window,
    // applyRetouch's brush branch (the uRetouchCount loop) copies verbatim, with
    // no tint or membrane, so a brush heals at the source's own brightness and
    // is matched as a clone is. Follow that branch once brush heals recolour.
    meanWeight: rotatable ? W_MEAN[mode] : W_MEAN.clone,
    rotatable,
    dest,
    sector,
    destTheta: edge.theta,
    destCoherence: edge.coherence,
  };
}

function better(best: Scored, s: Search, p: Placement, lenient: boolean): Scored {
  const cost = placementCost(s, p, 1, 1, lenient);
  return cost < best.cost ? { ...p, cost } : best;
}

// Step the source `step` level pixels at a time, to whichever of its eight
// neighbours costs least, while that lowers the cost.
function climb(s: Search, start: Placement, lenient: boolean, step = 1): Scored {
  let cur: Scored = { ...start, cost: placementCost(s, start, 1, 1, lenient) };
  for (let i = 0; i < MAX_CLIMB; i++) {
    let next = cur;
    for (const [dx, dy] of NEIGHBOURS) {
      const tx = cur.tx + dx * step;
      const ty = cur.ty + dy * step;
      if (tx * tx + ty * ty > s.window * s.window) continue;
      next = better(next, s, { tx, ty, angle: cur.angle, scale: cur.scale }, lenient);
    }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// The band's edge direction and coherence as a plain copy shifted by (tx, ty)
// reads it ((0, 0) is the destination's own): the structure tensor of its
// gradients, weighted as the band is. Lenient skips points off the frame.
function bandOrientation(
  rr: RegionRaster,
  crop: FeatureCrop,
  w: number,
  h: number,
  tx: number,
  ty: number,
  lenient: boolean,
) {
  let jxx = 0;
  let jxy = 0;
  let jyy = 0;
  for (let k = 0; k < rr.band.length / 2; k++) {
    const qx = rr.band[2 * k] + tx;
    const qy = rr.band[2 * k + 1] + ty;
    if (lenient && (qx < 0 || qy < 0 || qx > w - 1 || qy > h - 1)) continue;
    readFeatures(crop, qx, qy, true);
    const wt = rr.bandWeight[k];
    jxx += wt * feat[3] * feat[3];
    jxy += wt * feat[3] * feat[4];
    jyy += wt * feat[4] * feat[4];
  }
  return orientation(jxx, jxy, jyy);
}

// Turn a circle's plain optimum so the source's edge lies along the
// destination's. Kept only when it costs at most ADOPT of the plain copy.
function turnSource(s: Search, plain: Scored, lenient: boolean): Scored {
  const src = bandOrientation(s.rr, s.crop, s.w, s.h, plain.tx, plain.ty, lenient);
  if (s.destCoherence < MIN_COHERENCE || src.coherence < MIN_COHERENCE) return plain;
  // Either polarity, since an edge direction is only known mod π: the edge
  // term tells dark-over-light from its flip, so climb just the cheaper one
  // (both when neither is usable as it stands, off the frame or over the
  // blemish).
  const turn = s.destTheta - src.theta;
  const polarities: Placement[] = [turn, turn + Math.PI].map((a) => ({
    tx: plain.tx,
    ty: plain.ty,
    angle: wrapAngle(a),
    scale: 1,
  }));
  const costs = polarities.map((p) => placementCost(s, p, 1, 1, lenient));
  const tries =
    costs[0] === Infinity && costs[1] === Infinity ? polarities : [polarities[costs[0] <= costs[1] ? 0 : 1]];
  // Climb before comparing: the turned copy's best spot is not under the plain optimum.
  let best = tries.map((p) => climb(s, p, lenient)).reduce((a, b) => (b.cost < a.cost ? b : a));
  // Fine steps about the better polarity, whether or not it beats the plain copy yet.
  for (const step of FINE_STEPS_DEG) {
    const around = best.angle;
    for (const d of [-step, step]) {
      const angle = wrapAngle(around + (d * Math.PI) / 180);
      best = better(best, s, { tx: best.tx, ty: best.ty, angle, scale: 1 }, lenient);
    }
  }
  best = climb(s, best, lenient);
  if (best.cost > ADOPT * plain.cost) return plain;
  return best.angle === 0 ? best : polish(s, best, lenient);
}

// A turned copy is fetched between pixels anyway, so its position deserves
// sub-pixel precision; left on whole pixels, the scale stage ends up acting as
// a sub-pixel corrector. Never called for an unturned copy, whose whole-pixel
// fast path reads the crop by integer index.
function polish(s: Search, turned: Scored, lenient: boolean): Scored {
  let best = turned;
  for (const step of POLISH_STEPS) best = climb(s, best, lenient, step);
  return best;
}

// Try a few scales about the best placement so far (the turned one when a turn
// was kept): cost each as it stands, then climb the cheapest. Kept only when it
// costs at most ADOPT of that unscaled placement, so a large gain from turning
// cannot carry a scale through.
function scaleSource(s: Search, base: Scored, lenient: boolean): Scored {
  let best: Scored = base;
  for (const scale of SCALES) best = better(best, s, { tx: base.tx, ty: base.ty, angle: base.angle, scale }, lenient);
  if (best === base) return base;
  best = climb(s, best, lenient);
  return best.cost <= ADOPT * base.cost ? best : base;
}

// For a circle's plain optimum: turn it, then scale it, each step gated on its
// own against what came before. Surroundings without a clear edge direction
// give a scale nothing to line up, so a win there is grain noise.
function transform(s: Search, plain: Scored, lenient: boolean): Scored {
  if (s.destCoherence < MIN_COHERENCE) return plain;
  return scaleSource(s, turnSource(s, plain, lenient), lenient);
}

// A coarse grid of plain copies over the window, then refine the best few.
function searchPlacements(s: Search, lenient: boolean): Scored | null {
  const { rr, window } = s;
  const stride = Math.max(1, Math.round(rr.bandPx / 3), Math.ceil((2 * window) / COARSE_STEPS));
  const bandStep = Math.max(1, Math.floor(rr.band.length / 2 / COARSE_BAND_POINTS));
  const interiorStep = Math.max(1, Math.floor(rr.interior.length / 2 / COARSE_INTERIOR_POINTS));
  const span = Math.floor(window / stride) * stride;
  const found: Scored[] = [];
  for (let ty = -span; ty <= span; ty += stride) {
    for (let tx = -span; tx <= span; tx += stride) {
      if (tx * tx + ty * ty > window * window) continue;
      const p: Placement = { tx, ty, angle: 0, scale: 1 };
      const cost = placementCost(s, p, bandStep, interiorStep, lenient);
      if (cost < Infinity) found.push({ ...p, cost });
    }
  }
  found.sort((a, b) => a.cost - b.cost);
  const seeds: Scored[] = [];
  for (const f of found) {
    if (seeds.every((q) => Math.hypot(q.tx - f.tx, q.ty - f.ty) >= rr.bandPx)) seeds.push(f);
    if (seeds.length === KEEP) break;
  }
  let best: Scored | null = null;
  // Seeds often climb to the same placement; turning and scaling it once is enough.
  const climbed = new Set<string>();
  for (const seed of seeds) {
    const plain = climb(s, seed, lenient);
    const key = `${plain.tx},${plain.ty}`;
    if (climbed.has(key)) continue;
    climbed.add(key);
    const r = s.rotatable ? transform(s, plain, lenient) : plain;
    if (!best || r.cost < best.cost) best = r;
  }
  return best;
}

// Inverse of the opponent transform in heal-pyramid.
function opponentToRgb(L: number, A: number, B: number): [number, number, number] {
  return [L + B / 3 + A / 2, L - (2 * B) / 3, L + B / 3 - A / 2];
}

// Offsets from the anchor bounding the region's copied pixels and band as if
// the frame didn't clip them: a circle's copied disc, or each paint dab, grown
// by one band width. It starts from the raster's own (clipped) bounds and only
// grows them, and that union matters: the band is measured out from the
// blemish, so on the pixel grid, or past a blemish an erase cut back, it can
// reach beyond a dab grown by one band width.
function unclippedBounds(region: HealRegion, raster: RegionRaster, w: number, h: number): Bounds {
  const b: Bounds = { ...raster.bounds };
  const add = (x: number, y: number, reach: number) => {
    const dx = x * w - 0.5 - raster.ax;
    const dy = y * h - 0.5 - raster.ay;
    b.minDx = Math.min(b.minDx, dx - reach);
    b.maxDx = Math.max(b.maxDx, dx + reach);
    b.minDy = Math.min(b.minDy, dy - reach);
    b.maxDy = Math.max(b.maxDy, dy + reach);
  };
  if (region.kind === "circle") {
    add(region.x, region.y, region.radius * h * (1 + region.feather) + raster.bandPx);
  } else {
    for (const d of region.dabs) if (!d.erase) add(d.x, d.y, d.radius * h + raster.bandPx);
  }
  return b;
}

// The source for a spot, or null when nothing in reach fits (the caller then
// falls back to a plain offset).
export function findHealSource(region: HealRegion, mode: Mode): HealSource | null {
  if (!pyramid) return null;
  const escape = regionEscape(region, pyramid.widths[0] / pyramid.heights[0]);
  const level = pickLevel(regionBandWidth(region), escape, pyramid.heights);
  const w = pyramid.widths[level];
  const h = pyramid.heights[level];
  const raster = rasterizeRegion(region, w, h);
  if (!raster) return null;
  // The frame rule judges the spot's whole copied disc and band, not just its
  // in-frame pixels, so a source can't hug the edge a clipped spot runs off.
  const rr: RegionRaster = { ...raster, bounds: unclippedBounds(region, raster, w, h) };
  const window = escape * h + WINDOW_BANDS * rr.bandPx;
  // Every source pixel lies within the window of the region's own, turned and
  // scaled about the anchor for a circle. Two pixels of slack all round, since
  // readFeatures quietly clamps a read past the crop to its edge.
  const grow = region.kind === "circle" ? rr.reach / SCALES[0] : 0;
  const b = rr.bounds;
  const crop = featureCrop(
    pyramid.pixels(level),
    rr.ax + Math.min(b.minDx, -grow) - window - 2,
    rr.ay + Math.min(b.minDy, -grow) - window - 2,
    rr.ax + Math.max(b.maxDx, grow) + window + 2,
    rr.ay + Math.max(b.maxDy, grow) + window + 2,
  );
  const s = buildSearch(rr, crop, w, h, window, mode, region.kind === "circle");
  let lenient = false;
  let best = searchPlacements(s, lenient);
  if (!best) {
    // Too big for any source to fit with its band: let the band run off the frame.
    lenient = true;
    best = searchPlacements(s, lenient);
  }
  if (!best) return null;
  placementCost(s, best, 1, 1, lenient); // leaves the band means in bandMeans
  const dst = opponentToRgb(bandMeans[0], bandMeans[1], bandMeans[2]);
  const src = opponentToRgb(bandMeans[3], bandMeans[4], bandMeans[5]);
  const shift = (c: number) => Math.max(-0.5, Math.min(0.5, (dst[c] - src[c]) / 255));
  return {
    x: (rr.ax + best.tx + 0.5) / w,
    y: (rr.ay + best.ty + 0.5) / h,
    angle: best.angle,
    scale: best.scale,
    r: shift(0),
    g: shift(1),
    b: shift(2),
  };
}
