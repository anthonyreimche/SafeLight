// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Coverage-kind stage textures. An extension stage declares
// `textures: [{ key, kind: "coverage" }]` and paints a BrushDab[] into the
// photo's paramBag at "{stageId}.{key}"; the renderer folds those dabs into the
// brush coverage atlas and hands the stage's GLSL a `float key(vec2 uv)`
// helper. These are the pure pieces of that path — what a bag value must look
// like to be baked, and which bag values engage a stage's prepasses — kept
// canvas-free so they run in the node unit suite.

import type { BrushDab } from "@/catalog/types";
import type { CoverageItem } from "./mask-coverage";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finiteOrAbsent = (v: unknown): v is number | undefined => v === undefined || finite(v);

// The bag is deserialised sidecar JSON, so a dab is checked field by field
// before the bake trusts it.
function isBrushDab(value: unknown): value is BrushDab {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Partial<Record<keyof BrushDab, unknown>>;
  return (
    finite(d.x) &&
    finite(d.y) &&
    finite(d.radius) &&
    finite(d.feather) &&
    typeof d.erase === "boolean" &&
    finiteOrAbsent(d.opacity) &&
    finiteOrAbsent(d.flow)
  );
}

export function isBrushDabList(value: unknown): value is BrushDab[] {
  return Array.isArray(value) && value.every(isBrushDab);
}

/** Atlas items for the coverage keys a bag actually paints, in key order.
 *  Absent, empty and malformed values contribute nothing. */
export function coverageItemsFromBag(
  keys: readonly string[],
  bag: Record<string, unknown>,
): CoverageItem[] {
  const items: CoverageItem[] = [];
  for (const key of keys) {
    const dabs = bag[key];
    if (isBrushDabList(dabs) && dabs.length > 0) items.push({ id: key, dabs });
  }
  return items;
}

/** Whether a bag value engages its stage's prepass: a non-zero number, a true
 *  bool, or a numeric vector with a non-zero component. A dab list is spatial
 *  data rather than a strength, so it never counts. */
export function paramIsActive(value: unknown): boolean {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.some((x) => typeof x === "number" && x !== 0);
  return false;
}
