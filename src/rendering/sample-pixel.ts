// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Read a small averaged patch from the rendered develop canvas and return it in
// linear light. Used by the white-balance eyedropper: the clicked point's colour
// (post-render, display sRGB) is averaged over a few pixels to reject noise, then
// linearised so the WB solver works in the same space as Auto WB's histogram means.
// Under a Linux display profile the canvas holds monitor values, which are
// taken back to sRGB-linear first.

import { monitorToSrgbLinear } from "./display-profile";
import { activeMonitorTransform } from "./display-profile-store";

const PATCH = 5; // odd box side, in canvas (buffer) pixels — Lightroom-style 5×5

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const srgbTripleToLinear = (r: number, g: number, b: number): [number, number, number] => [
  srgbToLinear(r),
  srgbToLinear(g),
  srgbToLinear(b),
];

// Tiny scratch canvas reused across samples (one per call would thrash the GC).
let scratch: HTMLCanvasElement | null = null;

/**
 * Average a PATCH×PATCH box centred on (bx,by) in canvas buffer pixels and return
 * its linear [r,g,b] (0..1), or null if the point is outside the image.
 */
export function sampleLinearRGB(
  canvas: HTMLCanvasElement,
  bx: number,
  by: number,
): [number, number, number] | null {
  const W = canvas.width;
  const H = canvas.height;
  if (W <= 0 || H <= 0) return null;
  const cx = Math.round(bx);
  const cy = Math.round(by);
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;

  const half = PATCH >> 1;
  const x0 = Math.max(0, cx - half);
  const y0 = Math.max(0, cy - half);
  const x1 = Math.min(W - 1, cx + half);
  const y1 = Math.min(H - 1, cy + half);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;

  if (!scratch) scratch = document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // drawImage copies the WebGL canvas's current (preserved) drawing buffer.
  ctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  const monitor = activeMonitorTransform();
  const toLinear = monitor ? monitorToSrgbLinear(monitor) : srgbTripleToLinear;
  let r = 0;
  let g = 0;
  let b = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const lin = toLinear(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255);
    r += lin[0];
    g += lin[1];
    b += lin[2];
  }
  return [r / n, g / n, b / n];
}
