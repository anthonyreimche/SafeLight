// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import {
  HSL_CHANNELS,
  MAX_MASK_COMPONENTS,
  MAX_MASKS,
  isDefaultHSL,
  isDefaultToneCurves,
  maskHasDisplayAdjustments,
  type DevelopParams,
  type MaskComponent,
} from "@/catalog/types";
import type { ProcessingStageContribution, UniformDeclaration } from "@/extensions/types";
import { buildMaskCurveLUT } from "../curve";

// Core's copies of the stages the Essentials that left core register, one set
// per release line (a line is the process version its text was written for;
// the extension's major version). The freeze installs line N for a version N
// photo (programSnapshot), and every other test that wants the shipped app
// installs the current line (builtinStages). ESSENTIAL_LINE_HASHES pins each
// copy; the extension's own tests pin its text with the same hashes, so the
// two can't drift apart unseen.

export type EssentialLine = 1 | 2 | 3;

/** A stage as the registry holds it: with the extension that registered it. */
export type InstalledStage = ProcessingStageContribution & { extensionId: string };

export const COLOR_GRADING_EXTENSION_ID = "safelight.color-grading";
export const EFFECTS_EXTENSION_ID = "safelight.effects";
export const HSL_EXTENSION_ID = "safelight.hsl";
export const TONE_CURVE_EXTENSION_ID = "safelight.tone-curve";
export const WHITE_BALANCE_EXTENSION_ID = "safelight.white-balance";
export const BASIC_EXTENSION_ID = "safelight.basic";
export const DETAIL_EXTENSION_ID = "safelight.detail";
export const CROP_EXTENSION_ID = "safelight.crop";
export const HEAL_EXTENSION_ID = "safelight.heal";
export const MASKS_EXTENSION_ID = "safelight.masks";

const float = (key: string): UniformDeclaration => ({ key, glslType: "float", default: 0 });

/** The same block on every line: it never differed between versions. Local
 *  tone reads the two sliders too (core-reads.ts). */
const whiteBalance = (): ProcessingStageContribution => ({
  id: "safelight.white-balance.balance",
  name: "White Balance",
  phase: "scene-linear",
  anchor: "white-balance",
  glsl: "lin = applyWhiteBalance(lin, uTemperature, uTint, uAsShotTemperature);",
  uniforms: [float("uTemperature"), float("uTint")],
  derive: (p) => ({ uTemperature: p.temperature, uTint: p.tint }),
});

const CG_UNIFORMS = [
  "uCGShadowHue",
  "uCGShadowSat",
  "uCGShadowLuma",
  "uCGMidHue",
  "uCGMidSat",
  "uCGMidLuma",
  "uCGHighHue",
  "uCGHighSat",
  "uCGHighLuma",
  "uCGGlobalHue",
  "uCGGlobalSat",
  "uCGGlobalLuma",
  "uCGShadowRange",
  "uCGHighlightRange",
].map(float);

const CG_HELPERS = `// Convert hue+sat to a neutral-axis RGB color offset (equilateral triangle projection).
// The three cosines are 120° apart so they always sum to zero — no net luminance shift.
vec3 cgWheelRGB(float hueDeg, float satPct) {
  if (satPct < 0.001) return vec3(0.0);
  float rad = hueDeg * 3.14159265358979 / 180.0;
  float s = satPct / 100.0 * 0.15; // max ±15% per channel at full saturation
  return vec3(
    cos(rad),
    cos(rad - 2.09439510239320), // 2π/3
    cos(rad - 4.18879020478640)  // 4π/3
  ) * s;
}

vec3 applyColorGrading(vec3 c) {
  float l = luma(c);
  // Shadow weight: peaks at black, falls off toward midtones.
  float shRange = max(uCGShadowRange, 0.05);
  float hiRange = max(uCGHighlightRange, 0.05);
  float shadowW    = 1.0 - smoothstep(0.0, shRange, l);
  shadowW          = shadowW * shadowW;
  float highlightW = smoothstep(1.0 - hiRange, 1.0, l);
  highlightW       = highlightW * highlightW;
  float midW       = clamp(1.0 - shadowW - highlightW, 0.0, 1.0);

  vec3 shColor  = cgWheelRGB(uCGShadowHue,  uCGShadowSat);
  vec3 midColor = cgWheelRGB(uCGMidHue,     uCGMidSat);
  vec3 hiColor  = cgWheelRGB(uCGHighHue,    uCGHighSat);
  vec3 glColor  = cgWheelRGB(uCGGlobalHue,  uCGGlobalSat);

  vec3 colorOffset = shadowW    * shColor
                   + midW       * midColor
                   + highlightW * hiColor
                   + glColor;  // global applied uniformly
  // Strip any net luminance the (weight-blended) offset introduced. cgWheelRGB is
  // luma-neutral per range, but the per-pixel weighting is not, so without this the
  // tint lifts/drops tones and washes out contrast/detail. Removing the luma term
  // keeps the change purely chromatic — color shifts, tonal structure is untouched.
  colorOffset -= vec3(luma(colorOffset));
  c += colorOffset;

  // Per-range luminance adjustments, scaled so ±100 → ±0.25 exposure-equivalent.
  float lumaAdj = shadowW    * (uCGShadowLuma / 100.0) * 0.25
                + midW       * (uCGMidLuma    / 100.0) * 0.25
                + highlightW * (uCGHighLuma   / 100.0) * 0.25
                + (uCGGlobalLuma / 100.0) * 0.25;
  c += vec3(lumaAdj);

  return clamp(c, 0.0, 1.0);
}`;

const TONE_CURVE_HELPERS = `vec3 applyToneCurve(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  // Per-channel LUTs packed into RGBA (master curve already composed in).
  c.r = texture(uCurve, vec2(c.r, 0.5)).r;
  c.g = texture(uCurve, vec2(c.g, 0.5)).g;
  c.b = texture(uCurve, vec2(c.b, 0.5)).b;
  return c;
}`;

/** Lines 2 and 3: from process version 2 a colour past either end of the
 *  table keeps its own excess; version 1 photos keep line 1's clip. */
const RANGED_TONE_CURVE_HELPERS = `vec3 applyToneCurve(vec3 c) {
#if SL_PROCESS_VERSION >= 2
  vec3 s = clamp(c, 0.0, 1.0);
  vec3 t = vec3(texture(uCurve, vec2(s.r, 0.5)).r, texture(uCurve, vec2(s.g, 0.5)).g, texture(uCurve, vec2(s.b, 0.5)).b);
  return t + (c - s);
#else
  c = clamp(c, 0.0, 1.0);
  // Per-channel LUTs packed into RGBA (master curve already composed in).
  c.r = texture(uCurve, vec2(c.r, 0.5)).r;
  c.g = texture(uCurve, vec2(c.g, 0.5)).g;
  c.b = texture(uCurve, vec2(c.b, 0.5)).b;
  return c;
#endif
}`;

/** Bumped for every table derived, so the renderer uploads each new one. */
let curveVersion = 0;

/** Line 1 runs the curves on every pixel; later lines skip default curves.
 *  Each clips its input to read its table. */
const toneCurve = (line: EssentialLine): ProcessingStageContribution => ({
  id: "safelight.tone-curve.curve",
  name: "Tone Curve",
  phase: "display-adjust",
  anchor: "tone-curve",
  textures: [{ key: "uCurve", kind: "photo" }],
  ...(line === 1
    ? { glsl: "c = applyToneCurve(c);", helpers: TONE_CURVE_HELPERS, uniforms: [] }
    : {
        glsl: "if (uCurveActive) c = applyToneCurve(c);",
        helpers: RANGED_TONE_CURVE_HELPERS,
        uniforms: [{ key: "uCurveActive", glslType: "bool", default: false }],
      }),
  derive: ({ toneCurve: curves }) => ({
    uCurve: { data: buildMaskCurveLUT(curves), width: 256, height: 1, format: "rgba8", version: ++curveVersion },
    ...(line === 1 ? {} : { uCurveActive: !isDefaultToneCurves(curves) }),
  }),
});

const HSL_BANDS = (key: string): UniformDeclaration => ({
  key,
  glslType: "float",
  length: 8,
  default: [0, 0, 0, 0, 0, 0, 0, 0],
});

/** The bands, then Preferences ▸ HSL's band shaping (Colour range,
 *  Smoothness), which used to be the program's own uniforms. */
