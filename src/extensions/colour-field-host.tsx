// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.ui.ColourField, bound to one extension: its eyedropper holds the
// pick-drag tool in the extension's name, and samples a capture of the live
// view with the extension's bag merged over the photo's.

import type { JSX } from "react";
import { ColourField, type ColourFieldHost, type ColourFieldProps } from "@/ui/components/ColourField";
import { PICK_PATCH, patchAverage, type Rgb } from "@/ui/colour-field-math";
import type { CanvasPoint } from "@/modules/develop/pick-drag";
import type { DevelopParams } from "@/catalog/develop-params";
import { useDevelopStore } from "@/state/develop-store";
import { captureDevelopFrame } from "./develop-host";

const stageOf = (key: string) => key.slice(0, key.lastIndexOf("."));

/** `params` with `patch` over each mask's copy of a stage the patch names, so
 *  the effect the patch switches off is off inside masks too. A mask without
 *  that stage gains no copy of it. */
export function withMaskPatch(params: DevelopParams, patch: Record<string, unknown>): DevelopParams {
  const keys = Object.keys(patch);
  if (keys.length === 0 || !params.masks.some((m) => m.bag)) return params;
  return {
    ...params,
    masks: params.masks.map((m) => {
      if (!m.bag) return m;
      const stages = new Set(Object.keys(m.bag).map(stageOf));
      const hits = keys.filter((k) => stages.has(stageOf(k)));
      return hits.length === 0 ? m : { ...m, bag: { ...m.bag, ...Object.fromEntries(hits.map((k) => [k, patch[k]])) } };
    }),
  };
}

/** The PICK_PATCH average around a canvas point of the view captured with
 *  `paramBag`; null off the frame, for the 1×1 "no renderer" blank, or when
 *  another photo opened before the capture landed. The capture is aligned 1:1
 *  with the canvas, so a canvas pixel is a frame pixel. The bag reaches the
 *  stage's copies inside masks too. */
export async function sampleCapture(point: CanvasPoint, paramBag: Record<string, unknown>): Promise<Rgb | null> {
  const dev = useDevelopStore.getState();
  const photoId = dev.photoId;
  const bitmap = await captureDevelopFrame(withMaskPatch(dev.previewParams ?? dev.params, paramBag), { paramBag });
  try {
    const { width, height } = bitmap;
    if (useDevelopStore.getState().photoId !== photoId || width < 2 || height < 2) return null;
    const px = Math.floor(point.x);
    const py = Math.floor(point.y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const half = PICK_PATCH >> 1;
    const x0 = Math.max(0, px - half);
    const y0 = Math.max(0, py - half);
    const w = Math.min(width - 1, px + half) - x0 + 1;
    const h = Math.min(height - 1, py + half) - y0 + 1;
    const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, x0, y0, w, h, 0, 0, w, h);
    return patchAverage(ctx.getImageData(0, 0, w, h).data, w, h, px - x0, py - y0);
  } finally {
    bitmap.close();
  }
}

export function colourFieldFor(owner: string): (props: ColourFieldProps) => JSX.Element {
  const host: ColourFieldHost = { owner, sample: sampleCapture };
  return function ExtensionColourField(props: ColourFieldProps) {
    return <ColourField {...props} host={host} />;
  };
}
