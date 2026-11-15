// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The look-merging rule of Paste Settings and preset apply, free of stores so the
// app and `slu` merge the same way: the pasted subset goes over the photo's current
// look, and a paste never moves a photo between process versions.

import { DEFAULT_DEVELOP_PARAMS, normalizeParams, withoutProcessVersion, type DevelopParams } from "./types";
import type { StoredLook } from "./stored-edit-look";
import { normalizeParamBag } from "@/extensions/param-registry";

/** A partial look: only the adjustments that were copied or saved. */
export interface PartialLook {
  params: Partial<DevelopParams>;
  paramBag: Record<string, unknown>;
}

export function pasteLook(base: StoredLook, clip: PartialLook): StoredLook {
  return {
    params: normalizeParams({ ...base.params, ...withoutProcessVersion(clip.params) }),
    paramBag: { ...base.paramBag, ...normalizeParamBag(clip.paramBag) },
  };
}

/** The DevelopParams keys that describe one frame's geometry and content. Copy
 *  Settings lists them but never pre-selects them, since a paste fans out over
 *  whole selections. `processVersion` is never copied. */
export const PER_PHOTO_PARAM_KEYS: readonly (keyof DevelopParams)[] = [
  "crop", "straighten", "transform", "uprightMode", "guidedLines", "retouch",
];

const NEVER_COPIED: readonly (keyof DevelopParams)[] = ["processVersion", "displayTransform"];

/** What Copy Settings pre-selects: every adjustment that differs from its default,
 *  minus the per-photo ones, plus the whole extension bag. */
export function defaultCopy(look: StoredLook): PartialLook {
  const params: Partial<DevelopParams> = {};
  for (const key of Object.keys(look.params) as (keyof DevelopParams)[]) {
    if (PER_PHOTO_PARAM_KEYS.includes(key) || NEVER_COPIED.includes(key)) continue;
    if (JSON.stringify(look.params[key]) === JSON.stringify(DEFAULT_DEVELOP_PARAMS[key])) continue;
    (params as Record<string, unknown>)[key] = structuredClone(look.params[key]);
  }
  return { params, paramBag: structuredClone(look.paramBag) };
}
