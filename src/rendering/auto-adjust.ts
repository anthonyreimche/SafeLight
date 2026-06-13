// Auto white balance + auto tone. Each function computes ONE corrective step
// from the live histogram of the rendered canvas and reports whether the image
// has converged. The caller (use-auto-adjust) applies the step, lets the
// pipeline re-render, then re-measures — so a single button press drives the
// real render loop to a balanced, detail-maximising result instead of needing
// several manual clicks. Driving the actual pipeline this way sidesteps the
// non-linear tone curve that a single analytic pass can't invert.

import type { DevelopParams } from "@/catalog/types";
import type { HistogramData } from "./histogram";

// --- sRGB <-> linear (matches the renderer's transfer functions) ------------
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Linear blackbody RGB (Tanner Helland fit) — the same model the WB shader uses
// to derive Kelvin gains, ported to JS so Auto WB inverts it exactly.
function blackbodyLinear(kelvin: number): [number, number, number] {
  const t = Math.min(50000, Math.max(1000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp01 = (v: number) => Math.min(1, Math.max(0.0008, v / 255));
  return [srgbToLinear(clamp01(r)), srgbToLinear(clamp01(g)), srgbToLinear(clamp01(b))];
}

// Mean linear value of a 256-bin channel histogram (bins are display sRGB 0..255).
function meanLinear(bins: Uint32Array): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 256; i++) {
    const n = bins[i];
    if (!n) continue;
    sum += n * srgbToLinear(i / 255);
    count += n;
  }
  return count ? sum / count : 0;
}

const TEMP_MIN = 2000;
const TEMP_MAX = 50000;
const TINT_MIN = -150;
const TINT_MAX = 150;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Auto white balance — one gray-world step
// ---------------------------------------------------------------------------
export interface WbStep {
  temperature: number;
  tint: number;
  done: boolean;
}

/**
 * One gray-world white-balance step. Measures the rendered channel means,
 * estimates the pre-WB scene ratios by removing the current gains, solves for
 * the Kelvin temperature + tint that neutralise them, then moves most of the
 * way there (damped, to stay stable across iterations). `done` is true once the
 * three channel means agree to within ~1%.
 */
export function autoWhiteBalanceStep(hist: HistogramData, params: DevelopParams): WbStep {
  return whiteBalanceStepFromLinear(
    meanLinear(hist.r),
    meanLinear(hist.g),
    meanLinear(hist.b),
    params,
  );
}

/**
 * One white-balance step toward neutralising the linear RGB triple (mR,mG,mB).
 * Shared by Auto WB (channel means of the whole frame) and the eyedropper picker
 * (a single sampled point that should be grey). Estimates the pre-WB scene
 * ratios, solves for the Kelvin temperature + tint that neutralise them, then
 * moves most of the way there (damped). `done` is true once R/G/B agree to ~1%.
 */
export function whiteBalanceStepFromLinear(
  mR: number,
  mG: number,
  mB: number,
  params: DevelopParams,
): WbStep {
  if (mR <= 0 || mG <= 0 || mB <= 0) {
    return { temperature: params.temperature, tint: params.tint, done: true };
  }

  const meanAll = (mR + mG + mB) / 3;
  const dev =
    Math.max(Math.abs(mR - mG), Math.abs(mG - mB), Math.abs(mR - mB)) / meanAll;
  if (dev < 0.01) {
    return { temperature: params.temperature, tint: params.tint, done: true };
  }

  const bb65 = blackbodyLinear(6500);
  const gainsFor = (kelvin: number, tint: number): [number, number, number] => {
    const bb = blackbodyLinear(kelvin);
    let gr = bb65[0] / bb[0];
    const gNorm = bb65[1] / bb[1];
    let gb = bb65[2] / bb[2];
    gr /= gNorm;
    gb /= gNorm;
    const gg = 1 - (tint / 150) * 0.6;
    return [gr, gg, gb];
  };

  // Pre-WB scene means (remove the gains the current temp/tint applied).
  const cur = gainsFor(params.temperature, params.tint);
  const sR = mR / cur[0];
  const sG = mG / cur[1];
  const sB = mB / cur[2];

  // Solve temp: want scene_r * gainR(k) == scene_b * gainB(k). gainR/gainB
  // depends only on Kelvin, so search log-space for the balancing temperature.
  const targetLogRB = Math.log(sB / sR);
  let bestK = params.temperature;
  let bestErr = Infinity;
  const steps = 240;
  for (let i = 0; i <= steps; i++) {
    const k = TEMP_MIN * Math.pow(TEMP_MAX / TEMP_MIN, i / steps);
    const bb = blackbodyLinear(k);
    const err = Math.abs(Math.log((bb65[0] / bb[0]) / (bb65[2] / bb[2])) - targetLogRB);
    if (err < bestErr) {
      bestErr = err;
      bestK = k;
    }
  }
  const solvedTemp = clamp(bestK, TEMP_MIN, TEMP_MAX);

  // Solve tint so green matches the balanced red: gainG = 1 - (tint/150)*0.6.
  const ng = gainsFor(solvedTemp, 0);
  const wantGainG = (sR * ng[0]) / sG;
  const solvedTint = clamp((1 - wantGainG) * 250, TINT_MIN, TINT_MAX);

  // Damp toward the solution (geometric for Kelvin, linear for tint) so the
  // residual tone-curve non-linearity converges instead of oscillating.
  const t = 0.85;
  const temperature = clamp(
    Math.exp(Math.log(params.temperature) * (1 - t) + Math.log(solvedTemp) * t),
    TEMP_MIN,
    TEMP_MAX,
  );
  const tint = clamp(params.tint * (1 - t) + solvedTint * t, TINT_MIN, TINT_MAX);

  return { temperature: Math.round(temperature / 10) * 10, tint: Math.round(tint), done: false };
}

