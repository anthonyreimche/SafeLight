// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { getSettings } from "@/state/settings-store";

// Pointer position in an element's local LAYOUT pixels — the coordinate space
// CSS `left`/`top` and the on-screen `rect` the canvas overlays draw in use.
//
// We can't just do `clientX - rect.left`: the "Interface scale" setting applies
// `zoom: uiScale` to <body> (see settings-store applySideEffects). Under CSS
// `zoom`, Chromium/Electron report BOTH clientX and getBoundingClientRect() in
// zoomed *visual* pixels, while elements stay positioned in unzoomed *layout*
// pixels — so the raw offset is scaled by the zoom and hit-testing drifts (at
// >100% you can only grab the NW crop/mask handle, and must aim up-and-left of
// it). Dividing by the cumulative zoom maps the pointer back into layout space.
// <body> is the only zoomed ancestor, so that factor is exactly uiScale; at
// 100% it is 1 and this is a no-op. Works for SVG roots too (which, unlike
// HTMLElement, expose no reliable offsetWidth to measure the zoom from).
export function frameLocalPoint(
  rect: { left: number; top: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const z = uiZoom();
  return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
}

/** The cumulative visual→layout zoom factor: <body> is the only zoomed
 *  ancestor, so this is exactly the Interface-scale setting. Divide client-px
 *  coordinates (and window.inner* extents) by it to get layout px. */
export function uiZoom(): number {
  return getSettings().uiScale || 1;
}
