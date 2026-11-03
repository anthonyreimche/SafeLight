// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "@/catalog/types";
import { applyPanelBypass } from "@/modules/develop/panel-bypass";

/** The params a held canvas tool has the live view draw (CanvasTool.viewParams). */
export type ViewParams = (params: DevelopParams) => DevelopParams;

export type RenderParamsFor = (
  params: DevelopParams,
  view: ViewParams | null,
  aspect: number,
  bypassed: Record<string, boolean>,
) => DevelopParams;

/** Makes the function that returns the params the live view draws: the edit with its
 *  bypassed panels neutralized, passed through the held canvas tool's view (crop mode
 *  widens the crop to enclose the whole transformed image). View-only; the stored edit is
 *  untouched. Either step builds a new object whenever it applies, and the bridge posts
 *  each object it is handed once, so the last result is kept and returned again while
 *  `params` and `bypassed` are the same objects (callers replace them on change, never
 *  mutate them) and `view` and `aspect` the same. With a view, params that draw the same
 *  values as the last get the last result too: a drag of the crop box, which crop mode
 *  doesn't draw, then asks the renderer for nothing. */
export function createRenderParams(): RenderParamsFor {
  let last: {
    params: DevelopParams;
    view: ViewParams | null;
    aspect: number;
    bypassed: Record<string, boolean>;
    drawn: DevelopParams;
  } | null = null;

  return (params, view, aspect, bypassed) => {
    const same = last && last.view === view && last.aspect === aspect && last.bypassed === bypassed;
    if (same && last!.params === params) return last!.drawn;
    const bp = applyPanelBypass(params, bypassed);
    const drawn = view ? view(bp) : bp;
    if (same && view && sameValues(drawn, last!.drawn)) {
      last!.params = params;
      return last!.drawn;
    }
    last = { params, view, aspect, bypassed, drawn };
    return drawn;
  };
}

/** Whether every top-level field holds the same value in both, by identity or,
 *  for a field rebuilt as a new object, by its contents. */
function sameValues(a: DevelopParams, b: DevelopParams): boolean {
  const ka = Object.keys(a) as (keyof DevelopParams)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k] || JSON.stringify(a[k]) === JSON.stringify(b[k]));
}