const HSL_UNIFORMS: UniformDeclaration[] = [
  ...["uHslHue", "uHslSat", "uHslLum"].map(HSL_BANDS),
  { key: "uHslRange", glslType: "float", default: 1 },
  { key: "uHslSmooth", glslType: "float", default: 1 },
];

const HSL_CHANNEL_KEYS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;

const HSL_HELPERS = `vec3 applyHSL(vec3 c) {
  vec3 hsl = rgb2hsl(c);
  // Protect near-neutral pixels: an achromatic pixel has no real hue (rgb2hsl
  // reports 0 = red), so without this gate the Red sliders would tint/relight
  // every grey. Fades the whole effect in over a low saturation threshold, so
  // genuinely coloured pixels (even pale skies/skin) still respond fully.
  float chromaW = smoothstep(0.0, 0.10, hsl.y);
  if (chromaW < 1e-4) return c;

  float hueDeg = hsl.x * 360.0;

  float hueShift = 0.0;
  float satAdj = 0.0;
  float lumAdj = 0.0;
  for (int i = 0; i < 8; i++) {
    float wi = hslBandWeight(hueDeg, HSL_CENTERS[i], HSL_DPREV[i], HSL_DNEXT[i], uHslRange, uHslSmooth);
    hueShift += uHslHue[i] * wi;
    satAdj   += uHslSat[i] * wi;
    lumAdj   += uHslLum[i] * wi;
  }
  hueShift *= chromaW;
  satAdj   *= chromaW;
  lumAdj   *= chromaW;

  // Hue: rotate in HSL (luminance-invariant), ±30° at full slider.
  hsl.x = fract(hsl.x + hueShift * (30.0 / 360.0));
  vec3 rgb = hsl2rgb(hsl);

  // Saturation: perceptual. Scale chroma around the pixel's true luminance, so a
  // cut collapses the colour to its actual grey (not HSL-L's mid-range grey) and
  // a boost doesn't clip the bright channel into a different hue on the way up.
  if (abs(satAdj) > 1e-4) {
    float Lp = luma(rgb);
    rgb = mix(vec3(Lp), rgb, clamp(1.0 + satAdj, 0.0, 2.0));
  }

  // Luminance: hue-preserving gain (ratio-scale). Darkening a blue sky or lifting
  // reds keeps the hue and per-channel saturation intact, unlike an HSL-L add
  // which greys and shifts the colour. Gentle factor so shadows don't blow out.
  if (abs(lumAdj) > 1e-4) {
    rgb *= 1.0 + lumAdj * 0.6;
  }

  return clamp(rgb, 0.0, 1.0);
}`;

const preference = (value: unknown, min: number, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value / 100)) : 1;

/** Line 1 mixes every pixel; later lines skip default bands, and clip what
 *  they mix. */
const hsl = (line: EssentialLine): ProcessingStageContribution => ({
  id: "safelight.hsl.mix",
  name: "HSL",
  phase: "display-adjust",
  anchor: "hsl",
  ...(line === 1
    ? { glsl: "c = applyHSL(c);", helpers: HSL_HELPERS, uniforms: HSL_UNIFORMS }
    : {
        glsl: "if (uHslActive) c = applyHSL(clamp(c, 0.0, 1.0));",
        helpers: HSL_HELPERS,
        uniforms: [...HSL_UNIFORMS, { key: "uHslActive", glslType: "bool", default: false }],
      }),
  derive: ({ hsl: h }, ctx) => ({
    uHslHue: HSL_CHANNEL_KEYS.map((ch) => h.hue[ch] / 100),
    uHslSat: HSL_CHANNEL_KEYS.map((ch) => h.saturation[ch] / 100),
    uHslLum: HSL_CHANNEL_KEYS.map((ch) => h.luminance[ch] / 100),
    uHslRange: preference(ctx.settings("hueRange", 100), 0.25, 2),
    uHslSmooth: preference(ctx.settings("smoothness", 100), 0, 1),
    ...(line === 1
      ? {}
      : {
          uHslActive: (["hue", "saturation", "luminance"] as const).some((band) =>
            HSL_CHANNEL_KEYS.some((ch) => h[band][ch] !== 0),
          ),
        }),
  }),
});

/** Line 1 runs the wheels on every pixel; later lines skip them at identity,
 *  and clip only what they grade. */
const colorGrading = (line: EssentialLine): ProcessingStageContribution => ({
  id: "safelight.color-grading.grade",
  name: "Colour Grading",
  phase: "display-adjust",
  anchor: "color-grading",
  ...(line === 1
    ? { glsl: "c = applyColorGrading(c);", helpers: CG_HELPERS, uniforms: CG_UNIFORMS }
    : {
        glsl: "if (uColorGradingActive) c = applyColorGrading(clamp(c, 0.0, 1.0));",
        helpers: CG_HELPERS,
        uniforms: [...CG_UNIFORMS, { key: "uColorGradingActive", glslType: "bool", default: false }],
      }),
  derive: ({ colorGrading: cg }) => ({
    uCGShadowHue: cg.shadows.hue,
    uCGShadowSat: cg.shadows.sat,
    uCGShadowLuma: cg.shadows.luma,
    uCGMidHue: cg.midtones.hue,
    uCGMidSat: cg.midtones.sat,
    uCGMidLuma: cg.midtones.luma,
    uCGHighHue: cg.highlights.hue,
    uCGHighSat: cg.highlights.sat,
    uCGHighLuma: cg.highlights.luma,
    uCGGlobalHue: cg.global.hue,
    uCGGlobalSat: cg.global.sat,
    uCGGlobalLuma: cg.global.luma,
    uCGShadowRange: cg.shadowRange / 100,
    uCGHighlightRange: cg.highlightRange / 100,
    ...(line === 1
      ? {}
      : {
          uColorGradingActive: ![cg.shadows, cg.midtones, cg.highlights, cg.global].every(
            (r) => r.sat < 0.001 && r.luma === 0,
          ),
        }),
  }),
});

/** How the Effects helpers end: line 1 clips what they made, as core's
 *  Vignette and Grain did on a version 1 photo; later lines pass it on. */
const effectsReturn = (line: EssentialLine): string => (line === 1 ? "return clamp(c, 0.0, 1.0);" : "return c;");

const vignette = (line: EssentialLine): ProcessingStageContribution => ({
  id: "safelight.effects.vignette",
  name: "Vignette",
  phase: "effects",
  priority: 50,
  glsl: `c = applyVignette(c, vUv);`,
  helpers: `vec3 applyVignette(vec3 c, vec2 uv) {
  if (abs(uVignetteAmount) < 0.001) return c;
  vec2 centered = uv - 0.5;
  float roundness = uVignetteRoundness / 100.0;
  float rx = abs(centered.x);
  float ry = abs(centered.y);
  float rect = max(rx, ry);
  float circ = length(centered);
  float r = mix(rect, circ, clamp(roundness + 0.5, 0.0, 1.0)) * 2.0;
  float midpoint = mix(0.5, 1.5, 1.0 - uVignetteMidpoint / 100.0);
  float feather = mix(0.05, 0.95, uVignetteFeather / 100.0);
  float lo = max(0.0, midpoint - feather * 0.5);
  float hi = midpoint + feather * 0.5;
  float edge = smoothstep(lo, hi, r);
  float vigAmt = uVignetteAmount / 100.0;
  float darkening = vigAmt < 0.0 ? -vigAmt * edge : 0.0;
  float lightening = vigAmt > 0.0 ?  vigAmt * edge : 0.0;
  float hlProtect = uVignetteHighlights > 0.001
    ? clamp(luma(c) * (uVignetteHighlights / 100.0) * 2.0, 0.0, 1.0)
    : 0.0;
  darkening *= (1.0 - hlProtect);
  c = c * (1.0 - darkening) + c * lightening;
  ${effectsReturn(line)}
}`,
  uniforms: [
    { key: "uVignetteAmount", glslType: "float", default: 0, range: { min: -100, max: 100 }, label: "Amount" },
    { key: "uVignetteMidpoint", glslType: "float", default: 50, range: { min: 0, max: 100 }, label: "Midpoint" },
    { key: "uVignetteRoundness", glslType: "float", default: 0, range: { min: -100, max: 100 }, label: "Roundness" },
    { key: "uVignetteFeather", glslType: "float", default: 50, range: { min: 0, max: 100 }, label: "Feather" },
    { key: "uVignetteHighlights", glslType: "float", default: 0, range: { min: 0, max: 100 }, label: "Highlights" },
  ],
  derive: ({ vignette: v }) => ({
    uVignetteAmount: v.amount,
    uVignetteMidpoint: v.midpoint,
    uVignetteRoundness: v.roundness,
    uVignetteFeather: v.feather,
    uVignetteHighlights: v.highlights,
  }),
});

