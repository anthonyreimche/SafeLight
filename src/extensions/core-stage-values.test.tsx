// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Essentials' stages derive their uniforms from DevelopParams. Each must
// derive exactly what render() bound by hand from the same params before the
// tool moved onto the stage path, written out here as render() wrote it.

import { describe, expect, it } from "vitest";
import {
  HSL_CHANNELS,
  freshParams,
  isDefaultHSL,
  isDefaultToneCurves,
  normalizeParams,
  type DevelopParams,
} from "@/catalog/types";
import type { StageDeriveContext } from "./types";
import { builtinStage } from "@/rendering/webgl/webgl.test-support";
import { buildMaskCurveLUT } from "@/rendering/curve";

const CTX: StageDeriveContext = { settings: (_key, fallback) => fallback };

/** Params at their defaults and well away from them. */
const CORPUS: DevelopParams[] = [
  freshParams(),
  normalizeParams({
    vignette: { amount: -42, midpoint: 31, roundness: 17, feather: 88, highlights: 12 },
    grain: { amount: 37, size: 61, roughness: 22, color: 44 },
    colorGrading: {
      shadows: { hue: 210, sat: 35, luma: -12 },
      midtones: { hue: 40, sat: 8, luma: 5 },
      highlights: { hue: 55, sat: 20, luma: 9 },
      global: { hue: 300, sat: 3, luma: -4 },
      shadowRange: 37,
      highlightRange: 63,
    },
    toneCurve: {
      rgb: [{ x: 0, y: 0 }, { x: 0.25, y: 0.18 }, { x: 0.75, y: 0.82 }, { x: 1, y: 1 }],
      red: [{ x: 0, y: 0.04 }, { x: 1, y: 1 }],
      green: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      blue: [{ x: 0, y: 0 }, { x: 0.5, y: 0.45 }, { x: 1, y: 0.97 }],
    },
    hsl: {
      hue: { red: 12, orange: -30, yellow: 0, green: 44, aqua: -8, blue: 100, purple: -100, magenta: 3 },
      saturation: { red: -15, orange: 0, yellow: 22, green: 0, aqua: 0, blue: -40, purple: 9, magenta: 0 },
      luminance: { red: 0, orange: 18, yellow: 0, green: -7, aqua: 30, blue: 0, purple: 0, magenta: -55 },
    },
  }),
];

const derived = (id: string, p: DevelopParams) => builtinStage(id).derive?.(p, CTX);

describe("Effects", () => {
  it.each(CORPUS.map((p, i) => [i, p] as const))("Vignette derives what render() bound (params %i)", (_, p) => {
    const vig = p.vignette;
    expect(derived("safelight.effects.vignette", p)).toEqual({
      uVignetteAmount: vig.amount,
      uVignetteMidpoint: vig.midpoint,
      uVignetteRoundness: vig.roundness,
      uVignetteFeather: vig.feather,
      uVignetteHighlights: vig.highlights,
    });
  });

  it.each(CORPUS.map((p, i) => [i, p] as const))("Grain derives what render() bound (params %i)", (_, p) => {
    const gr = p.grain;
    expect(derived("safelight.effects.grain", p)).toEqual({
      uGrainAmount: gr.amount,
      uGrainSize: gr.size,
      uGrainRoughness: gr.roughness,
      uGrainColor: gr.color,
    });
  });
});

describe("Colour Grading", () => {
  it.each(CORPUS.map((p, i) => [i, p] as const))("derives what render() bound (params %i)", (_, p) => {
    const cg = p.colorGrading;
    expect(derived("safelight.color-grading.grade", p)).toEqual({
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
      uColorGradingActive: [cg.shadows, cg.midtones, cg.highlights, cg.global].some((r) => r.sat >= 0.001 || r.luma !== 0),
    });
  });
});

