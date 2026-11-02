// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import {
  HSL_CHANNELS,
  type ColorGradingParams,
  type ColorGradingRange,
  type CropRect,
  type CurvePoint,
  type DevelopParams,
  type GrainParams,
  type HSLAdjustments,
  type HSLValues,
  type LumRangeGeo,
  type MaskAdjustments,
  type ToneCurves,
  type TransformParams,
  type VignetteParams,
} from "./develop-params";
import { CURRENT_PROCESS_VERSION } from "./process-version";

export function defaultMaskAdjustments(): MaskAdjustments {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    saturation: 0,
    vibrance: 0,
    temperature: 0,
    tint: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    sharpness: 0,
  };
}

export function defaultLumRange(): LumRangeGeo {
  return { lo: 0.0, hi: 1.0, loFeather: 0.1, hiFeather: 0.1 };
}

export const DEFAULT_TRANSFORM: TransformParams = {
  perspectiveV: 0,
  perspectiveH: 0,
  aspect: 0,
  scale: 100,
  offsetX: 0,
  offsetY: 0,
  flipH: false,
  flipV: false,
};

export const DEFAULT_TONE_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export function defaultToneCurves(): ToneCurves {
  return {
    rgb: [...DEFAULT_TONE_CURVE],
    red: [...DEFAULT_TONE_CURVE],
    green: [...DEFAULT_TONE_CURVE],
    blue: [...DEFAULT_TONE_CURVE],
  };
}

// True when every channel is the untouched 2-point identity ramp — the
// renderer skips per-mask curve LUT work for such masks.
export function isDefaultToneCurves(c: ToneCurves): boolean {
  return (["rgb", "red", "green", "blue"] as const).every((ch) => {
    const pts = c[ch];
    return (
      pts.length === 2 &&
      pts[0].x === 0 && pts[0].y === 0 &&
      pts[1].x === 1 && pts[1].y === 1
    );
  });
}

export function isDefaultHSL(h: HSLAdjustments): boolean {
  return (["hue", "saturation", "luminance"] as const).every((b) =>
    HSL_CHANNELS.every((ch) => h[b][ch] === 0),
  );
}

/** True when a mask carries an adjustment the develop shader applies in its
 *  display stage (mask stage 2); exposure, highlights, shadows and white
 *  balance run in the linear stage and don't count. */
export function maskHasDisplayAdjustments(a: MaskAdjustments): boolean {
  return (
    a.contrast !== 0 || a.saturation !== 0 || a.vibrance !== 0 ||
    a.whites !== 0 || a.blacks !== 0 || a.clarity !== 0 ||
    a.sharpness !== 0 || a.texture !== 0 || a.dehaze !== 0
  );
}

export const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

function defaultColorGradingRange(): ColorGradingRange {
  return { hue: 0, sat: 0, luma: 0 };
}

export function defaultColorGrading(): ColorGradingParams {
  return {
    shadows: defaultColorGradingRange(),
    midtones: defaultColorGradingRange(),
    highlights: defaultColorGradingRange(),
    global: defaultColorGradingRange(),
    shadowRange: 50,
    highlightRange: 50,
  };
}

export function zeroHSLValues(): HSLValues {
  return {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
    aqua: 0,
    blue: 0,
    purple: 0,
    magenta: 0,
  };
}

export function defaultHSL(): HSLAdjustments {
  return {
    hue: zeroHSLValues(),
    saturation: zeroHSLValues(),
    luminance: zeroHSLValues(),
  };
}

export const DEFAULT_VIGNETTE: VignetteParams = {
  amount: 0,
  midpoint: 50,
  roundness: 0,
  feather: 50,
  highlights: 0,
};

export const DEFAULT_GRAIN: GrainParams = {
  amount: 0,
  size: 25,
  roughness: 50,
  color: 0,
};

// Neutral white-balance temperature in Kelvin: the develop default and the
// fallback whenever a photo has no as-shot WB.
export const NEUTRAL_TEMPERATURE_K = 6500;

/** Spreading these yields the current process version, so stored data must go
 *  through normalizeParams (a missing version reads as 1) and fresh photos
 *  through freshParams. */
export const DEFAULT_DEVELOP_PARAMS: DevelopParams = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  highlightDetail: 0,
  shadowDetail: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  sharpening: 25,
  sharpenRadius: 1.0,
  sharpenDetail: 25,
  sharpenMasking: 0,
  luminanceNR: 0,
  luminanceNRDetail: 50,
  luminanceNRContrast: 0,
  luminanceNRShadows: 0,
  luminanceNRHighlights: 0,
  colorNR: 25,
  colorNRDetail: 50,
  colorNRSmoothness: 50,
  vibrance: 0,
  saturation: 0,
  temperature: NEUTRAL_TEMPERATURE_K,
  tint: 0,
  straighten: 0,
  crop: { ...DEFAULT_CROP },
  transform: { ...DEFAULT_TRANSFORM },
  uprightMode: "off",
  guidedLines: [],
  toneCurve: defaultToneCurves(),
  hsl: defaultHSL(),
  colorGrading: defaultColorGrading(),
  vignette: { ...DEFAULT_VIGNETTE },
  grain: { ...DEFAULT_GRAIN },
  masks: [],
  retouch: [],
  displayTransform: null,
  processVersion: CURRENT_PROCESS_VERSION,
};
