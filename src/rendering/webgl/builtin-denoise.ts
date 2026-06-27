// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ProcessingStageContribution } from "@/extensions/types";
import type { DevelopParams } from "@/catalog/types";

// Built-in noise reduction, rebuilt as a multi-pass GPU wavelet denoiser that
// replaces the old inline 3-mip soft-threshold. It runs through the engine's
// prepass framework (ping-pong float framebuffers) in the noise-reduction phase
// on scene-linear data, before exposure — so denoising isn't amplified.
//
// Algorithm (the same family Darktable/RawTherapee use, sized for real-time GL):
//   1. Anscombe variance-stabilizing transform (VST) on luminance. Sensor noise
//      is signal-dependent (Poisson) — its magnitude grows with brightness — so
//      a single threshold is otherwise wrong across the tonal range. The VST
//      z = 2*sqrt(y*s + 3/8) maps it to roughly constant variance; we denoise in
//      that domain and invert at the end.
//   2. YCoCg decorrelation (exact, cheap inverse) so luma and chroma denoise
//      independently — luma keeps detail (tight edge-stop), chroma smooths hard
//      (loose edge-stop), matching how the two noise types are perceived.
//   3. Edge-aware a-trous wavelet smoothing: a B3-spline [1 4 6 4 1] kernel at
//      doubling dilation (1,2,4,8,16) per iteration, with a bilateral
//      (luminance-difference) edge-stop so flat areas smooth while edges hold.
//
// The 8 Detail-panel sliders drive it via the param bag (see denoiseBag): the
// inline stage GLSL gates on the existing uLuminanceNR/uColorNR uniforms and,
// when active in the float pipeline, swaps `lin` for the denoised result.
//
// GLSL note: kept to vanilla GLSL ES 3.00 (no const arrays, no bit-ops, no
// non-ASCII) so it compiles on ANGLE/D3D as well as desktop GL.

export const BUILTIN_DENOISE_ID = "builtin.denoise";

// Default photon-scale for the VST. Without a per-ISO noise profile this is a
// fixed knob; larger = treats noise as more uniform (less signal-dependent).
const VST_SCALE_DEFAULT = 600;
// A-trous iterations: dilation doubles each step (1,2,4,8,16).
const ATROUS_ITERATIONS = 5;

// Pass 1 — forward: linear RGB -> (VST-luma, Co, Cg). YCoCg inlined.
const FORWARD_PASS = `
vec3 rgb = max(c, 0.0);
float Y = dot(rgb, vec3(0.25, 0.5, 0.25));
float Co = 0.5 * rgb.r - 0.5 * rgb.b;
float Cg = -0.25 * rgb.r + 0.5 * rgb.g - 0.25 * rgb.b;
float Yv = 2.0 * sqrt(max(Y * vstScale + 0.375, 0.0));
c = vec3(Yv, Co, Cg);
`;

// Pass 2 — edge-aware a-trous (run ATROUS_ITERATIONS times). Reads the previous
// pass's (VST-luma, Co, Cg). uPassIndex sets the dilation.
const ATROUS_PASS = `
float atrDil = exp2(float(uPassIndex));
vec3 ctr = c;
float lumSigma = mix(2.4, 0.5, lumDetail / 100.0) * (1.0 - 0.5 * lumContrast / 100.0);
lumSigma = max(lumSigma, 0.12);
float colSigma = mix(8.0, 2.5, colDetail / 100.0);
float ysum = 0.0;
float wy = 0.0;
vec2 csum = vec2(0.0);
float wc = 0.0;
for (int dy = -2; dy <= 2; dy++) {
  for (int dx = -2; dx <= 2; dx++) {
    float ax = abs(float(dx));
    float ay = abs(float(dy));
    float kwx = ax < 0.5 ? 6.0 : (ax < 1.5 ? 4.0 : 1.0);
    float kwy = ay < 0.5 ? 6.0 : (ay < 1.5 ? 4.0 : 1.0);
    float kw = kwx * kwy;
    vec2 off = vec2(float(dx), float(dy)) * atrDil * uTexel;
    vec3 sp = readPrev(vUv + off);
    float dY = sp.x - ctr.x;
    float wgt = kw * exp(-(dY * dY) / (2.0 * lumSigma * lumSigma));
    ysum += wgt * sp.x;
    wy += wgt;
    float wgtC = kw * exp(-(dY * dY) / (2.0 * colSigma * colSigma));
    csum += wgtC * sp.yz;
    wc += wgtC;
  }
}
float yFilt = ysum / max(wy, 1e-5);
vec2 cFilt = csum / max(wc, 1e-5);
float ln = clamp(ctr.x / (2.0 * sqrt(vstScale + 0.375)), 0.0, 1.0);
float zone = 1.0 + (lumShadows / 100.0) * (1.0 - smoothstep(0.0, 0.35, ln)) - (lumHighlights / 100.0) * smoothstep(0.65, 1.0, ln);
float lumBlend = clamp((lumAmount / 100.0) * clamp(zone, 0.0, 2.0), 0.0, 1.0) * 0.6;
float colBlend = clamp(colAmount / 100.0, 0.0, 1.0) * mix(0.45, 1.0, colSmooth / 100.0);
c = vec3(mix(ctr.x, yFilt, lumBlend), mix(ctr.yz, cFilt, colBlend));
`;

