// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preset adjustment metadata, shared by the hover tooltip and the Save dialog.
//
// A preset stores only the keys it carries (a Partial<DevelopParams>):
//   • summarizePreset() lists those keys for the tooltip.
//   • presetFields() enumerates the selectable adjustments when saving, flagging
//     which currently differ from the defaults (checked by default).
//   • buildPartialParams() copies the chosen fields out of the live params.

import {
  DEFAULT_DEVELOP_PARAMS,
  DEFAULT_CROP,
  DEFAULT_TRANSFORM,
  DEFAULT_VIGNETTE,
  DEFAULT_GRAIN,
  defaultHSL,
  defaultColorGrading,
  isDefaultToneCurves,
  type DevelopParams,
} from "@/catalog/types";

type ScalarKey = {
  [K in keyof DevelopParams]: DevelopParams[K] extends number ? K : never;
}[keyof DevelopParams];

/** Display labels for scalar develop params (also the set of scalars surfaced
 *  in the tooltip). Shared so panels could reuse these later. */
export const PARAM_LABELS: Partial<Record<ScalarKey, string>> = {
  exposure: "Exposure",
  contrast: "Contrast",
  highlights: "Highlights",
  shadows: "Shadows",
  whites: "Whites",
  blacks: "Blacks",
  texture: "Texture",
  clarity: "Clarity",
  dehaze: "Dehaze",
  vibrance: "Vibrance",
  saturation: "Saturation",
  temperature: "Temp",
  tint: "Tint",
  straighten: "Straighten",
  sharpening: "Sharpening",
  sharpenRadius: "Sharpen radius",
  sharpenDetail: "Sharpen detail",
  sharpenMasking: "Sharpen masking",
  luminanceNR: "Luminance NR",
  luminanceNRDetail: "Luminance NR detail",
  luminanceNRContrast: "Luminance NR contrast",
  colorNR: "Color NR",
  colorNRDetail: "Color NR detail",
  colorNRSmoothness: "Color NR smoothness",
};

export interface PresetDiff {
  label: string;
  value: string;
}

function formatScalar(key: ScalarKey, value: number): string {
  if (key === "temperature") return `${Math.round(value)}K`;
  if (key === "exposure") {
    const s = value.toFixed(2);
    return value > 0 ? `+${s}` : s;
  }
  if (key === "sharpenRadius") {
    const s = value.toFixed(1);
    return value > 0 ? `+${s}` : s;
  }
  const r = Math.round(value);
  return r > 0 ? `+${r}` : `${r}`;
}

function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > 1e-6;
}

