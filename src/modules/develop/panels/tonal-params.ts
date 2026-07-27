// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Single source for the tonal develop sliders' ranges, shared by the Basic panel
// and the histogram's draggable zones so their limits can't drift.

import type { DevelopParams } from "@/catalog/types";

export type NumericParamKey = {
  [K in keyof DevelopParams]: DevelopParams[K] extends number ? K : never;
}[keyof DevelopParams];

export const TONAL_PARAM_RANGE = {
  exposure: { min: -5, max: 5 },
  contrast: { min: -100, max: 100 },
  highlights: { min: -100, max: 100 },
  highlightDetail: { min: -100, max: 100 },
  shadows: { min: -100, max: 100 },
  shadowDetail: { min: -100, max: 100 },
  whites: { min: -100, max: 100 },
  blacks: { min: -100, max: 100 },
  texture: { min: -100, max: 100 },
  clarity: { min: -100, max: 100 },
  dehaze: { min: -100, max: 100 },
  vibrance: { min: -100, max: 100 },
  saturation: { min: -100, max: 100 },
} satisfies Record<string, { min: number; max: number }> &
  Partial<Record<NumericParamKey, { min: number; max: number }>>;

export type TonalParamKey = keyof typeof TONAL_PARAM_RANGE;
