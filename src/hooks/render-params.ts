// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";
import { applyPanelBypass } from "@/modules/develop/panel-bypass";
import { transformedViewCrop } from "@/rendering/crop-transform";
import { buildForwardTransform } from "@/rendering/transform";

export type RenderParamsFor = (
  params: DevelopParams,
  cropping: boolean,
  aspect: number,
  bypassed: Record<string, boolean>,
) => DevelopParams;

/** Makes the function that returns the params the live view draws: the edit with its
 *  bypassed panels neutralised and, in crop mode, the crop widened to enclose the whole
 *  transformed image. View-only; the stored edit is untouched. Either step builds a new
 *  object whenever it applies, and the bridge posts each object it is handed once, so the
 *  last result is kept and returned again while `params` and `bypassed` are the same
 *  objects (callers replace them on change, never mutate them) and `cropping` and
 *  `aspect` the same values. */
export function createRenderParams(): RenderParamsFor {
  let last: {
    params: DevelopParams;
    cropping: boolean;
    aspect: number;
    bypassed: Record<string, boolean>;
    drawn: DevelopParams;
  } | null = null;

  return (params, cropping, aspect, bypassed) => {
    if (
      last &&
      last.params === params &&
      last.cropping === cropping &&
      last.aspect === aspect &&
      last.bypassed === bypassed
    ) {
      return last.drawn;
    }
    const bp = applyPanelBypass(params, bypassed);
    const drawn = cropping
      ? {
          ...bp,
          crop: transformedViewCrop(buildForwardTransform(bp.straighten, bp.transform, aspect)),
        }
      : bp;
    last = { params, cropping, aspect, bypassed, drawn };
    return drawn;
  };
}
