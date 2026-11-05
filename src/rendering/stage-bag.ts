// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";
import { resolvePipelineFor } from "@/extensions/pipelines";
import { bagForRender } from "@/extensions/transform-derive";
import { denoiseBag } from "./webgl/builtin-denoise";

/** The stage bag a frame of `params` draws with: `paramBag`, the photo's own stage
 *  entries, under the entries Safelight's built-in stages take from `params` (the
 *  Detail panel's noise reduction). Every render of an edit draws with it: the live
 *  Develop view (with its bypassed panels taken out first), the edited grid
 *  thumbnail, `api.develop.renderPhotoFrame`, export and the Library histogram. The
 *  render bridge adds the display transform's derived uniforms to a bag it is
 *  handed; a renderer in the window takes windowFrameBag. */
export function frameStageBag(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
): Record<string, unknown> {
  return { ...paramBag, ...denoiseBag(params) };
}

/** frameStageBag with the derived uniforms of the display transform `params`
 *  picks (bagForRender), for a renderer in the window, which the render bridge
 *  doesn't feed. */
export function windowFrameBag(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
): Record<string, unknown> {
  return bagForRender(resolvePipelineFor(params.displayTransform), frameStageBag(params, paramBag));
}
