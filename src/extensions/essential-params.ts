// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";

// The develop adjustments the processing Essentials render. Their params stay
// in DevelopParams, so a photo keeps them while the extension is away, but
// renders without them: Develop says so (MissingAdjustmentsNotice). A tool
// joins this list when it leaves core.

export interface EssentialAdjustments {
  /** The official extension that renders them. */
  id: string;
  name: string;
  params: readonly (keyof DevelopParams)[];
  /** Whether `params` uses them, where that isn't "away from the default":
   *  White Balance opens each photo at its as-shot temperature, and every photo
   *  opens with some sharpening. */
  inUse?(params: DevelopParams, asShotTemperature: number): boolean;
}

export const ESSENTIAL_ADJUSTMENTS: readonly EssentialAdjustments[] = [
  { id: "safelight.crop", name: "Crop & Straighten", params: ["crop", "straighten"] },
  { id: "safelight.transform", name: "Transform", params: ["transform", "uprightMode", "guidedLines"] },
  {
    id: "safelight.white-balance",
    name: "White Balance",
    params: ["temperature", "tint"],
    inUse: (p, asShot) => p.temperature !== asShot || p.tint !== 0,
  },
  {
    id: "safelight.basic",
    name: "Basic",
    params: [
      "exposure",
      "contrast",
      "highlights",
      "highlightDetail",
      "shadows",
      "shadowDetail",
      "whites",
      "blacks",
      "texture",
      "clarity",
      "dehaze",
      "vibrance",
      "saturation",
    ],
  },
  { id: "safelight.tone-curve", name: "Tone Curve", params: ["toneCurve"] },
  { id: "safelight.color-grading", name: "Color Grading", params: ["colorGrading"] },
  {
    id: "safelight.detail",
    name: "Detail",
    params: ["sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking"],
    inUse: (p) => p.sharpening > 0,
  },
  { id: "safelight.effects", name: "Effects", params: ["vignette", "grain"] },
  { id: "safelight.hsl", name: "HSL", params: ["hsl"] },
  { id: "safelight.heal", name: "Heal", params: ["retouch"] },
  { id: "safelight.masks", name: "Masking", params: ["masks"] },
];

const differs = (params: DevelopParams, key: keyof DevelopParams): boolean =>
  JSON.stringify(params[key]) !== JSON.stringify(DEFAULT_DEVELOP_PARAMS[key]);

/** The essentials `params` uses (any of their params away from its default,
 *  or as `inUse` says) that `running` says aren't running, for a photo shot at
 *  `asShotTemperature`. */
export function missingAdjustments(
  params: DevelopParams,
  running: (id: string) => boolean,
  asShotTemperature: number,
): EssentialAdjustments[] {
  const uses = (e: EssentialAdjustments) =>
    e.inUse ? e.inUse(params, asShotTemperature) : e.params.some((k) => differs(params, k));
  return ESSENTIAL_ADJUSTMENTS.filter((e) => !running(e.id) && uses(e));
}

/** The essentials that render nothing now: neither in `running` nor
 *  registering one of `stages`. */
export function stoppedEssentials(
  running: readonly string[],
  stages: readonly { extensionId?: unknown }[],
): string[] {
  return ESSENTIAL_ADJUSTMENTS.map((e) => e.id).filter(
    (id) => !running.includes(id) && !stages.some((s) => s.extensionId === id),
  );
}

// Each params object's results, by the stopped essentials: the live photo's
// and a thumbnail's params are met by turns.
const stoppedResults = new WeakMap<DevelopParams, Map<string, DevelopParams>>();

/** `params` with the params of the `stopped` essentials at their defaults,
 *  for derive: a stage that reads another tool's params (Crop's matrix reads
 *  Transform's) drops that tool with it. The same object when nothing
 *  changes, and the same result for the same call, so derive's memo holds. */
export function withStoppedEssentials(params: DevelopParams, stopped: readonly string[]): DevelopParams {
  const key = stopped.join("|");
  let results = stoppedResults.get(params);
  const known = results?.get(key);
  if (known) return known;
  const reset = ESSENTIAL_ADJUSTMENTS.filter((e) => stopped.includes(e.id))
    .flatMap((e) => e.params)
    .filter((k) => differs(params, k));
  const result =
    reset.length === 0 ? params : { ...params, ...Object.fromEntries(reset.map((k) => [k, DEFAULT_DEVELOP_PARAMS[k]])) };
  if (!results) stoppedResults.set(params, (results = new Map()));
  results.set(key, result);
  return result;
}
