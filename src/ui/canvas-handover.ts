// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop builds a new view, with a new display canvas, for every photo
// (DevelopView keys it by photo), so a switch would show the bare surround until the
// next photo's first picture. The view going away leaves its picture here, and the
// next one shows it until its own first picture, for at most HANDOVER_MS. Both
// happen in one React commit: the old view's layout cleanup, then the new one's
// layout effect.

/** How long a picture left by the view before may stay on screen. */
export const HANDOVER_MS = 150;

export interface LeftPicture {
  /** The old display canvas. Out of the document, it keeps its pixels. */
  canvas: HTMLCanvasElement;
  /** Where its pixels showed, in the viewport's own CSS px. */
  rect: { x: number; y: number; w: number; h: number };
  /** Width of the colour-assessment mat around it, 0 without one. */
  mat: number;
}

let left: (LeftPicture & { at: number }) | null = null;
// The handover canvas of the view showing `left`.
let shownOn: HTMLCanvasElement | null = null;
let cap: ReturnType<typeof setTimeout> | undefined;

/** Leaves the picture a view showed as it goes, for the next view to take. */
export function leavePicture(picture: LeftPicture): void {
  endHandover();
  left = { ...picture, at: performance.now() };
  cap = setTimeout(endHandover, HANDOVER_MS);
  dropIfUntaken();
}

/** Shows the picture left by the view before on `into`: drawn at its own size and
 *  placed where it showed, never stretched to the next photo's shape. Returns
 *  whether there was one to show. */
export function takeHandover(into: HTMLCanvasElement): boolean {
  if (!left) return false;
  const { width, height } = left.canvas;
  // drawImage throws on a canvas with no pixels, and this runs in a layout effect,
  // where a throw takes the whole view down.
  if (performance.now() - left.at > HANDOVER_MS || !width || !height) {
    endHandover();
    return false;
  }
  const ctx = into.getContext("2d");
  if (!ctx) return false;
  into.width = width;
  into.height = height;
  ctx.drawImage(left.canvas, 0, 0);
  const { x, y, w, h } = left.rect;
  Object.assign(into.style, {
    display: "block",
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
    boxShadow: left.mat > 0 ? `0 0 0 ${left.mat}px #ffffff` : "none",
  });
  shownOn = into;
  return true;
}

/** The view with `into` goes before its own first picture: the picture it showed
 *  stays for the next view to take. */
export function releaseHandover(into: HTMLCanvasElement): void {
  hide(into);
  if (shownOn !== into) return;
  shownOn = null;
  dropIfUntaken();
}

/** Hides the picture handed over and lets go of it: the next photo's own first
 *  picture is on screen, or the time is up. */
export function endHandover(): void {
  if (shownOn) hide(shownOn);
  shownOn = null;
  left = null;
  clearTimeout(cap);
}

function hide(into: HTMLCanvasElement) {
  into.style.display = "none";
  into.width = 0;
  into.height = 0;
}

// No view takes a picture left when Develop closes, or the project does. A view
// coming in the same commit takes it before the commit's microtasks run.
function dropIfUntaken() {
  queueMicrotask(() => {
    if (left && !shownOn) endHandover();
  });
}
