// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import {
  BLACKBODY_CHANNEL_FLOOR,
  BLACKBODY_MAX_K,
  BLACKBODY_MIN_K,
  TEMPERATURE_MAX_K,
  TEMPERATURE_MIN_K,
  TINT_GAIN_SPAN,
  TINT_RANGE,
  blackbodyLinear,
  kelvinForGainRatio,
  kelvinFromWhiteBalanceGains,
  srgbToLinear,
  tintForGreenGain,
  tintGain,
  whiteBalanceGain,
  whiteBalanceGains,
  type LinearRgb,
} from "./blackbody";
import { FRAGMENT_SHADER, V2_VARIANT, V3_VARIANT, buildFragmentShader } from "./webgl/shaders";

// ---------------------------------------------------------------------------
// Shader drift guard
//
// The fragment shader has to carry its own copy of the blackbody fit, so the
// only way to keep the two honest is to read the GLSL back. Every constant is
// pulled out of the shader source by name and fed into a JS rebuild of the same
// expressions; the rebuild is then sampled against this module. Retuning either
// copy — or renaming the expressions the patterns key off — fails here.
// ---------------------------------------------------------------------------

function glslFunction(name: string, shader = FRAGMENT_SHADER): string {
  const start = shader.indexOf(`vec3 ${name}(`);
  if (start < 0) throw new Error(`the shader has no ${name}()`);
  let depth = 0;
  for (let i = shader.indexOf("{", start); i < shader.length; i++) {
    if (shader[i] === "{") depth++;
    else if (shader[i] === "}" && --depth === 0) {
      return shader.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

function glslConstant(source: string, pattern: RegExp): number {
  const match = source.match(pattern);
  if (!match) throw new Error(`shader constant not found: ${pattern.source}`);
  return Number(match[1]);
}

const SRGB_GLSL = glslFunction("srgbToLinear");
const BLACKBODY_GLSL = glslFunction("blackbodyLinear");

const shaderSrgbToLinear = ((): ((c: number) => number) => {
  const knee = glslConstant(SRGB_GLSL, /step\((-?[\d.]+), c\)/);
  const slope = glslConstant(SRGB_GLSL, /c \/ ([\d.]+),/);
  const offset = glslConstant(SRGB_GLSL, /pow\(\(c \+ ([\d.]+)\)/);
  const scale = glslConstant(SRGB_GLSL, /\+ [\d.]+\) \/ ([\d.]+), vec3\(/);
  const gamma = glslConstant(SRGB_GLSL, /vec3\(([\d.]+)\)\)/);
  return (c) => (c < knee ? c / slope : Math.pow((c + offset) / scale, gamma));
})();

const shaderBlackbodyLinear = ((): ((kelvin: number) => [number, number, number]) => {
  const minK = glslConstant(BLACKBODY_GLSL, /clamp\(kelvin, ([\d.]+),/);
  const maxK = glslConstant(BLACKBODY_GLSL, /clamp\(kelvin, [\d.]+, ([\d.]+)\)/);
  const scale = glslConstant(BLACKBODY_GLSL, /clamp\(kelvin, [\d.]+, [\d.]+\) \/ ([\d.]+)/);
  const warmSplit = glslConstant(BLACKBODY_GLSL, /if \(t <= ([\d.]+)\) \{/);
  const warmRed = glslConstant(BLACKBODY_GLSL, /r = ([\d.]+);/);
  const warmGreenScale = glslConstant(BLACKBODY_GLSL, /g = ([\d.]+) \* log\(t\)/);
  const warmGreenOffset = glslConstant(BLACKBODY_GLSL, /g = [\d.]+ \* log\(t\) - ([\d.]+);/);
  const coolPivot = glslConstant(BLACKBODY_GLSL, /r = [\d.]+ \* pow\(t - ([\d.]+),/);
  const coolRedScale = glslConstant(BLACKBODY_GLSL, /r = ([\d.]+) \* pow\(t - [\d.]+,/);
  const coolRedExp = glslConstant(BLACKBODY_GLSL, /r = [\d.]+ \* pow\(t - [\d.]+, (-?[\d.]+)\)/);
  const coolGreenScale = glslConstant(BLACKBODY_GLSL, /g = ([\d.]+) \* pow\(t - [\d.]+,/);
  const coolGreenExp = glslConstant(BLACKBODY_GLSL, /g = [\d.]+ \* pow\(t - [\d.]+, (-?[\d.]+)\)/);
  const blueSplit = glslConstant(BLACKBODY_GLSL, /\} else if \(t <= ([\d.]+)\) \{/);
  const bluePivot = glslConstant(BLACKBODY_GLSL, /b = [\d.]+ \* log\(t - ([\d.]+)\)/);
  const blueScale = glslConstant(BLACKBODY_GLSL, /b = ([\d.]+) \* log\(t - [\d.]+\)/);
  const blueOffset = glslConstant(BLACKBODY_GLSL, /b = [\d.]+ \* log\(t - [\d.]+\) - ([\d.]+);/);
  const norm = glslConstant(BLACKBODY_GLSL, /vec3\(r, g, b\) \/ ([\d.]+),/);
  const floor = glslConstant(BLACKBODY_GLSL, /vec3\(r, g, b\) \/ [\d.]+, ([\d.]+),/);
  const ceiling = glslConstant(BLACKBODY_GLSL, /vec3\(r, g, b\) \/ [\d.]+, [\d.]+, ([\d.]+)\)/);

  return (kelvin) => {
    const t = Math.min(maxK, Math.max(minK, kelvin)) / scale;
    let r: number, g: number, b: number;
    if (t <= warmSplit) {
      r = warmRed;
      g = warmGreenScale * Math.log(t) - warmGreenOffset;
    } else {
      r = coolRedScale * Math.pow(t - coolPivot, coolRedExp);
      g = coolGreenScale * Math.pow(t - coolPivot, coolGreenExp);
    }
    if (t >= warmSplit) b = warmRed;
    else if (t <= blueSplit) b = 0;
    else b = blueScale * Math.log(t - bluePivot) - blueOffset;
    const encode = (v: number) =>
      shaderSrgbToLinear(Math.min(ceiling, Math.max(floor, v / norm)));
    return [encode(r), encode(g), encode(b)];
  };
})();

// Every branch of the fit: below the blue cutoff, the warm log arm, the split,
// the cool power arm, and both clamps.
const SAMPLE_KELVINS = [
  500, 1000, 1500, 1900, 1901, 2000, 2500, 2856, 3200, 4000, 5000, 5500, 6500, 6599,
  6600, 6601, 7500, 9000, 12000, 20000, 35000, 50000, 80000,
];

describe("blackbody — shader parity", () => {
  it("keeps the shader's fit constants identical to the module's", () => {
    for (const constant of [
      BLACKBODY_MIN_K.toFixed(1),
      BLACKBODY_MAX_K.toFixed(1),
      BLACKBODY_CHANNEL_FLOOR.toString(),
      "99.4708025861",
      "161.1195681661",
      "329.698727446",
      "-0.1332047592",
      "288.1221695283",
      "-0.0755148492",
      "138.5177312231",
      "305.0447927307",
    ]) {
      expect(BLACKBODY_GLSL, `missing ${constant}`).toContain(constant);
    }
  });

  it("evaluates the shader's own constants to this module's values", () => {
    for (const kelvin of SAMPLE_KELVINS) {
      const shader = shaderBlackbodyLinear(kelvin);
      const module = blackbodyLinear(kelvin);
      for (let ch = 0; ch < 3; ch++) {
        expect(shader[ch], `channel ${ch} at ${kelvin} K`).toBeCloseTo(module[ch], 12);
      }
    }
  });

  it("keeps the sRGB transfer function identical to the shader's", () => {
    for (const c of [0, 0.01, 0.04, 0.0405, 0.041, 0.1, 0.5, 0.9, 1]) {
      expect(shaderSrgbToLinear(c)).toBeCloseTo(srgbToLinear(c), 12);
    }
  });

  it("derives the tint gain from the same numbers the shader uses", () => {
    const wb = glslFunction("applyWhiteBalance");
    expect(wb).toContain(`(tint / ${TINT_RANGE.toFixed(1)}) * ${TINT_GAIN_SPAN}`);
    expect(tintGain(0)).toBe(1);
    expect(tintGain(TINT_RANGE)).toBeCloseTo(1 - TINT_GAIN_SPAN, 12);
    for (const tint of [-150, -37, 0, 21, 150]) {
      expect(tintForGreenGain(tintGain(tint))).toBeCloseTo(tint, 10);
    }
  });

  it("matches the shader's gain derivation, unity at the as-shot point", () => {
    expect(whiteBalanceGain(5200, 5200)).toEqual([1, 1, 1]);
    for (const [kelvin, asShot] of [
      [3200, 6500],
      [6500, 3200],
      [8000, 5500],
    ] as const) {
      const ref = shaderBlackbodyLinear(asShot);
      const bb = shaderBlackbodyLinear(kelvin);
      const green = ref[1] / bb[1];
      const gain = whiteBalanceGain(kelvin, asShot);
      expect(gain[0]).toBeCloseTo(ref[0] / bb[0] / green, 12);
      expect(gain[1]).toBe(1);
      expect(gain[2]).toBeCloseTo(ref[2] / bb[2] / green, 12);
    }
  });
});

describe("blackbody — the gains applyWhiteBalance multiplies by", () => {
  const lumaOf = ([r, g, b]: LinearRgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const TINTS = [-150, -75, 0, 75, 150];
  const KELVINS = [2800, 4200, 6500, 9000];

  it.each([2, 3])("keep a neutral's luminance under Tint and Temperature on version %i", (version) => {
    for (const tint of TINTS) {
      for (const kelvin of KELVINS) {
        expect(lumaOf(whiteBalanceGains(kelvin, tint, 6500, version)), `${kelvin} K, tint ${tint}`).toBeCloseTo(1, 12);
      }
    }
  });

  it.each([1, 2, 3])("keep the cast's direction and size on version %i", (version) => {
    for (const tint of TINTS) {
      for (const kelvin of KELVINS) {
        const [r, g, b] = whiteBalanceGains(kelvin, tint, 6500, version);
        const balance = whiteBalanceGain(kelvin, 6500);
        expect(g / r, `${kelvin} K, tint ${tint}`).toBeCloseTo(tintGain(tint) / balance[0], 12);
        expect(b / r, `${kelvin} K, tint ${tint}`).toBeCloseTo(balance[2] / balance[0], 12);
      }
    }
  });

  it.each([1, 2, 3])("are exactly unity at the as-shot point on version %i", (version) => {
    for (const asShot of [3200, 5200, 6500]) {
      expect(whiteBalanceGains(asShot, 0, asShot, version)).toEqual([1, 1, 1]);
    }
  });

  it("stay version 1's: green-normalized, with the tint on green alone", () => {
    for (const tint of TINTS) {
      for (const kelvin of KELVINS) {
        const balance = whiteBalanceGain(kelvin, 6500);
        expect(whiteBalanceGains(kelvin, tint, 6500, 1)).toEqual([balance[0], tintGain(tint), balance[2]]);
      }
    }
    expect(Math.log2(lumaOf(whiteBalanceGains(6500, 150, 6500, 1)))).toBeLessThan(-0.5);
  });

  it("are what each version's shader derives", () => {
    const normalize = "gain /= luma(gain);";
    expect(glslFunction("applyWhiteBalance")).not.toContain(normalize);
    for (const variant of [V2_VARIANT, V3_VARIANT]) {
      const wb = glslFunction("applyWhiteBalance", buildFragmentShader(null, undefined, variant));
      expect(wb.indexOf(normalize), `version ${variant.version}`).toBeGreaterThan(wb.indexOf("gain.g *="));
    }
  });
});

describe("blackbody — Kelvin inversion", () => {
  it("returns the reference temperature for unity gains", () => {
    for (const reference of [2856, 5500, 6500]) {
      expect(kelvinForGainRatio(0, reference)).toBeCloseTo(reference, -2);
    }
  });

  it("round-trips a temperature through its own gain ratio", () => {
    for (const kelvin of [2500, 3200, 4500, 6500, 9000, 20000]) {
      const gain = whiteBalanceGain(kelvin, 6500);
      const solved = kelvinForGainRatio(Math.log(gain[0] / gain[2]), 6500);
      expect(solved / kelvin).toBeCloseTo(1, 1);
    }
  });

  it("stays inside the slider range for degenerate ratios", () => {
    for (const target of [-40, -1, 0, 1, 40]) {
      const kelvin = kelvinForGainRatio(target, 6500);
      expect(kelvin).toBeGreaterThanOrEqual(TEMPERATURE_MIN_K);
      expect(kelvin).toBeLessThanOrEqual(TEMPERATURE_MAX_K);
    }
  });

  it("reads warm gains as low Kelvin and cool gains as high", () => {
    // Unity gains land on the reference, give or take one step of the search grid.
    expect(kelvinFromWhiteBalanceGains(1, 1, 1)).toBeCloseTo(6500, -2);
    const tungsten = kelvinFromWhiteBalanceGains(1.4, 1, 2.6);
    const shade = kelvinFromWhiteBalanceGains(2.6, 1, 1.2);
    expect(tungsten).toBeLessThan(6500);
    expect(shade).toBeGreaterThan(6500);
  });

  it("rejects gains that are not all positive", () => {
    expect(kelvinFromWhiteBalanceGains(0, 1, 1)).toBeUndefined();
    expect(kelvinFromWhiteBalanceGains(1, -1, 1)).toBeUndefined();
    expect(kelvinFromWhiteBalanceGains(1, 1, Number.NaN)).toBeUndefined();
  });

  it("quantizes to the 10 K the temperature slider steps in", () => {
    for (const [r, g, b] of [
      [2.1, 1, 1.35],
      [1.6, 1, 2.2],
      [1, 1, 1],
    ]) {
      expect(kelvinFromWhiteBalanceGains(r, g, b)! % 10).toBe(0);
    }
  });
});