const grain = (line: EssentialLine): ProcessingStageContribution => ({
  id: "safelight.effects.grain",
  name: "Grain",
  phase: "effects",
  priority: 60,
  glsl: `c = applyGrain(c, vUv);`,
  helpers: `float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float gaussGrain(vec2 seed) {
  float u1 = max(grainHash(seed), 1e-6);
  float u2 = grainHash(seed + vec2(127.1, 311.7));
  return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}

float grainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float g00 = gaussGrain(i);
  float g10 = gaussGrain(i + vec2(1.0, 0.0));
  float g01 = gaussGrain(i + vec2(0.0, 1.0));
  float g11 = gaussGrain(i + vec2(1.0, 1.0));
  return mix(mix(g00, g10, f.x), mix(g01, g11, f.x), f.y);
}

vec3 applyGrain(vec3 c, vec2 uv) {
  if (uGrainAmount < 0.001) return c;
  float amount = uGrainAmount / 100.0;
  float sizeT = (uGrainSize - 25.0) / 75.0;
  float rough = uGrainRoughness / 100.0;
  float chromaVar = uGrainColor / 100.0;
  float freq = mix(1400.0, 200.0, sizeT * sizeT);
  vec2 guv = vec2(uv.x * uImageAspect, uv.y) * freq;
  float L = luma(c);
  float density = mix(0.08, 1.0, sqrt(clamp(L, 0.0, 1.0)));
  float sigma = amount * density * 0.14;
  if (chromaVar < 0.01) {
    float n = grainNoise(guv);
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      n += grainNoise(guv * 2.17 + 17.3) * 0.5 * t;
    }
    c += vec3(n * sigma);
  } else {
    float rFreq = 1.0 + 0.25 * chromaVar;
    float bFreq = 1.0 - 0.15 * chromaVar;
    float nR = grainNoise(guv * rFreq);
    float nG = grainNoise(guv + vec2(43.7, 91.3));
    float nB = grainNoise(guv * bFreq + vec2(71.9, 37.1));
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      nR += grainNoise(guv * rFreq * 2.17 + 17.3) * 0.5 * t;
      nG += grainNoise((guv + vec2(43.7, 91.3)) * 2.17 + 17.3) * 0.5 * t;
      nB += grainNoise((guv * bFreq + vec2(71.9, 37.1)) * 2.17 + 17.3) * 0.5 * t;
    }
    c.r += nR * sigma;
    c.g += nG * sigma;
    c.b += nB * sigma;
  }
  ${effectsReturn(line)}
}`,
  uniforms: [
    { key: "uGrainAmount", glslType: "float", default: 0, range: { min: 0, max: 100 }, label: "Amount" },
    { key: "uGrainSize", glslType: "float", default: 25, range: { min: 25, max: 100 }, label: "Size" },
    { key: "uGrainRoughness", glslType: "float", default: 50, range: { min: 0, max: 100 }, label: "Roughness" },
    { key: "uGrainColor", glslType: "float", default: 0, range: { min: 0, max: 100 }, label: "Color" },
  ],
  derive: ({ grain: g }) => ({
    uGrainAmount: g.amount,
    uGrainSize: g.size,
    uGrainRoughness: g.roughness,
    uGrainColor: g.color,
  }),
});

/** A line's text where version 1's and version 2's differ (variantGuards). */
function guards(line: EssentialLine) {
  const v2 = (glsl: string): string => (line >= 2 ? glsl : "");
  const pick = (v1Glsl: string, v2Glsl: string): string => (line >= 2 ? v2Glsl : v1Glsl);
  const clampInput = v2("\n    c = clamp(c, 0.0, 1.0);");
  return { v2, pick, clampInput };
}

// Process version 2's tone block: version 1's curves (local-tone.ts) on the
// pixel and, while Highlights or Shadows is moved, on the pixel's region too,
// keeping the pixel's ratio to it and blended in with the slider. Between the
// two, the camera match's shadows lift goes on each pixel and its region by
// their own levels, as the match fitted it (raw/camera-match.ts): through the
// region's ratio it would raise bright detail with its darker surroundings.
const V2_TONE_BLOCK = `  {
    float L = max(luma(lin), 1e-4);
    float Lx = L * exp2(E);
    float L1 = slToneHighlights(Lx, E, H);
    float cameraLift = uApplyBaseCurve ? uBaselineShadows : 0.0;
    float L2 = basicShadows(slToneShadows(L1, cameraLift), S);
    float curveRatio = 1.0;
    if (abs(H) > 0.001 || abs(S) > 0.001) {
      // Floored after Exposure (as localToneBlend is): under the curves' own
      // 1e-4 floor a region's Shadows gain would grow as Exposure goes down.
      float Bx = max(slLocalToneBase(srcUv, L) * exp2(E), 1e-4);
      float B1 = slToneHighlights(Bx, E, H);
      // The Highlights curve over the default one, for the pixel and for its
      // region, blended as L1 is below. L1 is still the pixel's curve here.
      if (abs(H) > 0.001) {
        curveRatio = mix(
          L1 / slToneHighlights(Lx, E, 0.0),
          B1 / slToneHighlights(Bx, E, 0.0), abs(H));
      }
      L1 = mix(L1, Lx * B1 / Bx, abs(H));
      float C1 = slToneShadows(L1, cameraLift);
      float CB = slToneShadows(B1, cameraLift);
      L2 = mix(basicShadows(C1, S), C1 * basicShadows(CB, S) / CB, abs(S));
    }
    // slSceneLuma undoes only the default shoulder, on the same pixel/region
    // blend the edit above used, so Highlights carries into it.
    if (uApplyToneShoulder) slShoulderGain = Lx * curveRatio / max(L1, 1e-6);
    lin = retargetLuma(lin, L, L2);
    // Hunt effect: restore colourfulness lost by pulling bright values down.
    if (H < -0.001) {
      float pulled = clamp(Lx - L1, 0.0, 1.0);
      lin = mix(vec3(luma(lin)), lin, 1.0 + pulled * HI_SAT);
    }
  }`;

// The Shadows slider from version 2 on (local-tone.ts basicShadows is its
// twin): version 1's curve at ±50, its gain in stops times 2|S|, fading out
// over the 3.5 stops below mid grey. Version 1 photos keep slToneShadows.
const BASIC_TONE_HELPERS = `float basicShadows(float x, float S) {
#if SL_PROCESS_VERSION >= 2
  if (abs(S) <= 0.001) return x;
  float x0 = max(x, 1e-4);
  float w = 0.5 * exp(-3.0 * x0);
  float halfGain = 1.0 - w + w * pow(x0, S > 0.0 ? -0.175 : 0.4);
  float reach = 1.0 - smoothstep(-3.5, 0.0, log2(x0 / 0.18));
  return x0 * pow(halfGain, 2.0 * abs(S) * reach);
#else
  return slToneShadows(x, S);
#endif
}`;

const SHOULDER_GAIN_DECL = "\n  float slShoulderGain = 1.0;";

