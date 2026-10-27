// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How far a RAW's default render sits from its camera's own rendering, as an
// exposure and a shadows lift: applied with the camera baseline
// (baseline-tone.ts), they land the decode's tones where the camera's embedded
// JPEG has them. Cameras place a scene in the raw very differently and push it
// back in their JPEG, newer Nikons by over a stop and Active D-Lighting and the
// like shot by shot, which no fixed curve or maker table can follow. Active
// D-Lighting exposes less and lifts the shadows back up, so one exposure could
// only meet it in the middle: on 2026-10-26 a Nikon Z 6II's 40 shots matched
// that way came out a quarter stop too bright from the upper midtones up. With
// the lift beside it, every tone sits within about 0.13 EV of the camera.
//
// The two images are compared by their luminance percentiles, so they can be
// sampled at different points, and the preview can be smaller, cropped or not
// yet turned upright. The default render is modelled on luminance with the
// TypeScript mirrors of the shader (baselineTone, baselineRefit, the core
// shoulder at Highlights 0), which lands within about 0.06 EV of the render's
// per-channel result. A leaf module, as accept-decode.ts is.

import { baselineRefit, baselineTone } from "@/rendering/baseline-tone";
import { toneHighlights, toneShadows } from "@/rendering/local-tone";
import { halfToFloat32 } from "./half-float";

const PERCENTILES = [5, 10, 25, 50, 75, 90, 95, 99];
// Scene levels under this are the camera's black point and noise more than its
// exposure.
const DARKEST = 0.003;
// No camera sits further from the pooled curve than this; a best fit at either
// end is a preview that isn't a picture of this decode.
const LOWEST_EV = -1.5;
const HIGHEST_EV = 3;
const STEP_EV = 0.01;
// The lift is searched coarsely over the whole slider, then to the step around
// the best coarse answer: a full fine grid costs ten times the search.
const COARSE_SHADOWS = 0.05;
const STEP_SHADOWS = 0.01;
const FINE_EV = 0.1;
// Enough distinct tones for a fit: a flat frame matches any exposure at one level.
const MIN_LEVELS = 4;
const MIN_SPAN_EV = 1;

// The scene is read on the same grid as the camera's 64 px preview sample, one
// pixel per cell. A flat stride through the pixels reads a frame whose width
// is close to a multiple of the stride down a few columns.
const GRID = 64;

/** The pixel offsets (in pixels) of a side × side grid over a frame, each the
 *  centre of its cell. */
function gridOffsets(width: number, height: number, side: number): number[] {
  const cols = Math.min(side, width);
  const rows = Math.min(side, height);
  const out: number[] = [];
  for (let gy = 0; gy < rows; gy++) {
    const y = Math.floor(((gy + 0.5) * height) / rows);
    for (let gx = 0; gx < cols; gx++) out.push(y * width + Math.floor(((gx + 0.5) * width) / cols));
  }
  return out;
}

interface Frame<T> {
  data: T;
  width: number;
  height: number;
}

/** Rec.709 luminance of an RGBA float frame, on a grid of `side` cells a side
 *  (fewer where the frame is smaller). */
export function lumaSamples(frame: Frame<Float32Array>, side = GRID): Float32Array {
  const { data } = frame;
  return Float32Array.from(gridOffsets(frame.width, frame.height, side), (i) => {
    const o = i * 4;
    return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  });
}

/** The same from the half floats of a RAW cache entry, converting only the
 *  pixels it reads. */
export function halfLumaSamples(frame: Frame<Uint16Array>, side = GRID): Float32Array {
  const offsets = gridOffsets(frame.width, frame.height, side);
  const picked = new Uint16Array(offsets.length * 4);
  offsets.forEach((i, k) => picked.set(frame.data.subarray(i * 4, i * 4 + 4), k * 4));
  return lumaSamples({ data: halfToFloat32(picked), width: offsets.length, height: 1 }, offsets.length);
}

function percentiles(values: ArrayLike<number>): number[] {
  const sorted = Float32Array.from(values).sort();
  const last = sorted.length - 1;
  return PERCENTILES.map((p) => {
    const at = (p / 100) * last;
    const lo = Math.floor(at);
    const hi = Math.min(lo + 1, last);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  });
}

/** Raised whenever the match would come out differently for the same RAW, so
 *  photos matched before learn theirs again: 2 added the shadows lift and read
 *  the scene across the whole frame. */
export const CAMERA_MATCH_VERSION = 2;

/** A RAW's camera match: the exposure in hundredths of a stop and the shadows
 *  lift in Shadows slider steps (0 to 100) that the renderer adds to the
 *  photo's own. */
export interface CameraMatch {
  exposure: number;
  shadows: number;
}

/** The default render's luminance for `base` (the camera baseline of a
 *  scene-linear level) at a camera exposure of `ev` and a lift of `s`
 *  (Shadows / 100), in the render's order: shoulder, then Shadows. */
function rendered(base: number, ev: number, s: number): number {
  return toneShadows(toneHighlights(2 ** ev * base, 0, 0, false), s);
}

/**
 * The camera match that brings the default render of `scene` (scene-linear
 * luminance samples of the decode) to `camera` (linear luminance samples of
 * the camera's JPEG). Undefined when the two have too few tones in common to
 * say, or the best exposure lies outside any camera's range. The lift only
 * goes up: no camera crushes the shadows its JPEG keeps.
 */
export function cameraMatch(scene: ArrayLike<number>, camera: ArrayLike<number>): CameraMatch | undefined {
  if (scene.length === 0 || camera.length === 0) return undefined;
  const xs = percentiles(scene);
  const ys = percentiles(camera);
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x >= DARKEST && x < 1 && y > 1e-4);
  if (pairs.length < MIN_LEVELS) return undefined;
  const span = Math.log2(pairs[pairs.length - 1][0] / pairs[0][0]);
  if (span < MIN_SPAN_EV) return undefined;

  const levels = pairs.map(([x, y]) => [baselineRefit(baselineTone(x)), Math.log2(y)]);

  // A robust loss on the error in stops, so the odd percentile the camera
  // rendered its own way (a clipped sky, a crushed shadow) pulls little.
  const cost = (ev: number, s: number): number =>
    levels.reduce((sum, [base, logY]) => {
      const err = (Math.log2(rendered(base, ev, s)) - logY) / 0.5;
      return sum + Math.log1p(err * err);
    }, 0);
  const steps = Math.round((HIGHEST_EV - LOWEST_EV) / STEP_EV);
  let best = { k: 0, s: 0, cost: Infinity };
  const search = (kFrom: number, kTo: number, sFrom: number, sTo: number, sStep: number): void => {
    for (let s = sFrom; s <= sTo + 1e-9; s += sStep) {
      for (let k = kFrom; k <= kTo; k++) {
        const c = cost(LOWEST_EV + k * STEP_EV, s);
        if (c < best.cost) best = { k, s, cost: c };
      }
    }
  };
  search(0, steps, 0, 1, COARSE_SHADOWS);
  if (best.k === 0 || best.k === steps) return undefined;
  const near = Math.round(FINE_EV / STEP_EV);
  search(
    Math.max(best.k - near, 1),
    Math.min(best.k + near, steps - 1),
    Math.max(best.s - COARSE_SHADOWS, 0),
    Math.min(best.s + COARSE_SHADOWS, 1),
    STEP_SHADOWS,
  );
  return {
    exposure: Math.round((LOWEST_EV + best.k * STEP_EV) * 100) / 100,
    shadows: Math.round(best.s * 100),
  };
}
