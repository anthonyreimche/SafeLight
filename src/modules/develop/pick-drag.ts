// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";

// The canvas's pick-drag tool: an extension's on-image press or drag (White
// Balance's eyedropper, HSL's target tool). While one is held, a press on the
// image goes to the tool: at once to `onPress`, and, for a tool with `onDown`,
// with the colour the view shows there once the probe answers, then the drag
// (DevelopCanvas). One extension holds it at a time; ephemeral, never
// persisted.

/** A point on the canvas, in its pixels, from its top-left corner. */
export interface CanvasPoint {
  x: number;
  y: number;
}

export interface PickDragTool {
  /** A press on the image, as it happens. */
  onPress?(point: CanvasPoint): void;
  /** A press on the image with the colour the view shows there, sRGB 0-1,
   *  once the probe answers; never for a press released before that. */
  onDown?(rgb: readonly [number, number, number], point: CanvasPoint): void;
  /** The drag, after an onDown. */
  onMove?(point: CanvasPoint): void;
  /** The drag ended, after an onDown. */
  onUp?(): void;
}

interface Held {
  owner: string;
  tool: PickDragTool;
}

export const usePickDragStore = create<{ held: Held | null }>(() => ({ held: null }));

/** Hand the canvas `owner`'s tool, or with null take `owner`'s tool back; a
 *  tool another extension holds stays. */
export function setPickDrag(owner: string, tool: PickDragTool | null): void {
  if (tool) usePickDragStore.setState({ held: { owner, tool } });
  else if (usePickDragStore.getState().held?.owner === owner) usePickDragStore.setState({ held: null });
}
