// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";
import { denoiseBag } from "./webgl/builtin-denoise";

/** The stage bag a frame of `params` draws with: `paramBag`, the photo's own stage
 *  entries, under the entries Safelight's built-in stages take from `params` (the
 *  Detail panel's noise reduction). The live Develop view and
 *  `api.develop.renderPhotoFrame` both draw with it. */
export function frameStageBag(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
): Record<string, unknown> {
  return { ...paramBag, ...denoiseBag(params) };
}
