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

export interface OverlayPoint {
  x: number;
  y: number;
}

export interface DevelopOverlayState {
  /** Where the displayed image pixels sit on screen, in Develop-canvas-local
   *  coords. In a zoomed (ROI) view this is the visible window. Use it to align
   *  a captured "before" frame. Null until the first frame lays out. */
  rect: OverlayRect | null;
  /** Where the FULL image sits in the same coords (extends past the frame when
   *  zoomed) — the frame for the mapping helpers below. Null until first layout. */
  imageRect: OverlayRect | null;
  /** Bumped whenever the view geometry changes (zoom, pan, fit, resize, photo
   *  switch). An overlay watches this to re-grab a `captureFrame` aligned to the
   *  new view. */
  nonce: number;
  /** Source-UV (0..1 of the original image) -> screen point, in Develop-canvas
   *  coords. Accounts for zoom, pan, crop, and straighten/perspective — the same
   *  mapping the built-in mask/heal overlays use, so interactive marks anchored
   *  to the image stay correct at any zoom. Null until first layout. */
  toScreen: ((u: number, v: number) => OverlayPoint) | null;
  /** Screen point (Develop-canvas coords) -> source-UV. Inverse of toScreen. */
  toImage: ((x: number, y: number) => OverlayPoint) | null;
  /** A source-UV radius (fraction of image height) -> on-screen pixels. */
  radiusToScreen: ((r: number) => number) | null;
  /** On-screen pixels -> source-UV radius (fraction of image height). */
  radiusToImage: ((px: number) => number) | null;
}

const DevelopOverlayContext = createContext<DevelopOverlayState>({
  rect: null,
  imageRect: null,
  nonce: 0,
  toScreen: null,
  toImage: null,
  radiusToScreen: null,
  radiusToImage: null,
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
