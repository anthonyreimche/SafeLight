// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A patch of the live frame at the frame's own pixels, drawn as the canvas
// shows it (api.develop.captureRegion): what a magnifier shows at true pixel
// scale whatever the view's zoom. The develop renderer draws only the patch,
// away from the canvas, so the live view is left as it was.

/** The largest edge of a patch, in frame pixels. */
export const MAX_REGION_EDGE = 1024;

/** A patch asked for: its centre, 0 to 1 across the frame the view shows (x
 *  right, y down), and its size in the frame's pixels. */
export interface RegionRequest {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in the frame's pixels, from its top-left corner. */
export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A patch as the worker reads it: RGBA8 rows from the top, in `colorSpace`
 *  (the canvas's tag), covering `rect` of a frame `frameWidth` × `frameHeight`. */
export interface RegionPixels {
  data: Uint8ClampedArray<ArrayBuffer>;
  rect: RegionRect;
  frameWidth: number;
  frameHeight: number;
  colorSpace: PredefinedColorSpace;
}

/** Where `request` sits in a frame `frameWidth` × `frameHeight`, on whole
 *  pixels: the part inside the frame, or null when none is. */
export function regionPatch(request: RegionRequest, frameWidth: number, frameHeight: number): RegionRect | null {
  const { x, y, width, height } = request;
  if (![x, y, width, height].every(Number.isFinite) || frameWidth < 1 || frameHeight < 1) return null;
  const w = Math.min(MAX_REGION_EDGE, Math.max(1, Math.round(width)));
  const h = Math.min(MAX_REGION_EDGE, Math.max(1, Math.round(height)));
  const left = Math.round(x * frameWidth - w / 2);
  const top = Math.round(y * frameHeight - h / 2);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(frameWidth, left + w);
  const y1 = Math.min(frameHeight, top + h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A float read-back (RGBA, rows from the bottom, display-encoded) as 8-bit
 *  RGBA rows from the top, clamped to [0, 1] and opaque. */
export function regionRgba8(raw: Float32Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(width * height * 4);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * row;
    const to = y * row;
    for (let i = 0; i < row; i += 4) {
      out[to + i] = Math.round(raw[from + i] * 255);
      out[to + i + 1] = Math.round(raw[from + i + 1] * 255);
      out[to + i + 2] = Math.round(raw[from + i + 2] * 255);
      out[to + i + 3] = 255;
    }
  }
  return out;
}

/** A patch of the live frame (api.develop.captureRegion): `bitmap` holds the
 *  part of the patch inside the frame, `rect` in the frame's pixels, of a frame
 *  `frameWidth` × `frameHeight`, encoded for `colorSpace` as the canvas is: draw
 *  it into a 2D context opened with that colour space, or wide colour clips. */
export interface RegionCapture {
  bitmap: ImageBitmap;
  rect: RegionRect;
  frameWidth: number;
  frameHeight: number;
  colorSpace: PredefinedColorSpace;
}

/** The worker's patch as an ImageBitmap in the canvas's colour space. */
export async function regionCapture(pixels: RegionPixels): Promise<RegionCapture> {
  const { data, rect, frameWidth, frameHeight, colorSpace } = pixels;
  const bitmap = await createImageBitmap(new ImageData(data, rect.width, rect.height, { colorSpace }));
  return { bitmap, rect, frameWidth, frameHeight, colorSpace };
}