function jsonDiffers(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** Build the list of adjustments present in `params`, for display. Only keys the
 *  preset actually carries are considered, and among those only the ones that
 *  differ from the defaults are shown (so the tooltip stays meaningful for both
 *  partial presets and older full snapshots). */
export function summarizePreset(params: Partial<DevelopParams>): PresetDiff[] {
  const out: PresetDiff[] = [];

  // Scalars
  for (const key of Object.keys(PARAM_LABELS) as ScalarKey[]) {
    const value = params[key];
    if (typeof value !== "number") continue;
    if (differs(value, DEFAULT_DEVELOP_PARAMS[key] as number)) {
      out.push({ label: PARAM_LABELS[key]!, value: formatScalar(key, value) });
    }
  }

  // Complex sub-structures → one summary line each
  if (params.toneCurve && !isDefaultToneCurves(params.toneCurve)) {
    out.push({ label: "Tone curve", value: "edited" });
  }
  if (params.hsl && jsonDiffers(params.hsl, defaultHSL())) {
    out.push({ label: "HSL", value: "adjusted" });
  }
  if (params.colorGrading && jsonDiffers(params.colorGrading, defaultColorGrading())) {
    out.push({ label: "Color grading", value: "adjusted" });
  }
  if (params.masks && params.masks.length > 0) {
    out.push({ label: "Masks", value: `${params.masks.length}` });
  }
  if (params.retouch && params.retouch.length > 0) {
    out.push({ label: "Retouch", value: `${params.retouch.length}` });
  }
  if (params.crop && jsonDiffers(params.crop, DEFAULT_CROP)) {
    out.push({ label: "Crop", value: "set" });
  }
  if (params.transform && jsonDiffers(params.transform, DEFAULT_TRANSFORM)) {
    out.push({ label: "Transform", value: "set" });
  }
  if (params.vignette && jsonDiffers(params.vignette, DEFAULT_VIGNETTE)) {
    out.push({ label: "Vignette", value: "set" });
  }
  if (params.grain && jsonDiffers(params.grain, DEFAULT_GRAIN)) {
    out.push({ label: "Grain", value: "set" });
  }
  if (params.lensCorrection && params.lensCorrection.mode !== "off") {
    out.push({ label: "Lens correction", value: params.lensCorrection.mode });
  }

  return out;
}

// ─── Save-dialog field enumeration ──────────────────────────────────────────

/** One selectable adjustment in the Save Preset dialog. `keys` are the
 *  DevelopParams keys copied when the field is checked; `changed` marks fields
 *  that differ from the defaults (pre-checked by default). */
export interface PresetField {
  id: string;
  label: string;
  keys: (keyof DevelopParams)[];
  changed: boolean;
  /** Short current value, shown beside scalar fields. */
  value?: string;
}

/** Enumerate the adjustments that can be saved from the given live params, in a
 *  stable, panel-like order. */
export function presetFields(params: DevelopParams): PresetField[] {
  const fields: PresetField[] = [];

  for (const key of Object.keys(PARAM_LABELS) as ScalarKey[]) {
    const value = params[key];
    if (typeof value !== "number") continue;
    const changed = differs(value, DEFAULT_DEVELOP_PARAMS[key] as number);
    fields.push({
      id: key,
      label: PARAM_LABELS[key]!,
      keys: [key],
      changed,
      value: formatScalar(key, value),
    });
  }

  const complex: { id: string; label: string; keys: (keyof DevelopParams)[]; changed: boolean }[] = [
    { id: "toneCurve", label: "Tone curve", keys: ["toneCurve"], changed: !isDefaultToneCurves(params.toneCurve) },
    { id: "hsl", label: "HSL", keys: ["hsl"], changed: jsonDiffers(params.hsl, defaultHSL()) },
    { id: "colorGrading", label: "Color grading", keys: ["colorGrading"], changed: jsonDiffers(params.colorGrading, defaultColorGrading()) },
    { id: "geometry", label: "Crop & transform", keys: ["crop", "straighten", "transform", "uprightMode", "guidedLines"], changed: jsonDiffers(params.crop, DEFAULT_CROP) || jsonDiffers(params.transform, DEFAULT_TRANSFORM) || differs(params.straighten, 0) },
    { id: "vignette", label: "Vignette", keys: ["vignette"], changed: jsonDiffers(params.vignette, DEFAULT_VIGNETTE) },
    { id: "grain", label: "Grain", keys: ["grain"], changed: jsonDiffers(params.grain, DEFAULT_GRAIN) },
    { id: "lensCorrection", label: "Lens correction", keys: ["lensCorrection"], changed: params.lensCorrection.mode !== "off" },
    { id: "masks", label: "Masks", keys: ["masks"], changed: params.masks.length > 0 },
    { id: "retouch", label: "Retouch", keys: ["retouch"], changed: params.retouch.length > 0 },
  ];
  for (const c of complex) {
    fields.push(c);
  }

  return fields;
}

/** Copy the keys of the selected fields out of the live params into a partial. */
export function buildPartialParams(
  params: DevelopParams,
  fields: PresetField[],
  selectedIds: Set<string>,
): Partial<DevelopParams> {
  const out: Partial<DevelopParams> = {};
  for (const f of fields) {
    if (!selectedIds.has(f.id)) continue;
    for (const k of f.keys) {
      // Index assignment across a heterogeneous key set; safe because we copy a
      // value straight from params under the same key.
      (out as Record<string, unknown>)[k] = structuredClone(params[k]);
    }
  }
  return out;
}
