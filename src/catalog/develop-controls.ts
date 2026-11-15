// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The core develop values as the tool panels show them: stored key, label,
// range, unit. Store-free, so `slu` can list and set values in plain Node.
// Ranges are the shipping panels' limits (Basic, White Balance, Detail,
// Effects, HSL, Colour Grading, Transform, Crop), not the comments in
// develop-params.ts.

import type { DevelopParams } from "./types";
import { DEFAULT_DEVELOP_PARAMS } from "./defaults";
import { HSL_CHANNELS } from "./develop-params";

export type ControlUnit = "EV" | "K" | "°";
export interface DevelopControl {
  key: string;                       // stored key path: "exposure", "vignette.amount", "hsl.saturation.blue"
  label: string;                     // as the panel shows it
  group: string;                     // panel section ("Vignette", "Shadows")
  toolId: string;                    // owning extension id: "safelight.basic"
  kind: "number" | "switch" | "choice" | "id";
  min?: number; max?: number; step?: number;
  unit?: ControlUnit; decimals?: number;
  choices?: readonly { value: string; label: string }[];
  /** "asShot" for temperature; otherwise read from DEFAULT_DEVELOP_PARAMS. */
  defaultFrom?: "asShot";
}

type NumberSpec = Pick<DevelopControl, "min" | "max" | "step" | "unit" | "decimals">;

const num = (
  key: string,
  label: string,
  group: string,
  toolId: string,
  range: NumberSpec,
  extra?: Pick<DevelopControl, "defaultFrom">,
): DevelopControl => ({ key, label, group, toolId, kind: "number", ...range, ...extra });

const span = (min: number, max: number, step = 1, decimals = 0): NumberSpec => ({ min, max, step, decimals });
const signed = span(-100, 100);
const percent = span(0, 100);

const BASIC = "safelight.basic";
const DETAIL = "safelight.detail";
const EFFECTS = "safelight.effects";
const HSL = "safelight.hsl";
const GRADING = "safelight.color-grading";
const TRANSFORM = "safelight.transform";

const basic: DevelopControl[] = [
  num("exposure", "Exposure", "Basic", BASIC, { ...span(-5, 5, 0.1, 2), unit: "EV" }),
  num("contrast", "Contrast", "Basic", BASIC, signed),
  num("highlights", "Highlights", "Basic", BASIC, signed),
  num("highlightDetail", "Highlight Detail", "Basic", BASIC, signed),
  num("shadows", "Shadows", "Basic", BASIC, signed),
  num("shadowDetail", "Shadow Detail", "Basic", BASIC, signed),
  num("whites", "Whites", "Basic", BASIC, signed),
  num("blacks", "Blacks", "Basic", BASIC, signed),
  num("texture", "Texture", "Basic", BASIC, signed),
  num("clarity", "Clarity", "Basic", BASIC, signed),
  num("dehaze", "Dehaze", "Basic", BASIC, signed),
  num("vibrance", "Vibrance", "Basic", BASIC, signed),
  num("saturation", "Saturation", "Basic", BASIC, signed),
];

const whiteBalance: DevelopControl[] = [
  num(
    "temperature", "Temp", "White Balance", "safelight.white-balance",
    { ...span(2000, 50000, 10), unit: "K" },
    { defaultFrom: "asShot" },
  ),
  num("tint", "Tint", "White Balance", "safelight.white-balance", span(-150, 150)),
];

const detail: DevelopControl[] = [
  num("sharpening", "Amount", "Sharpening", DETAIL, span(0, 150)),
  num("sharpenRadius", "Radius", "Sharpening", DETAIL, span(1, 3, 0.1, 1)),
  num("sharpenDetail", "Detail", "Sharpening", DETAIL, percent),
  num("sharpenMasking", "Masking", "Sharpening", DETAIL, percent),
  num("luminanceNR", "Luminance", "Noise Reduction", DETAIL, percent),
  num("luminanceNRDetail", "Luminance Detail", "Noise Reduction", DETAIL, percent),
  num("luminanceNRContrast", "Luminance Contrast", "Noise Reduction", DETAIL, percent),
  num("luminanceNRShadows", "Luminance Shadows", "Noise Reduction", DETAIL, percent),
  num("luminanceNRHighlights", "Luminance Highlights", "Noise Reduction", DETAIL, percent),
  num("colorNR", "Colour", "Noise Reduction", DETAIL, percent),
  num("colorNRDetail", "Colour Detail", "Noise Reduction", DETAIL, percent),
  num("colorNRSmoothness", "Colour Smoothness", "Noise Reduction", DETAIL, percent),
];

const effects: DevelopControl[] = [
  num("vignette.amount", "Amount", "Vignette", EFFECTS, signed),
  num("vignette.midpoint", "Midpoint", "Vignette", EFFECTS, percent),
  num("vignette.roundness", "Roundness", "Vignette", EFFECTS, signed),
  num("vignette.feather", "Feather", "Vignette", EFFECTS, percent),
  num("vignette.highlights", "Highlights", "Vignette", EFFECTS, percent),
  num("grain.amount", "Amount", "Grain", EFFECTS, percent),
  num("grain.size", "Size", "Grain", EFFECTS, span(25, 100)),
  num("grain.roughness", "Roughness", "Grain", EFFECTS, percent),
  num("grain.color", "Colour", "Grain", EFFECTS, percent),
];