const basicTone = (line: EssentialLine): string => {
  const { v2, pick } = guards(line);
  return `  // Integrated tonal pipeline: exposure, highlights, and shadows are applied as
  // a single shoulder-based tone map instead of sequential independent operations.
  // Where the shoulder applies, exposure can't create unbounded values (no
  // blow-out); a display transform that skips it takes that headroom instead.
  // Either way highlight recovery works even at high exposure (+3..+5 EV).
  float E = uExposure;
  float H = clamp(uHighlights / 100.0, -1.0, 1.0);
  float S = clamp(uShadows / 100.0, -1.0, 1.0);${v2(SHOULDER_GAIN_DECL)}
  ${pick(`{
    float L = max(luma(lin), 1e-4);

    // Exposure: true linear gain (×2 per stop)
    float Lx = L * exp2(E);

    // Filmic shoulder: piecewise curve — linear below knee, smooth Reinhard
    // compression above, keeping blown values out of display space wherever
    // it applies. Highlights slider controls the knee position:
    //   H < 0 (recover): lower knee → more of the range gets compressed
    //   H > 0 (brighten): raise knee → more headroom before compression
    float knee = 0.85;
    float rolloff = 0.5;
    if (H < 0.0) {
      knee = mix(0.85, 0.15, -H);
      rolloff = mix(0.5, 0.2, -H);
    } else if (H > 0.0) {
      knee = mix(0.85, 2.0, H);
      rolloff = mix(0.5, 1.5, H);
    }
    // Slope at the knee is (1-knee)/rolloff; clamp so it never exceeds 1.0,
    // otherwise midtones just above a low knee get lifted instead of compressed.
    rolloff = max(rolloff, 1.0 - knee);
    // Scale rolloff with sqrt of gain — enough to preserve highlight separation
    // at moderate exposure but lets high exposure (+5) push the image toward white
    rolloff *= max(exp2(max(E, 0.0) * 0.5), 1.0);

    float Lsc = Lx;
    if (Lx > knee) {
      float excess = Lx - knee;
      Lsc = knee + (1.0 - knee) * excess / (excess + rolloff);
    }
    // A transform with its own roll-off keeps the headroom: only recovery
    // (H < 0) blends the shoulder back in, in proportion to the slider.
    if (!uApplyToneShoulder) Lsc = mix(Lx, Lsc, max(-H, 0.0));

    lin = retargetLuma(lin, L, Lsc);

    // Hunt effect: restore colourfulness lost by pulling bright values down
    if (H < -0.001 && Lx > knee) {
      float pulled = clamp(Lx - Lsc, 0.0, 1.0);
      float Lr = luma(lin);
      lin = mix(vec3(Lr), lin, 1.0 + pulled * HI_SAT);
    }

    // Highlight lift (H > 0): gamma brighten the upper zone
    if (H > 0.001) {
      float Lcur = max(luma(lin), 1e-4);
      float hw = smoothstep(0.3, 0.9, Lcur);
      float gamma = mix(1.0, 0.5, H);
      float newLcur = mix(Lcur, pow(Lcur, gamma), hw * H);
      // The gamma lift darkens values above white; without the shoulder those
      // are the transform's headroom, so the lift may only brighten.
      if (!uApplyToneShoulder) newLcur = max(newLcur, Lcur);
      lin = retargetLuma(lin, Lcur, newLcur);
    }

    // Shadows: gamma toe weighted toward the dark end, fading out in highlights
    if (abs(S) > 0.001) {
      float Lcur = max(luma(lin), 1e-4);
      float shW = exp(-3.0 * Lcur);
      float gamma = S > 0.0 ? mix(1.0, 0.65, S) : mix(1.0, 1.8, -S);
      float newLcur = mix(Lcur, pow(Lcur, gamma), shW * abs(S));
      lin = retargetLuma(lin, Lcur, newLcur);
    }
  }`, V2_TONE_BLOCK)}`;
};

const basicDisplay = (line: EssentialLine): string => {
  const { clampInput } = guards(line);
  return `  // Whites (display space): endpoint control for the bright end.
  // Gamma-based adjustment weighted by cubic peaking at white.
  if (abs(uWhites) > 0.001) {${clampInput}
    float wAmt = uWhites / 100.0;
    float L = max(luma(c), 1e-4);
    float wW = L * L * L;
    float gamma = wAmt > 0.0 ? mix(1.0, 0.5, wAmt) : mix(1.0, 1.9, -wAmt);
    float newL = mix(L, pow(L, gamma), wW);
    c = c * (newL / L);
    c = clamp(c, 0.0, 1.0);
  }

  // Blacks (display space): endpoint control for the dark end.
  // Gamma-based adjustment weighted by cubic peaking at black.
  if (abs(uBlacks) > 0.001) {${clampInput}
    float bAmt = uBlacks / 100.0;
    float L = max(luma(c), 1e-4);
    float bW = (1.0 - L) * (1.0 - L) * (1.0 - L);
    float gamma = bAmt > 0.0 ? mix(1.0, 0.55, bAmt) : mix(1.0, 2.2, -bAmt);
    float newL = mix(L, pow(L, gamma), bW);
    c = c * (newL / L);
    c = clamp(c, 0.0, 1.0);
  }

  // Contrast: luminance-based S-curve (always safe: display values in [0,1]).
  float ck = (uContrast / 100.0) * 0.8;
  if (abs(ck) > 0.001) {${clampInput}
    float L = luma(c);
    float Lnew = clamp(L + ck * L * (1.0 - L) * (2.0 * L - 1.0), 0.0, 1.0);
    c = c * (Lnew / max(L, 1e-4));
    c = clamp(c, 0.0, 1.0);
  }`;
};

const basicPresence = (line: EssentialLine): string => {
  const { clampInput } = guards(line);
  return `  // Dehaze: dark channel prior with global atmospheric light estimate.
  if (abs(dehAmt) > 0.001) {${clampInput}
    // Local dark channel from a medium blur
    vec3 localBlur = textureLod(uImage, srcUv, 4.0).rgb;
    if (!uLinear) localBlur = srgbToLinear(localBlur);
    localBlur = linearToSrgbU(localBlur);
    float dc = min(min(localBlur.r, localBlur.g), localBlur.b);
    // Atmospheric light: global estimate from the coarsest mip
    vec3 globalBlur = textureLod(uImage, vec2(0.5, 0.5), 9.0).rgb;
    if (!uLinear) globalBlur = srgbToLinear(globalBlur);
    globalBlur = linearToSrgbU(globalBlur);
    float A = clamp(max(max(globalBlur.r, globalBlur.g), globalBlur.b), 0.5, 0.98);
    // Transmission: normalize dark channel by atmospheric light
    float t_est = clamp(1.0 - dehAmt * 1.2 * dc / max(A, 0.5), 0.12, 1.0);
    c = (c - vec3(A) * (1.0 - t_est)) / max(t_est, 0.12);
    // Saturation restoration: haze washes out color
    float dl = luma(c);
    c = mix(vec3(dl), c, 1.0 + dehAmt * 0.4);
    c = clamp(c, 0.0, 1.0);
  }
  // Clarity: broad local contrast, midtone-focused. A plain broad mip blur
  // averages ACROSS hard edges, so rawLuma - blur overshoots in a band as wide
  // as the blur radius -- that band IS the halo, and masking/clamping it can only
  // attenuate, never remove it. The fix is to make the broad reference EDGE-AWARE:
  // a bilateral blur over 16 mip-blurred taps (two rings), each weighted by luma
  // similarity to the centre so taps across an edge are dropped. The reference
  // then tracks the local side of every boundary, rawLuma - base is ~0 at edges
  // (no ring), and only within-region midtone texture is lifted. CLAR_EDGE is the
  // edge stop: smaller = holds edges harder (less halo), larger = smoother.
  float midMask = 1.0 - pow(clamp(abs(luma(c) - 0.5) * 1.6, 0.0, 1.0), 3.0);
  if (abs(clarAmt) > 0.001) {
    // Edge-aware reference. Each broad tap is blended TOWARD the centre by its
    // luma-similarity weight: a same-side tap contributes its value, a tap across
    // an edge (incl. a mip tap that straddles one) contributes the centre value
    // instead. So the reference equals the local side at every boundary -- no
    // cross-edge averaging (no halo) and no pull from intermediate taps (no ghost
    // outline). rawLuma - base is ~0 at edges and in flats, nonzero only for
    // within-region midtone texture. CLAR_EDGE = edge stop (smaller = stricter).
    const float CLAR_EDGE = 0.08;
    float cen = rawLuma;
    float base = cen;            // centre tap
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981634;   // i * 2*pi/8
      vec2 dir = vec2(cos(a), sin(a));
      float s1 = lumaLod(srcUv + dir * 0.016, 3.0);
      float w1 = exp(-(s1 - cen) * (s1 - cen) / (2.0 * CLAR_EDGE * CLAR_EDGE));
      base += mix(cen, s1, w1);
      float s2 = lumaLod(srcUv + dir * 0.034, 4.0);
      float w2 = exp(-(s2 - cen) * (s2 - cen) / (2.0 * CLAR_EDGE * CLAR_EDGE));
      base += mix(cen, s2, w2);
    }
    base /= 17.0;               // centre + 16 taps
    c += (cen - base) * clarAmt * 1.5 * midMask;
  }
  // Texture: edge-aware micro-detail (LOD 0.75) — fine surface detail like
  // skin pores and fabric weave, suppressed at strong edges to avoid halos.
  if (abs(texAmt) > 0.001) {
    float fineBlur = lumaLod(srcUv, 0.75);
    float texDetail = rawLuma - fineBlur;
    float broadBlur = lumaLod(srcUv, 2.5);
    float edgeStrength = abs(rawLuma - broadBlur);
    float edgeMask = 1.0 - smoothstep(0.02, 0.12, edgeStrength);
    texDetail = clamp(texDetail, -0.08, 0.08);
    c += texDetail * texAmt * 2.5 * edgeMask;
  }`;
};

