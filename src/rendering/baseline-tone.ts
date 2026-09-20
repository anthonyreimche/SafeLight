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
// so f(1) = 1 exactly. The GLSL below must stay the componentwise twin of
// baselineTone(); the GPU suite renders both and compares.

const A = 0.5323;
const B = 1.2015;
const C = 0.0293;
const D = -0.4781;
const E = 1.9616;
const F = 0.2281;
const G = +(A + B + C - D - E - F).toFixed(4);

export function baselineTone(x: number): number {
  const c = Math.min(Math.max(x, 0), 1);
  return (c * ((A * c + B) * c + C)) / (((D * c + E) * c + F) * c + G) + Math.max(x - 1, 0);
}

const glsl = (v: number): string => `(${v.toFixed(4)})`;

export const BASELINE_TONE_GLSL = `
vec3 baselineTone(vec3 x) {
  vec3 c = clamp(x, 0.0, 1.0);
  return c * ((${glsl(A)} * c + ${glsl(B)}) * c + ${glsl(C)})
       / (((${glsl(D)} * c + ${glsl(E)}) * c + ${glsl(F)}) * c + ${glsl(G)})
       + max(x - 1.0, 0.0);
}
`;