describe("HSL", () => {
  // Preferences ▸ HSL's Colour range and Smoothness, as the renderer bound them.
  it.each([
    [{ hueRange: 150, smoothness: 40 }, 1.5, 0.4],
    [{ hueRange: 10, smoothness: 300 }, 0.25, 1],
    [{ hueRange: 500, smoothness: -5 }, 2, 0],
    [{ hueRange: Number.NaN, smoothness: Number.NaN }, 1, 1],
  ])("shapes the bands from the preferences %o", (prefs, range, smooth) => {
    const ctx: StageDeriveContext = {
      settings: <T,>(key: string, fallback: T) => ((prefs as Record<string, unknown>)[key] ?? fallback) as T,
    };
    expect(builtinStage("safelight.hsl.mix").derive?.(CORPUS[0], ctx)).toMatchObject({
      uHslRange: range,
      uHslSmooth: smooth,
    });
  });


  it.each(CORPUS.map((p, i) => [i, p] as const))("derives what render() bound (params %i)", (_, p) => {
    expect(derived("safelight.hsl.mix", p)).toEqual({
      uHslHue: HSL_CHANNELS.map((ch) => p.hsl.hue[ch] / 100),
      uHslSat: HSL_CHANNELS.map((ch) => p.hsl.saturation[ch] / 100),
      uHslLum: HSL_CHANNELS.map((ch) => p.hsl.luminance[ch] / 100),
      uHslRange: 1,
      uHslSmooth: 1,
      uHslActive: !isDefaultHSL(p.hsl),
    });
  });
});

describe("Tone Curve", () => {
  it.each(CORPUS.map((p, i) => [i, p] as const))("derives the lookup table render() uploaded (params %i)", (_, p) => {
    const out = derived("safelight.tone-curve.curve", p) as Record<string, unknown>;
    expect(out.uCurveActive).toBe(!isDefaultToneCurves(p.toneCurve));
    expect(out.uCurve).toMatchObject({ width: 256, height: 1, format: "rgba8" });
    const lut = (out.uCurve as { data: Uint8Array }).data;
    expect(Array.from(lut)).toEqual(Array.from(buildMaskCurveLUT(p.toneCurve)));
  });

  it("gives the table a new version for new params, so the renderer uploads it again", () => {
    const [a, b] = CORPUS.map((p) => (derived("safelight.tone-curve.curve", p) as unknown as { uCurve: { version: number } }).uCurve.version);
    expect(a).not.toBe(b);
  });
});

describe("White Balance", () => {
  it.each([
    [0, freshParams(5200)],
    [1, normalizeParams({ temperature: 3400, tint: -27 })],
  ] as const)("derives what render() bound (params %i)", (_, p) => {
    expect(derived("safelight.white-balance.balance", p)).toEqual({ uTemperature: p.temperature, uTint: p.tint });
  });
});

describe("Basic and Detail", () => {
  const BASIC: DevelopParams = normalizeParams({
    exposure: 1.25,
    contrast: 18,
    highlights: -60,
    shadows: 45,
    whites: 12,
    blacks: -9,
    texture: 22,
    clarity: -14,
    dehaze: 31,
    highlightDetail: 7,
    shadowDetail: -5,
    vibrance: 26,
    saturation: -11,
    sharpening: 64,
    sharpenRadius: 1.6,
    sharpenDetail: 42,
    sharpenMasking: 18,
  });

  it.each([
    [0, freshParams()],
    [1, BASIC],
  ] as const)("derive what render() bound (params %i)", (_, p) => {
    expect(derived("safelight.basic.tone", p)).toEqual({ uExposure: p.exposure, uHighlights: p.highlights, uShadows: p.shadows });
    expect(derived("safelight.basic.display", p)).toEqual({ uWhites: p.whites, uBlacks: p.blacks, uContrast: p.contrast });
    expect(derived("safelight.basic.presence", p)).toEqual({ uTexture: p.texture, uClarity: p.clarity, uDehaze: p.dehaze });
    expect(derived("safelight.basic.band-detail", p)).toEqual({
      uHighlightDetail: p.highlightDetail,
      uShadowDetail: p.shadowDetail,
    });
    expect(derived("safelight.basic.vibrance", p)).toEqual({ uVibrance: p.vibrance, uSaturation: p.saturation });
    expect(derived("safelight.detail.sharpen", p)).toEqual({
      uSharpening: p.sharpening,
      uSharpenRadius: p.sharpenRadius,
      uSharpenDetail: p.sharpenDetail,
      uSharpenMasking: p.sharpenMasking,
    });
  });
});