const basicBandDetail = (line: EssentialLine): string => {
  const { pick } = guards(line);
  return `  // Band-limited detail (highlight / shadow). Tonal recovery and lift compress a
  // luminance band, which dulls its micro-contrast (cloud texture, shadow detail).
  // A luminance curve can't add it back without also moving other tones that overlap
  // in luma (sky vs lit foliage), so restore LOCAL contrast instead — confined to the
  // band where the pixel ended up, clamped to limit edge overshoot (anti-halo).
  //
  // Each band's gain = an auto term (engaged by recovery/lift so a tone move never
  // flattens texture on its own) + the user's Highlight/Shadow Detail slider
  // (bidirectional: + crisper, - smoother). At the slider's default of 0 the highlight
  // term is identical to the original recovery-coupled restore. The shadow auto term is
  // gentler than the highlight one because the dark band is where sensor noise lives.
  // Version 2's Highlights and Shadows keep texture themselves (local-tone.ts), so
  // there each band's gain is its Detail slider alone.
  float bandDet = clamp(rawLuma - lumaLod(srcUv, 2.0), -0.15, 0.15);
  float hiGain = ${pick("(H < 0.0 ? -H : 0.0) + ", "")}uHighlightDetail / 100.0;
  if (abs(hiGain) > 0.001) {
    float hiZone = smoothstep(0.45, 0.78, luma(c));
    c += bandDet * hiGain * hiZone * BAND_DETAIL;
  }
  float shGain = ${pick("(S > 0.0 ? 0.5 * S : 0.0) + ", "")}uShadowDetail / 100.0;
  if (abs(shGain) > 0.001) {
    float shZone = 1.0 - smoothstep(0.12, 0.45, luma(c));
    c += bandDet * shGain * shZone * BAND_DETAIL;
  }
  ${pick("c = clamp(c, 0.0, 1.0);", "")}`;
};

const basicVibrance = (line: EssentialLine): string => {
  const { pick } = guards(line);
  return `  ${pick(
    "c = applyVibSat(c, uVibrance, uSaturation);",
    `if (abs(uVibrance) >= 0.1 || abs(uSaturation) > 0.1)
    c = applyVibSat(c, uVibrance, uSaturation);`,
  )}`;
};

/** One of Basic's blocks: its uniforms are DevelopParams fields bound as they are. */
const basicStage = (
  id: string,
  name: string,
  phase: ProcessingStageContribution["phase"],
  anchor: NonNullable<ProcessingStageContribution["anchor"]>,
  fields: Record<string, keyof DevelopParams>,
  glsl: string,
  helpers?: string,
): ProcessingStageContribution => ({
  id,
  name,
  phase,
  anchor,
  glsl,
  ...(helpers ? { helpers } : {}),
  uniforms: Object.keys(fields).map(float),
  derive: (p) => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, p[field] as number])),
});

/** Line 1 is version 1's text; lines 2 and 3 are version 2's. The tone block
 *  declares what core's program reads after it (core-reads.ts). */
const basic = (line: EssentialLine): ProcessingStageContribution[] => [
  basicStage("safelight.basic.tone", "Exposure, Highlights & Shadows", "scene-linear", "tone",
    { uExposure: "exposure", uHighlights: "highlights", uShadows: "shadows" }, basicTone(line),
    line >= 2 ? BASIC_TONE_HELPERS : undefined),
  basicStage("safelight.basic.display", "Whites, Blacks & Contrast", "display-adjust", "display-basic",
    { uWhites: "whites", uBlacks: "blacks", uContrast: "contrast" }, basicDisplay(line)),
  basicStage("safelight.basic.presence", "Dehaze, Clarity & Texture", "display-adjust", "presence",
    { uTexture: "texture", uClarity: "clarity", uDehaze: "dehaze" }, basicPresence(line)),
  basicStage("safelight.basic.band-detail", "Highlight & Shadow Detail", "display-adjust", "band-detail",
    { uHighlightDetail: "highlightDetail", uShadowDetail: "shadowDetail" }, basicBandDetail(line)),
  basicStage("safelight.basic.vibrance", "Vibrance & Saturation", "display-adjust", "vibrance",
    { uVibrance: "vibrance", uSaturation: "saturation" }, basicVibrance(line)),
];

/** The same block on every line. It declares sharpenViz, which core's preview
 *  output reads (core-reads.ts). */
const DETAIL_SHARPEN = `  // Capture sharpening with radius, detail (halo control), and edge masking.
  // Runs after vibrance/saturation so sharpening halos are not re-saturated.
  // sharpenViz carries the grayscale preview value when uSharpenViz is active;
  // the block also runs at amount 0 in that case so the preview is always live.
  float sharpenViz = 0.0;
  float sharpen = uSharpening / 100.0;
  if (sharpen > 0.001 || uSharpenViz > 0) {
    float lod = mix(0.5, 1.5, (uSharpenRadius - 1.0) / 2.0);
    float blur = lumaLod(srcUv, lod);
    float detail = rawLuma - blur;
    float detailFactor = uSharpenDetail / 100.0;
    float broadBlur = lumaLod(srcUv, lod + 1.0);
    detail = mix((rawLuma - broadBlur) * 0.35, detail, detailFactor);
    float mask = 1.0;
    if (uSharpenMasking > 0.001) {
      float edgeMag = abs(rawLuma - lumaLod(srcUv, 0.5));
      float threshold = (uSharpenMasking / 100.0) * 0.12;
      mask = smoothstep(threshold * 0.4, threshold, edgeMag);
    }
    if (sharpen > 0.001) c += detail * sharpen * 1.6 * mask;
    if (uSharpenViz == 1) sharpenViz = mask;                          // masking coverage
    else if (uSharpenViz == 2) sharpenViz = clamp(0.5 + detail * 4.0, 0.0, 1.0); // edge signal
    else if (uSharpenViz == 3) sharpenViz = luma(clamp(c, 0.0, 1.0)); // sharpened luminance
  }`;

const sharpen = (): ProcessingStageContribution => ({
  id: "safelight.detail.sharpen",
  name: "Sharpening",
  phase: "display-adjust",
  anchor: "sharpen",
  glsl: DETAIL_SHARPEN,
  uniforms: [float("uSharpening"), float("uSharpenRadius"), float("uSharpenDetail"), float("uSharpenMasking")],
  derive: (p) => ({
    uSharpening: p.sharpening,
    uSharpenRadius: p.sharpenRadius,
    uSharpenDetail: p.sharpenDetail,
    uSharpenMasking: p.sharpenMasking,
  }),
});

/** Crop & Straighten's geometry: declarations only, at the geometry anchor,
 *  for main()'s `vec2 srcUv = cropTransformUV(viewUv);`. The same on every
 *  line. */
const CROP_HELPERS = `// The view's point (output, crop coordinates) to source UV: through the crop
// to the transformed image, then the geometry transform's inverse (straighten,
// perspective, stretch, scale, offset), which is independent of the crop. vUv
// already has V flipped, so both are in top-left-origin image space.
vec2 cropTransformUV(vec2 o) {
  vec2 p = uCrop.xy + o * uCrop.zw;
  vec3 q = uInvTransform * vec3(p, 1.0);
  return q.xy / q.z;
}`;

type Mat3 = [number, number, number, number, number, number, number, number, number];
const mul = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
const diag = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1];

/** The transformed image to the source, as an image-space matrix: rotation,
 *  flips, keystone, stretch and scale in square space, the offset in image
 *  coordinates. */