const BANDS = [
  { key: "hue", title: "Hue" },
  { key: "saturation", title: "Saturation" },
  { key: "luminance", title: "Luminance" },
] as const;

const hsl: DevelopControl[] = BANDS.flatMap((band) =>
  HSL_CHANNELS.map((channel) =>
    num(`hsl.${band.key}.${channel}`, `${channel[0].toUpperCase()}${channel.slice(1)} ${band.title.toLowerCase()}`, band.title, HSL, signed),
  ),
);

const WHEELS = [
  { key: "shadows", title: "Shadows" },
  { key: "midtones", title: "Midtones" },
  { key: "highlights", title: "Highlights" },
  { key: "global", title: "Global" },
] as const;

const colourGrading: DevelopControl[] = [
  ...WHEELS.flatMap((wheel) => [
    num(`colorGrading.${wheel.key}.hue`, "Hue", wheel.title, GRADING, { ...span(0, 360), unit: "°" }),
    num(`colorGrading.${wheel.key}.sat`, "Saturation", wheel.title, GRADING, percent),
    num(`colorGrading.${wheel.key}.luma`, "Luminance", wheel.title, GRADING, signed),
  ]),
  num("colorGrading.shadowRange", "Shadow Range", "Blending", GRADING, percent),
  num("colorGrading.highlightRange", "Highlight Range", "Blending", GRADING, percent),
];

const transform: DevelopControl[] = [
  num("transform.perspectiveV", "Vertical", "Transform", TRANSFORM, signed),
  num("transform.perspectiveH", "Horizontal", "Transform", TRANSFORM, signed),
  num("transform.aspect", "Aspect", "Transform", TRANSFORM, signed),
  num("transform.scale", "Scale", "Transform", TRANSFORM, span(50, 150)),
  num("transform.offsetX", "Offset X", "Transform", TRANSFORM, signed),
  num("transform.offsetY", "Offset Y", "Transform", TRANSFORM, signed),
  { key: "transform.flipH", label: "Flip horizontal", group: "Transform", toolId: TRANSFORM, kind: "switch" },
  { key: "transform.flipV", label: "Flip vertical", group: "Transform", toolId: TRANSFORM, kind: "switch" },
  {
    key: "uprightMode", label: "Upright", group: "Upright", toolId: TRANSFORM, kind: "choice",
    choices: [
      { value: "off", label: "Off" },
      { value: "level", label: "Level" },
      { value: "vertical", label: "Vertical" },
      { value: "auto", label: "Auto" },
      { value: "full", label: "Full" },
    ],
  },
];

const straighten = num("straighten", "Straighten", "Straighten", "safelight.crop", { ...span(-45, 45, 0.1, 1), unit: "°" });

const displayTransform: DevelopControl = {
  key: "displayTransform", label: "Tone mapper", group: "Display", toolId: "core", kind: "id",
};

export const DEVELOP_CONTROLS: readonly DevelopControl[] = [
  straighten,
  ...transform,
  ...whiteBalance,
  ...basic,
  ...colourGrading,
  ...detail,
  ...effects,
  ...hsl,
  displayTransform,
];

const byKey = new Map(DEVELOP_CONTROLS.map((c) => [c.key, c]));

export function developControl(key: string): DevelopControl | undefined {
  return byKey.get(key);
}

type Node = Record<string, unknown>;

function atPath(root: unknown, path: readonly string[]): unknown {
  let at = root;
  for (const part of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Node)[part];
  }
  return at;
}

export function readControl(params: DevelopParams, c: DevelopControl): unknown {
  return atPath(params, c.key.split("."));
}

function withPath(node: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const base = typeof node === "object" && node !== null ? (node as Node) : {};
  return { ...base, [head]: withPath(base[head], rest, value) };
}

/** `params` with the control's value replaced, copying only the objects on its path. */
export function writeControl(params: DevelopParams, c: DevelopControl, value: unknown): DevelopParams {
  return withPath(params, c.key.split("."), value) as DevelopParams;
}

export function controlDefault(c: DevelopControl, asShot: number): unknown {
  return c.defaultFrom === "asShot" ? asShot : atPath(DEFAULT_DEVELOP_PARAMS, c.key.split("."));
}

/** DevelopParams keys never settable by slu this round, with the user-facing reason. */
export const READ_ONLY_PARAMS: Readonly<Record<string, string>> = {
  toneCurve: "Edit Tone Curve's points in Safelight; safelight can't set them yet.",
  masks: "Edit masks in Safelight; safelight can't set them yet.",
  retouch: "Edit Heal spots in Safelight; safelight can't set them yet.",
  crop: "Draw the crop in Safelight; safelight can't set it yet.",
  guidedLines: "Draw Upright's guide lines in Safelight; safelight can't set them yet.",
  processVersion: "The processing version changes only with Update processing in Safelight.",
};
