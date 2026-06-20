// Generic Develop-canvas integration points exposed to extensions via
// `api.develop`. Core stays blind to what extensions do with them: it only
// provides where the displayed image sits (so an overlay can align to it), a
// signal that the view geometry changed (so an overlay can refresh), and a way
// to render a "before"/override frame off-screen. The Image Comparison
// extension builds before/after modes entirely on top of these.

import { createContext, useContext } from "react";
import type { DevelopParams } from "@/catalog/types";
import { getRenderBridge } from "@/rendering/render-bridge";

export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DevelopOverlayState {
  /** Where the image pixels are shown on screen, in Develop-canvas-local
   *  coords. Null until the first frame lays out. */
  rect: OverlayRect | null;
  /** Bumped whenever the view geometry changes (zoom, pan, fit, resize, photo
   *  switch). An overlay watches this to re-grab a `captureFrame` aligned to the
   *  new view. */
  nonce: number;
}

const DevelopOverlayContext = createContext<DevelopOverlayState>({
  rect: null,
  nonce: 0,
});

export const DevelopOverlayProvider = DevelopOverlayContext.Provider;

/** Read the live Develop-canvas overlay geometry. Call from a component mounted
 *  into the "develop-canvas-overlay" slot. */
export function useDevelopOverlay(): DevelopOverlayState {
  return useContext(DevelopOverlayContext);
}

/** Render one frame through the live Develop pipeline with `params` (at the
 *  current photo, source and viewport) to an ImageBitmap, without disturbing
 *  the on-screen view. Returns a bitmap aligned 1:1 with the displayed canvas —
 *  draw it into an overlay to show a "before" image. */
export function captureDevelopFrame(params: DevelopParams): Promise<ImageBitmap> {
  return getRenderBridge().capture(params);
}
