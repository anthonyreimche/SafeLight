// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one blackbody model in the app. Everything that translates between Kelvin
// and white-balance gains — the temperature slider's Auto solve, the eyedropper,
// and the as-shot Kelvin estimated at import — goes through here, so a photo's
// stored temperature means the same thing the shader will do with it.
//
// The fragment shader carries a second, hand-kept copy (`blackbodyLinear` in
// webgl/shaders.ts) because GLSL cannot import TypeScript. blackbody.test.ts
// parses that copy out of the shader source and re-evaluates it against this
// module, so the two cannot drift apart unnoticed.

import { NEUTRAL_TEMPERATURE_K } from "@/catalog/types";

export type LinearRgb = readonly [number, number, number];

// Range the Tanner Helland fit is defined over; outside it the curve is clamped.
export const BLACKBODY_MIN_K = 1000;
export const BLACKBODY_MAX_K = 50000;

// Range the temperature slider exposes, and the space the inversion searches.
export const TEMPERATURE_MIN_K = 2000;
export const TEMPERATURE_MAX_K = 50000;

// Tint slider half-range and the green-gain swing across it.
export const TINT_RANGE = 150;
export const TINT_GAIN_SPAN = 0.6;

// Channel floor before linearisation. Below ~2000 K the fit takes blue to zero,
// which would make the red/blue gain ratio infinite and the inversion useless.
export const BLACKBODY_CHANNEL_FLOOR = 0.0008;

/** sRGB EOTF — the transfer function the blackbody fit is expressed in. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear-light RGB of a blackbody radiator at `kelvin` (Tanner Helland's fit). */
export function blackbodyLinear(kelvin: number): LinearRgb {
  const t = Math.min(BLACKBODY_MAX_K, Math.max(BLACKBODY_MIN_K, kelvin)) / 100;
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
  const encode = (v: number) =>
    srgbToLinear(Math.min(1, Math.max(BLACKBODY_CHANNEL_FLOOR, v / 255)));
  return [encode(r), encode(g), encode(b)];
}

/**
 * Green-normalised white-balance gain for a slider temperature, given the
 * as-shot Kelvin already baked into the decoded pixels. Unity when the two
 * agree — the shader's `applyWhiteBalance`, minus the tint term.
 */
export function whiteBalanceGain(kelvin: number, asShotKelvin: number): LinearRgb {
  const ref = blackbodyLinear(asShotKelvin);
  const bb = blackbodyLinear(kelvin);
  const green = ref[1] / bb[1];
  return [ref[0] / bb[0] / green, 1, ref[2] / bb[2] / green];
}

/** Green gain the tint slider contributes (+tint magenta, −tint green). */
export function tintGain(tint: number): number {
  return 1 - (tint / TINT_RANGE) * TINT_GAIN_SPAN;
}

/** Inverse of `tintGain`: the tint that would produce a given green gain. */
export function tintForGreenGain(gain: number): number {
  return (1 - gain) * (TINT_RANGE / TINT_GAIN_SPAN);
}

const SEARCH_STEPS = 240;

/**
 * The temperature whose white-balance gains reproduce a target red/blue ratio,
 * expressed as `Math.log(gainR / gainB)` and measured against `asShotKelvin`.
 * The fit has no closed-form inverse, so scan log-Kelvin space; the grid is an
 * order of magnitude finer than the 10 K the UI quantises to.
 */
export function kelvinForGainRatio(
  logRedOverBlue: number,
  asShotKelvin: number = NEUTRAL_TEMPERATURE_K,
): number {
  const ref = blackbodyLinear(asShotKelvin);
  let best = asShotKelvin;
  let bestErr = Infinity;
  for (let i = 0; i <= SEARCH_STEPS; i++) {
    const k =
      TEMPERATURE_MIN_K * Math.pow(TEMPERATURE_MAX_K / TEMPERATURE_MIN_K, i / SEARCH_STEPS);
    const bb = blackbodyLinear(k);
    const err = Math.abs(Math.log((ref[0] / bb[0]) / (ref[2] / bb[2])) - logRedOverBlue);
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  return best;
}

/**
 * As-shot Kelvin implied by a camera's white-balance gains (red, green, blue).
 * Only a ratio match against the blackbody curve — it knows nothing of the
 * camera's primaries, so prefer a colour-matrix CCT where the tags exist.
 * Rounded to the 10 K the temperature slider steps in.
 */
export function kelvinFromWhiteBalanceGains(
  gainR: number,
  gainG: number,
  gainB: number,
): number | undefined {
  if (!(gainR > 0) || !(gainG > 0) || !(gainB > 0)) return undefined;
  const kelvin = kelvinForGainRatio(Math.log((gainR / gainG) / (gainB / gainG)));
  return Math.round(kelvin / 10) * 10;
}
