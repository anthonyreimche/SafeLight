// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "./develop-params";

/** Every edit saved before process versions existed. */
export const LEGACY_PROCESS_VERSION = 1;
/** What new edits are made with. Version 2: tools after the display transform
 *  work on unclipped values unless a tool that needs [0, 1] is in use. */
export const CURRENT_PROCESS_VERSION = 2;
/** Label of the history step that moves a photo to CURRENT_PROCESS_VERSION.
 *  Develop's button and the Library menu both write it, and it is stored in the
 *  photo's history, so the two must agree. */
export const UPDATE_PROCESSING_LABEL = "Update processing";

/** A stored version as a version: anything that isn't an integer ≥ 1 is an
 *  edit from before process versions, which renders as version 1. */
export function normalizeProcessVersion(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= LEGACY_PROCESS_VERSION
    ? v
    : LEGACY_PROCESS_VERSION;
}

/** A partial edit (preset, pasted settings) never carries a process version:
 *  applying one keeps the target's. */
export function withoutProcessVersion(p: Partial<DevelopParams>): Partial<DevelopParams> {
  const out = { ...p };
  delete out.processVersion;
  return out;
}

/** True when the edit renders with an earlier process version than the current
 *  one, which is when Update processing has something to do. A version from a
 *  newer build is not older. Develop's button and both update paths ask this, so
 *  the button shows exactly when the action acts. */
export function usesOlderProcessing(params: Pick<DevelopParams, "processVersion">): boolean {
  return params.processVersion < CURRENT_PROCESS_VERSION;
}

/** True when the edit is stored as process version 3 or later, the versions whose
 *  output stage takes signed colour (ShaderVariant.signedOutput). It reads the
 *  stored version alone, whatever this build writes or renders, so the soft proof
 *  controls and the proof they ask for agree on which photos have one. */
export function usesSignedOutput(params: Pick<DevelopParams, "processVersion">): boolean {
  return normalizeProcessVersion(params.processVersion) >= 3;
}