// Pass 3 — inverse: (VST-luma, Co, Cg) -> linear RGB. YCoCg inverse inlined.
const INVERSE_PASS = `
float Yv = c.x;
float Y = max((Yv * Yv * 0.25 - 0.375) / max(vstScale, 1e-3), 0.0);
float t = Y - c.z;
c = max(vec3(t + c.y, Y + c.z, t - c.y), 0.0);
`;

export const DENOISE_STAGE: ProcessingStageContribution = {
  id: BUILTIN_DENOISE_ID,
  name: "Noise Reduction",
  phase: "noise-reduction",
  priority: 50,
  // Inline: swap scene-linear `lin` for the denoised prepass result. `lin` is
  // already linear here (the main shader srgbToLinear's it when the source isn't),
  // and the prepass result is linear too, so they match regardless of source bit
  // depth. uDenoiseReady is set by the renderer to true only when the prepass
  // actually ran and produced a real float result — so a no-float-targets fallback
  // never corrupts the image. uDenoiseReady/uLuminanceNR/uColorNR are main-shader
  // globals (not stage uniforms), so they pass through unrewritten.
  glsl: `if (uDenoiseReady && (uLuminanceNR > 0.001 || uColorNR > 0.001)) { lin = max(stageResult, 0.0); }`,
  uniforms: [],
  passes: [
    { glsl: FORWARD_PASS, iterations: 1, uniforms: [
      { key: "vstScale", glslType: "float", default: VST_SCALE_DEFAULT },
    ] },
    { glsl: ATROUS_PASS, iterations: ATROUS_ITERATIONS, uniforms: [
      { key: "vstScale",      glslType: "float", default: VST_SCALE_DEFAULT },
      { key: "lumAmount",     glslType: "float", default: 0 },
      { key: "lumDetail",     glslType: "float", default: 50 },
      { key: "lumContrast",   glslType: "float", default: 0 },
      { key: "lumShadows",    glslType: "float", default: 0 },
      { key: "lumHighlights", glslType: "float", default: 0 },
      { key: "colAmount",     glslType: "float", default: 0 },
      { key: "colDetail",     glslType: "float", default: 50 },
      { key: "colSmooth",     glslType: "float", default: 50 },
    ] },
    { glsl: INVERSE_PASS, iterations: 1, uniforms: [
      { key: "vstScale", glslType: "float", default: VST_SCALE_DEFAULT },
    ] },
  ],
};

// Bridge the 8 typed Detail-panel NR params into the prepass param bag under the
// stage's qualified keys. Only emitted when the corresponding master amount is
// non-zero, so an untouched denoiser leaves the bag empty -> prepassActive() is
// false -> the whole prepass is skipped (zero cost). Merge over the existing bag.
export function denoiseBag(p: DevelopParams): Record<string, number> {
  const bag: Record<string, number> = {};
  if (p.luminanceNR > 0) {
    bag[`${BUILTIN_DENOISE_ID}.vstScale`] = VST_SCALE_DEFAULT;
    bag[`${BUILTIN_DENOISE_ID}.lumAmount`] = p.luminanceNR;
    bag[`${BUILTIN_DENOISE_ID}.lumDetail`] = p.luminanceNRDetail;
    bag[`${BUILTIN_DENOISE_ID}.lumContrast`] = p.luminanceNRContrast;
    bag[`${BUILTIN_DENOISE_ID}.lumShadows`] = p.luminanceNRShadows;
    bag[`${BUILTIN_DENOISE_ID}.lumHighlights`] = p.luminanceNRHighlights;
  }
  if (p.colorNR > 0) {
    bag[`${BUILTIN_DENOISE_ID}.vstScale`] = VST_SCALE_DEFAULT;
    bag[`${BUILTIN_DENOISE_ID}.colAmount`] = p.colorNR;
    bag[`${BUILTIN_DENOISE_ID}.colDetail`] = p.colorNRDetail;
    bag[`${BUILTIN_DENOISE_ID}.colSmooth`] = p.colorNRSmoothness;
  }
  return bag;
}
