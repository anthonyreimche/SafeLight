// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The default look for scene-linear (RAW) sources: the lift a camera's JPEG
// engine adds between the sensor's linear response and the display, so a RAW
// opens looking like the camera's own preview instead of a flat sRGB encode.
// Shape fitted to the median of what camera JPEG engines do to the same sensor
// data, measured across makers on the sample library (embedded preview against
// the linear decode): about +0.75 EV at 15–20% grey, tapering to nothing at
// white, with the deepest shadows held down a little, like a camera black point.
//
// Applied once, in linear light before white balance and exposure, and only
// under uApplyBaseCurve (RAW sources); a display transform that owns its own
// baseline (skipBaseCurve) switches it off. Anything above white passes
// through unchanged so highlight recovery keeps the sensor's headroom.
//
// f(x) = x·((A·x + B)·x + C) / (((D·x + E)·x + F)·x + G), G = A + B + C − D − E − F
// so f(1) = 1 exactly. Below black, where the decode leaves the channels of
// colours outside the sRGB primaries, it continues as the line through 0 with
// the curve's own slope there (C / G), so those colours keep their hue. The
// GLSL below must stay the componentwise twin of baselineTone(); the GPU suite
// renders both and compares.

const A = 0.5323;
const B = 1.2015;
const C = 0.0293;
const D = -0.4781;
const E = 1.9616;
const F = 0.2281;
const G = +(A + B + C - D - E - F).toFixed(4);

export function baselineTone(x: number): number {
  const c = Math.min(Math.max(x, 0), 1);
  return (c * ((A * c + B) * c + C)) / (((D * c + E) * c + F) * c + G)
    + Math.max(x - 1, 0)
    + (Math.min(x, 0) * C) / G;
}

const glsl = (v: number): string => `(${v.toFixed(4)})`;

export const BASELINE_TONE_GLSL = `
vec3 baselineTone(vec3 x) {
  vec3 c = clamp(x, 0.0, 1.0);
  return c * ((${glsl(A)} * c + ${glsl(B)}) * c + ${glsl(C)})
       / (((${glsl(D)} * c + ${glsl(E)}) * c + ${glsl(F)}) * c + ${glsl(G)})
       + max(x - 1.0, 0.0)
       + min(x, 0.0) * ${glsl(C)} / ${glsl(G)};
}
`;

// The camera baseline: process version 2 and later refit the look to camera
// JPEGs measured again on the sample library (2026-10-25, 235 RAWs; Fujifilm,
// whose RawExposureBias the probe couldn't read, and Sigma's Foveon left out).
// baselineTone above sat 0.3 EV over the pooled camera curve in the deep
// shadows and 0.15-0.2 EV under it from 10% grey up; version 1 keeps it alone.
// The refit corrects baselineTone's result rather than replacing it: the decode
// stages' passes read the source through a prelude every process version
// shares, which knows only baselineTone, so the program applies baselineTone
// where it always has and this after those stages and clip recovery. Same form
// and continuations as baselineTone, so the two together still map 1 to 1,
// pass headroom through and carry negatives along a line. Together they track
// the pooled camera curve within 0.15 EV from 0.7% to 71% scene level.

const RA = 3062.8036;
const RB = 172.7445;
const RC = 1.029;
const RD = 983.1698;
const RE = 1972.4285;
const RF = 279.9788;
const RG = +(RA + RB + RC - RD - RE - RF).toFixed(4);

export function baselineRefit(x: number): number {
  const c = Math.min(Math.max(x, 0), 1);
  return (c * ((RA * c + RB) * c + RC)) / (((RD * c + RE) * c + RF) * c + RG)
    + Math.max(x - 1, 0)
    + (Math.min(x, 0) * RC) / RG;
}

/** The GLSL twin of baselineRefit, as slBaselineRefit. */
export const BASELINE_REFIT_GLSL = `
vec3 slBaselineRefit(vec3 x) {
  vec3 c = clamp(x, 0.0, 1.0);
  return c * ((${glsl(RA)} * c + ${glsl(RB)}) * c + ${glsl(RC)})
       / (((${glsl(RD)} * c + ${glsl(RE)}) * c + ${glsl(RF)}) * c + ${glsl(RG)})
       + max(x - 1.0, 0.0)
       + min(x, 0.0) * ${glsl(RC)} / ${glsl(RG)};
}
`;

// How far each maker's JPEGs sit from the pooled curve, in EV, fitted on the
// same probe as a gain after the refit (the renderer's uBaselineGain).
// Only makers with 15 or more sample files whose 90% bootstrap interval leaves
// out zero have one; Canon (+0.08) and Olympus (+0.06) were within the noise.
// A negative offset lowers sensor white with everything else, so those bodies'
// brightest highlights sit about a quarter stop under their camera's.
const MAKER_EXPOSURE: readonly [RegExp, number][] = [
  [/\bsony\b/, 0.31],
  [/\bnikon\b/, 0.21],
  [/\bpentax\b/, -0.28],
  [/\bpanasonic\b/, -0.25],
];

/** The EV a RAW from this camera gets on top of the pooled curve, 0 for a
 *  maker without one. Reads the model too: Pentax bodies since 2013 report
 *  Ricoh as their make. */
export function baselineExposureFor(make: string | undefined, model: string | undefined): number {
  const camera = `${make ?? ""} ${model ?? ""}`.toLowerCase();
  return MAKER_EXPOSURE.find(([maker]) => maker.test(camera))?.[1] ?? 0;
}
