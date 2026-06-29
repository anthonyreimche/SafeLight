// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared "zoom-gesture" signal for the Develop canvas. When the user holds a
// pan/zoom gesture key (Ctrl/⌘ or Space) over the image, this flips true.
//
// It's published from ViewportImage (which owns the key detection) and read by
// any layer stacked over the canvas — the built-in crop/mask overlay and, as a
// global trait, the develop-canvas-overlay slot that hosts EVERY extension
// overlay. While it's true those layers go click-through, so the pan/zoom
// machinery underneath receives the pointer. This is what lets Ctrl/Space pan
// and zoom work no matter which extension tool is currently capturing the canvas
// — extensions get it for free instead of each re-implementing the passthrough.

import { create } from "zustand";

export const useCanvasGesture = create<{ zoomGesture: boolean }>(() => ({
  zoomGesture: false,
}));

/** Set by ViewportImage's gesture-key listener. */
export function setCanvasZoomGesture(active: boolean): void {
  if (useCanvasGesture.getState().zoomGesture !== active) {
    useCanvasGesture.setState({ zoomGesture: active });
  }
}