// ---------------------------------------------------------------------------
// Auto tone — one step toward a full, unclipped tonal range
// ---------------------------------------------------------------------------
export interface ToneStep
  extends Pick<
    DevelopParams,
    "exposure" | "contrast" | "highlights" | "shadows" | "whites" | "blacks"
  > {
  done: boolean;
}

function percentile(luma: Uint32Array, p: number, total: number): number {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += luma[i];
    if (acc >= target) return i;
  }
  return 255;
}

// Convergence/aim points (display luma, 0..255).
const EXPO_TARGET = 115; // median midtone
const WHITE_TARGET = 250; // 99.75th percentile sits just below clipping
const BLACK_TARGET = 6; // 0.25th percentile sits just above black
const CLIP_TOL = 0.0025; // acceptable fraction in the extreme bins

/**
 * One auto-tone step. Pushes exposure toward a mid-grey median and expands the
 * white/black points to the edges of the range (bringing out the most tonal
 * detail), while recovering any highlight/shadow clipping. Gains are gentle so
 * the caller's re-render → re-measure loop settles in a couple of iterations.
 * Contrast is left untouched to avoid crushing detail.
 */
export function autoToneStep(hist: HistogramData, params: DevelopParams): ToneStep {
  const luma = hist.luma;
  let total = 0;
  for (let i = 0; i < 256; i++) total += luma[i];
  if (!total) {
    return {
      exposure: params.exposure,
      contrast: params.contrast,
      highlights: params.highlights,
      shadows: params.shadows,
      whites: params.whites,
      blacks: params.blacks,
      done: true,
    };
  }

  const median = Math.max(1, percentile(luma, 0.5, total));
  const pLo = percentile(luma, 0.0025, total);
  const pHi = percentile(luma, 0.9975, total);

  let clipHi = 0;
  let clipLo = 0;
  for (let i = 253; i < 256; i++) clipHi += luma[i];
  for (let i = 0; i <= 2; i++) clipLo += luma[i];
  clipHi /= total;
  clipLo /= total;

  // Per-step corrections (proportional control, clamped for stability).
  const expDelta = clamp(2.2 * Math.log2(EXPO_TARGET / median), -1.5, 1.5);
  const whiteDelta = clamp((WHITE_TARGET - pHi) * 0.5, -25, 25);
  const blackDelta = clamp((BLACK_TARGET - pLo) * 0.5, -25, 25);
  const hiDelta = clipHi > CLIP_TOL ? clamp(-(clipHi - CLIP_TOL) * 3000, -25, 0) : 0;
  const loDelta = clipLo > CLIP_TOL ? clamp((clipLo - CLIP_TOL) * 3000, 0, 25) : 0;

  const done =
    Math.abs(expDelta) < 0.04 &&
    Math.abs(WHITE_TARGET - pHi) < 4 &&
    Math.abs(BLACK_TARGET - pLo) < 4 &&
    clipHi < CLIP_TOL * 1.5 &&
    clipLo < CLIP_TOL * 1.5;

  return {
    exposure: round2(clamp(params.exposure + expDelta, -5, 5)),
    contrast: Math.round(params.contrast),
    highlights: Math.round(clamp(params.highlights + hiDelta, -100, 100)),
    shadows: Math.round(clamp(params.shadows + loDelta, -100, 100)),
    whites: Math.round(clamp(params.whites + whiteDelta, -100, 100)),
    blacks: Math.round(clamp(params.blacks + blackDelta, -100, 100)),
    done,
  };
}