const inverseParts = (straighten: number, t: DevelopParams["transform"]) => {
  const theta = (straighten * Math.PI) / 180;
  const rot: Mat3 = [Math.cos(theta), -Math.sin(theta), 0, Math.sin(theta), Math.cos(theta), 0, 0, 0, 1];
  const gh = (t.perspectiveH / 100) * 0.6;
  const gv = (t.perspectiveV / 100) * 0.6;
  const as = Math.pow(1.5, t.aspect / 100);
  const sc = Math.pow(2, (t.scale - 100) / 200);
  let square = mul(rot, diag(t.flipH ? -1 : 1, t.flipV ? -1 : 1));
  square = mul(square, [1, 0, 0, 0, 1, 0, -gh, -gv, 1]);
  square = mul(square, diag(1 / as, as));
  square = mul(square, diag(1 / sc, 1 / sc));
  const normalized: Mat3 = [1, 0, -(t.offsetX / 100) * 0.5, 0, 1, -(t.offsetY / 100) * 0.5, 0, 0, 1];
  return { square, normalized };
};

const cropGeometry = (): ProcessingStageContribution => ({
  id: "safelight.crop.geometry",
  name: "Crop & Straighten",
  phase: "geometry",
  anchor: "geometry",
  glsl: "",
  helpers: CROP_HELPERS,
  uniforms: [
    { key: "uCrop", glslType: "vec4", default: [0, 0, 1, 1] },
    { key: "uInvTransform", glslType: "mat3", space: "image", default: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  ],
  geometry: { region: "uCrop", inverse: "uInvTransform" },
  derive: (p) => ({
    uCrop: [p.crop.x, p.crop.y, p.crop.width, p.crop.height],
    uInvTransform: inverseParts(p.straighten, p.transform),
  }),
});

/** Heal's spots: declarations only, at the retouch anchor, for main()'s
 *  `src = applyRetouch(srcUv, src);` and the patch pass. Line 1 clips a heal's
 *  recoloured source to [0, 1]; later lines keep a linear source's range. */
const healSourceColour = (line: EssentialLine): string =>
  line === 1
    ? "clamp(textureLod(uImage, sUv, 0.0).rgb + corr, 0.0, 1.0);"
    : `textureLod(uImage, sUv, 0.0).rgb + corr;
    // A display-encoded source holds nothing outside [0, 1], and its decode
    // (srgbToLinear) is undefined below -0.055, which the correction can reach.
    if (!uLinear) srcCol = clamp(srcCol, 0.0, 1.0);`;

const healHelpers = (line: EssentialLine): string => `// ---- Retouch: spot heal / clone -------------------------------------------
// Closed-form gradient-domain (membrane) correction for a heal spot. Samples the
// boundary mismatch (destination - source) just outside the disc and interpolates
// it across the interior with inverse-distance (Shepard) weights — a smooth
// low-frequency field that makes the copied source meet its surroundings
// seamlessly even across a tone gradient. This is the per-pixel generalisation of
// the single mean-colour offset carried in uSpotTint. Both terms sample uImage so
// the correction stays in source space (it is added to the source patch, then the
// whole patched image is developed downstream — matching the flat-tint path).
vec3 membraneCorrection(vec2 dst, vec2 src, vec4 tc, float radius, vec2 uv) {
  vec2 q = vec2((uv.x - dst.x) * uImageAspect, uv.y - dst.y); // pixel in aspect space
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  const int N = 16;
  for (int k = 0; k < N; k++) {
    float a = (float(k) + 0.5) / float(N) * 6.2831853;
    vec2 e = vec2(cos(a), sin(a)) * radius * 1.04;       // boundary point (aspect space)
    vec2 dUv = clamp(dst + vec2(e.x / uImageAspect, e.y), 0.0, 1.0);
    // Same inverse rotate+scale the patch fetch uses, so the source boundary point
    // corresponds to the same place in the copied texture.
    float rx = (tc.x * e.x + tc.y * e.y) * tc.z;
    float ry = (-tc.y * e.x + tc.x * e.y) * tc.z;
    vec2 sUv = clamp(src + vec2(rx / uImageAspect, ry), 0.0, 1.0);
    // Explicit LOD: this runs in divergent control flow (inside the per-spot
    // branch), where auto-LOD derivatives are undefined and sample wrong mips.
    vec3 delta = textureLod(uImage, dUv, 0.0).rgb - textureLod(uImage, sUv, 0.0).rgb;
    float dist = length(q - e) + 1e-3;
    float w = 1.0 / (dist * dist);                        // mean-value-style weighting
    acc += delta * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-4);
}

vec3 applyRetouch(vec2 uv, vec3 base) {
  vec3 c = base;
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (i >= uSpotCount) break;
    vec4 a = uSpotA[i];
    vec4 b = uSpotB[i];
    vec2 dst = a.xy;
    vec2 src = a.zw;                  // source-patch centre
    vec4 tc = uSpotC[i];             // cosA, sinA, 1/scale
    float radius = max(b.x, 1e-4);
    float feather = b.y;
    float opacity = b.z;
    // Offset from the spot centre in image-height units (aspect-corrected so the
    // disc stays round on screen).
    float dx = (uv.x - dst.x) * uImageAspect;
    float dy = uv.y - dst.y;
    float dist = length(vec2(dx, dy));
    // The marked radius is fully replaced, so the blemish is removed outright;
    // feather softens the seam by fading out *beyond* the radius rather than
    // carving into the core (which only made the blemish go lighter, not gone).
    // feather=0 -> hard edge; feather=1 -> blend out to 2x the radius.
    float edge = radius * (1.0 + feather);
    if (dist >= edge) continue;
    float w = opacity * (1.0 - smoothstep(radius, edge, dist));
    if (w <= 0.0) continue;
    // Fetch the source with the inverse rotation+scale, so the patch lands
    // rotated by +angle and scaled by +scale to match the surrounding texture.
    float rx = (tc.x * dx + tc.y * dy) * tc.z;
    float ry = (-tc.y * dx + tc.x * dy) * tc.z;
    vec2 sUv = clamp(src + vec2(rx / uImageAspect, ry), 0.0, 1.0);
    // Recolour toward the destination's surroundings so the seam disappears. Heal
    // spots (b.w > 0.5) use the per-pixel gradient-domain membrane; clone spots —
    // and the membrane A/B toggle when off — fall back to the flat mean offset.
    vec3 corr = (uMembraneHeal && b.w > 0.5)
      ? membraneCorrection(dst, src, tc, radius, uv)
      : uSpotTint[i].rgb;
    vec3 srcCol = ${healSourceColour(line)}
    c = mix(c, srcCol, w);
  }
  // Brush-shaped retouch: painted coverage from the atlas, one source offset each.
  if (uRetouchCount > 0) {
    vec4 rcov = texture(uRetouchTex, uv);
    for (int i = 0; i < MAX_RBRUSH; i++) {
      if (i >= uRetouchCount) break;
      int ch = uRetouchCh[i];
      float cov = ch == 0 ? rcov.r : (ch == 1 ? rcov.g : (ch == 2 ? rcov.b : rcov.a));
      vec4 rd = uRetouchData[i];
      float w = cov * rd.z;
      if (w <= 0.0) continue;
      vec2 sUv = clamp(uv + rd.xy, 0.0, 1.0);
      vec3 srcCol = texture(uImage, sUv).rgb;
      c = mix(c, srcCol, w);
    }
  }
  return c;
}`;

const MAX_SPOTS = 32;
const MAX_RBRUSH = 4;

const spotArray = (key: string, size: string, length: number): UniformDeclaration => ({
  key,
  glslType: "vec4",
  length,
  size,
  default: new Array(length * 4).fill(0),
});

/** `rows` of four flattened, then zero-filled to `length` rows. */
const rowsOf = (rows: number[][], length: number): number[] =>
  [...rows.flat(), ...new Array((length - rows.length) * 4).fill(0)];

const healSpots = (line: EssentialLine): ProcessingStageContribution => ({
  id: "safelight.heal.retouch",
  name: "Heal",
  phase: "geometry",
  anchor: "retouch",
  glsl: "",
  helpers: healHelpers(line),
  defines: { MAX_SPOTS, MAX_RBRUSH },
  uniforms: [
    { key: "uSpotCount", glslType: "int", default: 0 },
    spotArray("uSpotA", "MAX_SPOTS", MAX_SPOTS),
    spotArray("uSpotB", "MAX_SPOTS", MAX_SPOTS),
    spotArray("uSpotC", "MAX_SPOTS", MAX_SPOTS),
    spotArray("uSpotTint", "MAX_SPOTS", MAX_SPOTS),
    { key: "uRetouchCount", glslType: "int", default: 0 },
    { key: "uRetouchCh", glslType: "int", length: MAX_RBRUSH, size: "MAX_RBRUSH", default: [0, 0, 0, 0] },
    spotArray("uRetouchData", "MAX_RBRUSH", MAX_RBRUSH),
    { key: "uMembraneHeal", glslType: "bool", default: true },
  ],
  textures: [{ key: "uRetouchTex", kind: "atlas" }],
  patch: { active: ["uSpotCount", "uRetouchCount"] },
  derive: ({ retouch }) => {
    const shown = retouch.filter((s) => s.visible !== false);
    const circles = shown.filter((s) => s.shape !== "brush").slice(0, MAX_SPOTS);
    const brushes = shown
      .flatMap((s) => (s.shape === "brush" && s.dabs && s.dabs.length > 0 ? [{ ...s, dabs: s.dabs }] : []))
      .slice(0, MAX_RBRUSH);
    const tint = (s: (typeof circles)[number], v: number | undefined) => (s.mode === "clone" ? 0 : (v ?? 0));
    return {
      uSpotCount: circles.length,
      uSpotA: rowsOf(circles.map((s) => [s.dstX, s.dstY, s.srcX, s.srcY]), MAX_SPOTS),
      uSpotB: rowsOf(
        circles.map((s) => [s.radius, s.feather / 100, s.opacity / 100, s.mode === "clone" ? 0 : 1]),
        MAX_SPOTS,
      ),
      uSpotC: rowsOf(
        circles.map((s) => [Math.cos(s.angle ?? 0), Math.sin(s.angle ?? 0), 1 / (s.scale || 1), 0]),
        MAX_SPOTS,
      ),
      uSpotTint: rowsOf(
        circles.map((s) => [tint(s, s.recolorR), tint(s, s.recolorG), tint(s, s.recolorB), 0]),
        MAX_SPOTS,
      ),
      uRetouchCount: brushes.length,
      uRetouchCh: [0, 1, 2, 3],
      uRetouchData: rowsOf(
        brushes.map((s) => [s.srcX - s.dstX, s.srcY - s.dstY, s.opacity / 100, 0]),
        MAX_RBRUSH,
      ),
      uRetouchTex: brushes.map((s) => ({ id: s.id, dabs: s.dabs })),
    };
  },
});

/** Masking's masks: declarations only, at the masks anchor, for main()'s two
 *  mask loops and the mask maths core keeps. Line 1 lacks version 2's flag
 *  for a mask's display adjustments. */
const MASK_HELPERS = `// Coverage of one component (0..1), before add/subtract combine. px is the
// current pixel's working (scene-linear) colour and pxL its luma — used by the
// parametric range masks (luminance / colour).
float compCoverage(int i, vec2 uv, vec3 px, float pxL) {
  int type = uCompType[i];
  vec4 gA = uCompGeoA[i];
  vec4 gB = uCompGeoB[i];
  float m = 0.0;
  if (type == 0) {
    // Linear gradient: ramp 0->1 projected onto the drag direction.
    vec2 p0 = gA.xy;
    vec2 p1 = gA.zw;
    vec2 dir = p1 - p0;
    float len2 = max(dot(dir, dir), 1e-6);
    m = clamp(dot(uv - p0, dir) / len2, 0.0, 1.0);
  } else if (type == 1) {
    // Radial: 1 inside, feathered to 0 at the edge, in screen-proportional space.
    vec2 ctr = gA.xy;
    vec2 rad = max(gA.zw, vec2(1e-4));
    float feather = gB.x;
    float ang = gB.y;
    vec2 q = vec2((uv.x - ctr.x) * uImageAspect, uv.y - ctr.y);
    float ca = cos(ang);
    float sa = sin(ang);
    vec2 qr = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    vec2 radS = vec2(rad.x * uImageAspect, rad.y);
    float d = length(qr / radS);
    m = 1.0 - smoothstep(1.0 - feather, 1.0, d);
  } else if (type == 3) {
    // Luminance range: 1 inside [lo,hi], soft ramps of width loF/hiF at the ends.
    float lo = gA.x;
    float hi = gA.y;
    float loF = max(gA.z, 1e-4);
    float hiF = max(gA.w, 1e-4);
    float lower = smoothstep(lo - loF, lo, pxL);
    float upper = 1.0 - smoothstep(hi, hi + hiF, pxL);
    m = lower * upper;
  } else if (type == 4) {
    // Colour range: closeness to a target colour, measured in hue + chroma.
    vec3 tgt = gA.xyz;
    float hueRange = max(gA.w, 1e-3);
    float satRange = max(gB.x, 1e-3);
    float smth = gB.y;
    // Compare in a tone-normalized chroma space so exposure differences along
    // the same hue don't break the match. Direction of the colour vector ~ hue,
    // its length relative to luma ~ saturation.
    float tL = max(luma(tgt), 1e-4);
    vec3 pd = px - vec3(pxL);
    vec3 td = tgt - vec3(tL);
    float pLen = length(pd);
    float tLen = length(td);
    float hueDist = 1.0 - (dot(pd, td) / max(pLen * tLen, 1e-4)); // 0 = same hue
    float satDist = abs(pLen / max(pxL, 1e-3) - tLen / tL);       // chroma mismatch
    float hueM = 1.0 - smoothstep(hueRange, hueRange + smth + 1e-3, hueDist);
    float satM = 1.0 - smoothstep(satRange, satRange + smth + 1e-3, satDist);
    // Near-neutral target/pixel have no meaningful hue — fall back to chroma only.
    float chromaW = smoothstep(0.01, 0.05, tLen);
    m = mix(satM, hueM * satM, chromaW);
  } else {
    // Brush: prebaked coverage from the atlas channel. ch < 0 marks a brush with
    // no atlas slot (beyond the 4 the RGBA atlas holds) — it contributes nothing
    // rather than borrowing channel 0's coverage.
    vec4 cov = texture(uMaskTex, uv);
    int ch = uCompBrushCh[i];
    m = ch < 0 ? 0.0 : (ch == 0 ? cov.r : (ch == 1 ? cov.g : (ch == 2 ? cov.b : cov.a)));
  }
  if (uCompInvert[i] == 1) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}`;

const ints = (key: string, size: string, length: number): UniformDeclaration => ({
  key,
  glslType: "int",
  length,
  size,
  default: new Array(length).fill(0),
});
const vec4s = (key: string, size: string, length: number): UniformDeclaration => ({
  key,
  glslType: "vec4",
  length,
  size,
  default: new Array(length * 4).fill(0),
});

/** `values`, zero-filled to `length`. */
const padded = (values: number[], length: number): number[] => [...values, ...new Array(length - values.length).fill(0)];

/** A component's shape in the program: its type and two vec4s of geometry. */
function componentGeometry(c: MaskComponent): { type: number; a: number[]; b: number[] } {
  if (c.kind === "linear" && c.linear) return { type: 0, a: [c.linear.x0, c.linear.y0, c.linear.x1, c.linear.y1], b: [0, 0, 0, 0] };
  if (c.kind === "radial" && c.radial)
    return { type: 1, a: [c.radial.cx, c.radial.cy, c.radial.rx, c.radial.ry], b: [c.radial.feather, c.radial.angle, 0, 0] };
  if (c.kind === "lumRange" && c.lumRange) {
    const lr = c.lumRange;
    return { type: 3, a: [lr.lo, lr.hi, lr.loFeather, lr.hiFeather], b: [0, 0, 0, 0] };
  }
  if (c.kind === "colorRange" && c.colorRange) {
    const cr = c.colorRange;
    return { type: 4, a: [cr.r, cr.g, cr.b, cr.hueRange], b: [cr.satRange, cr.smoothness, 0, 0] };
  }
  const type = c.kind === "linear" ? 0 : c.kind === "radial" ? 1 : c.kind === "lumRange" ? 3 : c.kind === "colorRange" ? 4 : 2;
  return { type, a: [0, 0, 0, 0], b: [0, 0, 0, 0] };
}

let maskCurveVersion = 0;

const masksStage = (line: EssentialLine): ProcessingStageContribution => ({
  id: "safelight.masks.coverage",
  name: "Masking",
  phase: "scene-linear",
  anchor: "masks",
  glsl: "",
  helpers: MASK_HELPERS,
  uniforms: [
    { key: "uMaskCount", glslType: "int", default: 0 },
    ints("uMaskInvert", "MAX_MASKS", MAX_MASKS),
    { key: "uMaskOpacity", glslType: "float", length: MAX_MASKS, size: "MAX_MASKS", default: new Array(MAX_MASKS).fill(0) },
    { key: "uCompCount", glslType: "int", default: 0 },
    ints("uCompMaskIdx", "MAX_COMPONENTS", MAX_MASK_COMPONENTS),
    ints("uCompMode", "MAX_COMPONENTS", MAX_MASK_COMPONENTS),
    ints("uCompType", "MAX_COMPONENTS", MAX_MASK_COMPONENTS),
    ints("uCompInvert", "MAX_COMPONENTS", MAX_MASK_COMPONENTS),
    ints("uCompBrushCh", "MAX_COMPONENTS", MAX_MASK_COMPONENTS),
    vec4s("uCompGeoA", "MAX_COMPONENTS", MAX_MASK_COMPONENTS),
    vec4s("uCompGeoB", "MAX_COMPONENTS", MAX_MASK_COMPONENTS),
    vec4s("uMaskAdj0", "MAX_MASKS", MAX_MASKS),
    vec4s("uMaskAdj1", "MAX_MASKS", MAX_MASKS),
    vec4s("uMaskAdj2", "MAX_MASKS", MAX_MASKS),
    vec4s("uMaskAdj3", "MAX_MASKS", MAX_MASKS),
    ints("uMaskHasHsl", "MAX_MASKS", MAX_MASKS),
    vec4s("uMaskHsl", "MAX_MASKS * 6", MAX_MASKS * 6),
    ints("uMaskHasCurve", "MAX_MASKS", MAX_MASKS),
    ...(line === 1 ? [] : [ints("uMaskHasDisplay", "MAX_MASKS", MAX_MASKS)]),
  ],
  textures: [{ key: "uMaskCurves", kind: "photo" }],
  derive: ({ masks: all }) => {
    const masks = all.slice(0, MAX_MASKS);
    // The brush atlas holds the masks' brush components first, in order, one
    // channel each up to four (renderer.ts updateMaskTexture).
    const brushChannel = new Map<string, number>();
    for (const m of all) {
      for (const c of m.components) {
        if (c.kind === "brush" && c.brush && brushChannel.size < 4) brushChannel.set(c.id, brushChannel.size);
      }
    }
    const comps: { mi: number; c: MaskComponent }[] = [];
    masks.forEach((m, mi) => {
      for (const c of m.components) if (comps.length < MAX_MASK_COMPONENTS) comps.push({ mi, c });
    });
    const shapes = comps.map(({ c }) => componentGeometry(c));
    const hsl = new Array(MAX_MASKS * 24).fill(0);
    masks.forEach((m, i) => {
      if (!m.hsl || isDefaultHSL(m.hsl)) return;
      HSL_CHANNELS.forEach((ch, b) => {
        hsl[i * 24 + b] = m.hsl!.hue[ch] / 100;
        hsl[i * 24 + 8 + b] = m.hsl!.saturation[ch] / 100;
        hsl[i * 24 + 16 + b] = m.hsl!.luminance[ch] / 100;
      });
    });
    // Each mask's curve in its row; the rest stay identity, unread.
    const curves = new Uint8Array(256 * MAX_MASKS * 4);
    for (let row = 0; row < MAX_MASKS; row++) {
      for (let i = 0; i < 256; i++) curves.set([i, i, i, 255], (row * 256 + i) * 4);
    }
    const hasCurve = masks.map((m, i) => {
      if (!m.toneCurve || isDefaultToneCurves(m.toneCurve)) return 0;
      buildMaskCurveLUT(m.toneCurve, curves, i * 256 * 4);
      return 1;
    });
    const adj = (pick: (a: DevelopParams["masks"][number]["adj"]) => number[]) =>
      padded(masks.flatMap((m) => pick(m.adj)), MAX_MASKS * 4);
    return {
      uMaskCount: masks.length,
      uMaskInvert: padded(masks.map((m) => (m.invert ? 1 : 0)), MAX_MASKS),
      // Hidden masks apply nothing but still compute coverage, for the view.
      uMaskOpacity: padded(masks.map((m) => (m.visible === false ? 0 : m.opacity / 100)), MAX_MASKS),
      uCompCount: comps.length,
      uCompMaskIdx: padded(comps.map(({ mi }) => mi), MAX_MASK_COMPONENTS),
      uCompMode: padded(comps.map(({ c }) => (c.mode === "subtract" ? 1 : c.mode === "intersect" ? 2 : 0)), MAX_MASK_COMPONENTS),
      uCompType: padded(shapes.map((g) => g.type), MAX_MASK_COMPONENTS),
      uCompInvert: padded(comps.map(({ c }) => (c.invert ? 1 : 0)), MAX_MASK_COMPONENTS),
      uCompBrushCh: padded(comps.map(({ c }) => brushChannel.get(c.id) ?? -1), MAX_MASK_COMPONENTS),
      uCompGeoA: padded(shapes.flatMap((g) => g.a), MAX_MASK_COMPONENTS * 4),
      uCompGeoB: padded(shapes.flatMap((g) => g.b), MAX_MASK_COMPONENTS * 4),
      uMaskAdj0: adj((a) => [a.exposure, a.contrast, a.highlights, a.shadows]),
      uMaskAdj1: adj((a) => [a.saturation, a.temperature, a.tint, a.clarity]),
      uMaskAdj2: adj((a) => [a.sharpness, a.whites, a.blacks, a.vibrance]),
      uMaskAdj3: adj((a) => [a.texture, a.dehaze, 0, 0]),
      uMaskHasHsl: padded(masks.map((m) => (m.hsl && !isDefaultHSL(m.hsl) ? 1 : 0)), MAX_MASKS),
      uMaskHsl: hsl,
      uMaskHasCurve: padded(hasCurve, MAX_MASKS),
      uMaskCurves: { data: curves, width: 256, height: MAX_MASKS, format: "rgba8", version: ++maskCurveVersion },
      ...(line === 1 ? {} : { uMaskHasDisplay: padded(masks.map((m) => (maskHasDisplayAdjustments(m.adj) ? 1 : 0)), MAX_MASKS) }),
    };
  },
});

const installed = (extensionId: string, stages: ProcessingStageContribution[]): InstalledStage[] =>
  stages.map((s) => ({ ...s, extensionId }));

/** Every moved Essential's stages at release line `line`, as registered. */
export function essentialStages(line: EssentialLine = 3): InstalledStage[] {
  return [
    ...installed(CROP_EXTENSION_ID, [cropGeometry()]),
    ...installed(HEAL_EXTENSION_ID, [healSpots(line)]),
    ...installed(WHITE_BALANCE_EXTENSION_ID, [whiteBalance()]),
    ...installed(BASIC_EXTENSION_ID, basic(line)),
    ...installed(MASKS_EXTENSION_ID, [masksStage(line)]),
    ...installed(TONE_CURVE_EXTENSION_ID, [toneCurve(line)]),
    ...installed(COLOR_GRADING_EXTENSION_ID, [colorGrading(line)]),
    ...installed(HSL_EXTENSION_ID, [hsl(line)]),
    ...installed(DETAIL_EXTENSION_ID, [sharpen()]),
    ...installed(EFFECTS_EXTENSION_ID, [vignette(line), grain(line)]),
  ];
}

/** `stages` with each Essential's stage swapped for its copy at `line`. */
export function withEssentialLine<S extends ProcessingStageContribution>(
  stages: readonly S[],
  line: EssentialLine,
): (S | InstalledStage)[] {
  const copies = new Map(essentialStages(line).map((s) => [s.id, s]));
  return stages.map((s) => copies.get(s.id) ?? s);
}

/** What a line's hash covers: the fields that make the program and its
 *  bindings, in a fixed order. */
export const stageText = (s: ProcessingStageContribution): string =>
  JSON.stringify([s.id, s.phase, s.priority ?? null, s.anchor ?? null, s.glsl, s.helpers ?? null, s.uniforms, s.textures ?? null, ...(s.defines ? [s.defines, s.patch ?? null] : [])]);
