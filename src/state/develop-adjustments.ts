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
import { DEVELOP_CONTROLS } from "@/catalog/develop-controls";

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

// Ranges come from the core control table (catalog/develop-controls.ts), which
// mirrors the Effects extension's sliders (safelight.effects).
export const NESTED_ADJUSTMENTS: NestedAdjustment[] = DEVELOP_CONTROLS.flatMap((c) => {
  const [parent, field] = c.key.split(".");
  if ((parent !== "vignette" && parent !== "grain") || c.min === undefined || c.max === undefined || c.step === undefined) return [];
  return [{ key: c.key, label: c.label, group: c.group, parent, field, min: c.min, max: c.max, step: c.step }];
});

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
  const parent = (st.params as unknown as Record<string, Record<string, number>>)[a.parent] ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  st.setParam(a.parent as any, { ...parent, [a.field]: value } as any);
}
