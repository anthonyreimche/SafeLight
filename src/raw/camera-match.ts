// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How far a RAW's default render sits from its camera's own rendering, as one
// exposure: the EV that, applied with the camera baseline (baseline-tone.ts),
// lands the decode's tones where the camera's embedded JPEG has them. Cameras
// place a scene in the raw very differently and push it back in their JPEG,
// newer Nikons by over a stop and Active D-Lighting and the like shot by shot,
// which no fixed curve or maker table can follow: on 2026-10-26 a Nikon Z 6II
// needed +1.0 to +2.2 EV across 40 shots, and this brought each to within about
// 0.25 EV of its camera.
//
// The two images are compared by their luminance percentiles, so they can be
// sampled at different points, and the preview can be smaller, cropped or not
// yet turned upright. The default render is modelled on luminance with the
// TypeScript mirrors of the shader (baselineTone, baselineRefit, the core
// shoulder at Highlights 0), which lands within about 0.06 EV of the render's
// per-channel result. A leaf module, as accept-decode.ts is.

import { baselineRefit, baselineTone } from "@/rendering/baseline-tone";
import { toneHighlights } from "@/rendering/local-tone";
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
// Enough distinct tones for a fit: a flat frame matches any exposure at one level.
const MIN_LEVELS = 4;
const MIN_SPAN_EV = 1;

/** Rec.709 luminance of up to `count` pixels spread over an RGBA float frame. */
export function lumaSamples(data: Float32Array, count = 4096): Float32Array {
  const n = data.length / 4;
  const step = Math.max(1, Math.floor(n / count));
  const out = new Float32Array(Math.ceil(n / step));
  for (let i = 0, k = 0; i < n; i += step, k++) {
    const o = i * 4;
    out[k] = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
  }
  return out;
}

/** The same from the half floats of a RAW cache entry, converting only the
 *  pixels it reads. */
export function halfLumaSamples(data: Uint16Array, count = 4096): Float32Array {
  const n = data.length / 4;
  const step = Math.max(1, Math.floor(n / count));
  const picked = new Uint16Array(Math.ceil(n / step) * 4);
  for (let i = 0, k = 0; i < n; i += step, k += 4) picked.set(data.subarray(i * 4, i * 4 + 4), k);
  return lumaSamples(halfToFloat32(picked), Infinity);
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

/** The default render's luminance for scene-linear `x` at a camera exposure of `ev`. */
function rendered(x: number, ev: number): number {
  return toneHighlights(2 ** ev * baselineRefit(baselineTone(x)), 0, 0, false);
}

/**
 * The camera exposure, in hundredths of a stop, that brings the default render
 * of `scene` (scene-linear luminance samples of the decode) to `camera`
 * (linear luminance samples of the camera's JPEG). Undefined when the two have
 * too few tones in common to say, or the best fit lies outside any camera's
 * range.
 */
export function cameraMatchExposure(scene: ArrayLike<number>, camera: ArrayLike<number>): number | undefined {
  if (scene.length === 0 || camera.length === 0) return undefined;
  const xs = percentiles(scene);
  const ys = percentiles(camera);
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x >= DARKEST && x < 1 && y > 1e-4);
  if (pairs.length < MIN_LEVELS) return undefined;
  const span = Math.log2(pairs[pairs.length - 1][0] / pairs[0][0]);
  if (span < MIN_SPAN_EV) return undefined;

  // A robust loss on the error in stops, so the odd percentile the camera
  // rendered its own way (a clipped sky, a crushed shadow) pulls little.
  const cost = (ev: number): number =>
    pairs.reduce((sum, [x, y]) => {
      const err = (Math.log2(rendered(x, ev)) - Math.log2(y)) / 0.5;
      return sum + Math.log1p(err * err);
    }, 0);
  const steps = Math.round((HIGHEST_EV - LOWEST_EV) / STEP_EV);
  let best = 0;
  let bestCost = Infinity;
  for (let k = 0; k <= steps; k++) {
    const c = cost(LOWEST_EV + k * STEP_EV);
    if (c < bestCost) {
      bestCost = c;
      best = k;
    }
  }
  if (best === 0 || best === steps) return undefined;
  return Math.round((LOWEST_EV + best * STEP_EV) * 100) / 100;
}
