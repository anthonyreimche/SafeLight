// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Canonical metadata + routed read/write for "nested" develop scalars — ones
// that live INSIDE a structured param object (e.g. params.vignette.amount).
// Top-level scalars are driven directly with setParam(key, value); these need
// the owning object merged, so a generic tool (or extension) can't drive them
// without knowing the shape. This module is that knowledge, in one place: it's
// the single source for the Effects panel's sliders AND the backing for
// api.develop.adjustments, so the two can never drift.

import { useDevelopStore } from "./develop-store";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";

export interface NestedAdjustment {
  /** Stable id "<parent>.<field>" — also the dotted value path into params. */
  key: string;
  label: string;
  /** Section heading (e.g. "Vignette"). */
  group: string;
  /** The structured param object this lives in. */
  parent: "vignette" | "grain";
  /** Sub-key within that object. */
  field: string;
  min: number;
  max: number;
  step: number;
}

// Ranges mirror the Effects panel exactly (it derives its sliders from here).
export const NESTED_ADJUSTMENTS: NestedAdjustment[] = [
  { key: "vignette.amount",     label: "Amount",     group: "Vignette", parent: "vignette", field: "amount",     min: -100, max: 100, step: 1 },
  { key: "vignette.midpoint",   label: "Midpoint",   group: "Vignette", parent: "vignette", field: "midpoint",   min: 0,    max: 100, step: 1 },
  { key: "vignette.roundness",  label: "Roundness",  group: "Vignette", parent: "vignette", field: "roundness",  min: -100, max: 100, step: 1 },
  { key: "vignette.feather",    label: "Feather",    group: "Vignette", parent: "vignette", field: "feather",    min: 0,    max: 100, step: 1 },
  { key: "vignette.highlights", label: "Highlights", group: "Vignette", parent: "vignette", field: "highlights", min: 0,    max: 100, step: 1 },
  { key: "grain.amount",        label: "Amount",     group: "Grain",    parent: "grain",    field: "amount",     min: 0,    max: 100, step: 1 },
  { key: "grain.size",          label: "Size",       group: "Grain",    parent: "grain",    field: "size",       min: 25,   max: 100, step: 1 },
  { key: "grain.roughness",     label: "Roughness",  group: "Grain",    parent: "grain",    field: "roughness",  min: 0,    max: 100, step: 1 },
  { key: "grain.color",         label: "Color",      group: "Grain",    parent: "grain",    field: "color",      min: 0,    max: 100, step: 1 },
];

export const VIGNETTE_ADJUSTMENTS = NESTED_ADJUSTMENTS.filter((a) => a.parent === "vignette");
export const GRAIN_ADJUSTMENTS = NESTED_ADJUSTMENTS.filter((a) => a.parent === "grain");

const byKey = new Map(NESTED_ADJUSTMENTS.map((a) => [a.key, a]));

export interface AdjustmentInfo {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export function listAdjustments(): AdjustmentInfo[] {
  const defs = DEFAULT_DEVELOP_PARAMS as unknown as Record<string, Record<string, number>>;
  return NESTED_ADJUSTMENTS.map((a) => ({
    key: a.key,
    label: a.label,
    group: a.group,
    min: a.min,
    max: a.max,
    step: a.step,
    default: Number(defs[a.parent]?.[a.field]) || 0,
  }));
}

export function getAdjustment(key: string): number {
  const a = byKey.get(key);
  if (!a) return 0;
  const parent = (useDevelopStore.getState().params as unknown as Record<string, Record<string, number>>)[a.parent];
  const v = parent ? parent[a.field] : undefined;
  return typeof v === "number" ? v : 0;
}

/** Live-set (no history commit — the caller batches a commitEdit), merging the
 *  value into its owning structured object so the renderer + panel both update. */
export function setAdjustment(key: string, value: number): void {
  const a = byKey.get(key);
  if (!a) return;
  const st = useDevelopStore.getState();
  if (a.parent === "vignette") {
    st.setParam("vignette", { ...st.params.vignette, [a.field]: value });
  } else {
    st.setParam("grain", { ...st.params.grain, [a.field]: value });
  }
}
