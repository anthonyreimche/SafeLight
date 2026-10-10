// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { reducedMotion } from "./reduced-motion";

// How to stop each overlay's fade still under way: the animation frame it waits on,
// then the timer that lets go of its copy.
const running = new WeakMap<HTMLCanvasElement, () => void>();

/** Fades what `from` shows out over whatever is drawn into it next: copies its
 *  pixels into `overlay` (a canvas laid over it with the same placement), shows the
 *  copy at full opacity and eases it out over `ms`, then lets go of the copy. Call it
 *  before drawing the new frame. Under Reduce motion, or with nothing drawn in
 *  `from`, it fades nothing. Returns whether it started a fade. */
export function snapshotCrossfade(
  from: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  ms: number,
): boolean {
  cancelCrossfade(overlay);
  if (reducedMotion() || !from.width || !from.height) return false;
  overlay.width = from.width;
  overlay.height = from.height;
  const ctx = overlay.getContext("2d");
  if (!ctx) {
    letGo(overlay);
    return false;
  }
  try {
    ctx.drawImage(from, 0, 0);
  } catch {
    letGo(overlay);
    return false; // a tainted canvas can't be copied
  }
  overlay.style.transition = "none";
  overlay.style.opacity = "1";
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The transition starts only once the opaque copy has been painted; set in the
  // same frame, the two opacity changes would merge and nothing would ease.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      overlay.style.transition = `opacity ${ms}ms ease-out`;
      overlay.style.opacity = "0";
      timer = setTimeout(() => {
        running.delete(overlay);
        letGo(overlay);
      }, ms);
    });
  });
  running.set(overlay, () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  });
  return true;
}

/** Ends `overlay`'s fade at once: hidden, whether or not it had started easing, and
 *  its copy let go. */
export function cancelCrossfade(overlay: HTMLCanvasElement): void {
  running.get(overlay)?.();
  running.delete(overlay);
  overlay.style.transition = "none";
  overlay.style.opacity = "0";
  letGo(overlay);
}

// A copy is as big as the frame it was taken from; a 0×0 canvas holds no pixels.
function letGo(overlay: HTMLCanvasElement) {
  overlay.width = 0;
  overlay.height = 0;
}
