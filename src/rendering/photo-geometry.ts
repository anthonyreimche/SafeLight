// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";
import { useRegistry } from "@/extensions/registry";
import { geometryKeys, imageGeometry, type ImageGeometry } from "./geometry";
import { deriveStageValues } from "./stage-derive";
import { paramsForDerive, windowDeriveContext } from "./window-derive";

// A photo's geometry on the main thread: what the registered geometry stage
// derives from `params` (geometry.ts), finished for an image of `aspect`. The
// worker's renderer reads the same values from the frame's bag.

// The last geometry handed out, with what it was made from. A derive whose reads
// didn't change hands back the same values, so a slider that doesn't move the
// geometry gets back the same object, and what is drawn from it stays put.
let last: { region: unknown; inverse: unknown; aspect: number; geometry: ImageGeometry } | null = null;

export function photoGeometry(params: DevelopParams, aspect: number): ImageGeometry {
  const stages = Object.values(useRegistry.getState().processingStages);
  const stage = stages.find((s) => s.geometry);
  const keys = geometryKeys(stages);
  const bag = stage && keys ? deriveStageValues(paramsForDerive(params, stages), [stage], windowDeriveContext) : {};
  const region = keys ? bag[keys.region] : undefined;
  const inverse = keys ? bag[keys.inverse] : undefined;
  if (last && last.region === region && last.inverse === inverse && last.aspect === aspect) return last.geometry;
  const geometry = imageGeometry(bag, keys, aspect);
  last = { region, inverse, aspect, geometry };
  return geometry;
}
