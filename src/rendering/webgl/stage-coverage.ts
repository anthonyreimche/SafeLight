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
import { MAX_PAINT_LAYERS, type PaintDab, type PaintLayer, type UniformValue } from "@/extensions/api/contributions";
import type { CoverageItem } from "./mask-coverage";
import type { ContributedBinding } from "./stage-injection";
import { boundValue } from "./uniform-values";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finiteOrAbsent = (v: unknown): v is number | undefined => v === undefined || finite(v);

// The bag is deserialized sidecar JSON, so a dab is checked field by field
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

const isColour = (v: unknown): v is PaintDab["color"] =>
  Array.isArray(v) && v.length === 3 && v.every(finite);

function isPaintDab(value: unknown): value is PaintDab {
  return isBrushDab(value) && "color" in value && isColour(value.color);
}

function paintLayer(item: unknown, index: number): PaintLayer {
  if (typeof item !== "object" || item === null) return { id: String(index), dabs: [] };
  const id = "id" in item && typeof item.id === "string" ? item.id : String(index);
  const dabs: unknown = "dabs" in item ? item.dabs : undefined;
  return { id, dabs: Array.isArray(dabs) && dabs.every(isPaintDab) ? dabs : [] };
}

/** A paint texture's bag value as the layers to bake: at most MAX_PAINT_LAYERS,
 *  each its id and dabs. A malformed layer bakes empty in its own place, so the
 *  layers after it keep the tiles (and the stage's per-layer settings) theirs. */
export function paintLayersFromValue(value: unknown): PaintLayer[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_PAINT_LAYERS).map(paintLayer);
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

/** A stage's dormantWhen (ProcessingStageContribution), each listed value
 *  with the binding its uniform is read through (stage-injection.ts dormantRule). */
export type DormantRule = readonly { readonly binding: ContributedBinding; readonly value: UniformValue }[];

const sameValue = (a: unknown, b: UniformValue): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

/** Whether `bag` holds every value of `rule`, each read as its binding reads
 *  it: a value the uniform can't take, or none, as the uniform's default. */
export function isDormant(rule: DormantRule, bag: Record<string, unknown>): boolean {
  return rule.every(({ binding, value }) => sameValue(boundValue(bag, binding), value));
}
