// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CanvasPoint } from "./pick-drag";

// The colour the develop canvas shows at a point in its pixels, read from the
// render worker's live frame (sRGB 0-1), or null with no canvas or no frame.
// The mounted canvas lends its probe here (DevelopCanvas), so the eyedropper's
// convergence loop and extensions can ask by point.

type Probe = (point: CanvasPoint) => Promise<readonly [number, number, number] | null>;

let current: Probe | null = null;

/** Lend the canvas's probe while it is mounted; returns the release. */
export function lendCanvasProbe(probe: Probe): () => void {
  current = probe;
  return () => {
    if (current === probe) current = null;
  };
}

export function probeCanvas(point: CanvasPoint): Promise<readonly [number, number, number] | null> {
  return current ? current(point) : Promise.resolve(null);
}
