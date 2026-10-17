// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An image shown in a frame, in the frame's CSS px. The image is W×H at scale 1:
// one pixel of the whole-image buffer per CSS px.

/** How the image sits in the frame: drawn at `scale`, its top-left corner at (x, y). */
export interface View {
  scale: number;
  x: number;
  y: number;
}

/** A region of the image, normalized to [0, 1] on each axis. */
export interface ImageWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

/** Where a buffer holding `win` of the image (null: all of it) sits under `view`. */
export function placeBuffer(win: ImageWindow | null, view: View, image: Size): Rect {
  const w = image.w * view.scale;
  const h = image.h * view.scale;
  if (!win) return { x: view.x, y: view.y, w, h };
  return { x: view.x + win.x * w, y: view.y + win.y * h, w: win.w * w, h: win.h * h };
}

/** The window of the image `view` shows in `frame`, kept inside the image. */
export function viewWindow(view: View, frame: Size, image: Size): ImageWindow {
  const x = Math.max(0, Math.min(1, -view.x / view.scale / image.w));
  const y = Math.max(0, Math.min(1, -view.y / view.scale / image.h));
  return {
    x,
    y,
    w: Math.max(0.001, Math.min(1 - x, frame.w / view.scale / image.w)),
    h: Math.max(0.001, Math.min(1 - y, frame.h / view.scale / image.h)),
  };
}

/** `view` moved as little as it takes for the image to cover the frame on each axis
 *  it is larger than the frame, and centred on each it is not. */
export function clampView(view: View, frame: Size, image: Size): View {
  const w = image.w * view.scale;
  const h = image.h * view.scale;
  return {
    scale: view.scale,
    x: w <= frame.w ? (frame.w - w) / 2 : Math.min(0, Math.max(frame.w - w, view.x)),
    y: h <= frame.h ? (frame.h - h) / 2 : Math.min(0, Math.max(frame.h - h, view.y)),
  };
}

/** The view `e` of the way from `from` to `to`: the scaling about the frame point both
 *  views put at the same image point (an anchored zoom's anchor), its scale moving
 *  geometrically so each step looks alike. A pure pan moves in a line. */
export function interpolateView(from: View, to: View, e: number): View {
  if (e <= 0) return from;
  if (e >= 1) return to;
  const k = to.scale / from.scale;
  if (Math.abs(k - 1) < 1e-6) {
    return {
      scale: from.scale + (to.scale - from.scale) * e,
      x: from.x + (to.x - from.x) * e,
      y: from.y + (to.y - from.y) * e,
    };
  }
  const ke = Math.pow(k, e);
  // The scaling by ke about F = (to − k·from) / (1 − k), written so a k near 1
  // never divides a large F back down.
  const r = (1 - ke) / (1 - k);
  return {
    scale: from.scale * ke,
    x: ke * from.x + (to.x - k * from.x) * r,
    y: ke * from.y + (to.y - k * from.y) * r,
  };
}

/** Fast at first, settling gently; `t` is clamped to [0, 1]. */
export function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u;
}
