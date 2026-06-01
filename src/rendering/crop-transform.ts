import type { CropRect } from "@/catalog/types";

export interface Vec2 {
  x: number;
  y: number;
}

// Map a point in the straightened frame (image-normalized, top-left origin) to
// the source image UV. Straighten rotates about the image center, so it is
// independent of the crop — mirrors cropStraightenUV in shaders.ts exactly.
//
// Rotation happens in square-pixel space (the aspect compensation), so a level
// line stays level regardless of the image's proportions.
export function straightenedToSource(
  p: Vec2,
  straightenRad: number,
  aspect: number,
): Vec2 {
  const sx = (p.x - 0.5) * aspect;
  const sy = p.y - 0.5;
  const c = Math.cos(straightenRad);
  const s = Math.sin(straightenRad);
  const rx = sx * c - sy * s;
  const ry = sx * s + sy * c;
  return { x: 0.5 + rx / aspect, y: 0.5 + ry };
}

// Output (crop) coord -> source UV. `o` is [0,1] over the crop region.
export function sourceUV(
  o: Vec2,
  crop: CropRect,
  straightenRad: number,
  aspect: number,
): Vec2 {
  return straightenedToSource(
    { x: crop.x + o.x * crop.width, y: crop.y + o.y * crop.height },
    straightenRad,
    aspect,
  );
}

// Largest centered crop of a given target aspect ratio (width:height, in pixels)
// that fits inside the image. Returns a normalized CropRect.
export function computeCropForAspect(
  targetRatio: number,
  imageAspect: number,
): CropRect {
  const r = targetRatio / imageAspect;
  let width: number;
  let height: number;
  if (r >= 1) {
    width = 1;
    height = 1 / r;
  } else {
    height = 1;
    width = r;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

// A centered region (in straightened-frame coords) that encloses the whole
// image after rotation, so crop mode can show it all with dark margins.
export function rotatedViewCrop(
  straightenRad: number,
  aspect: number,
  pad = 1.06,
): CropRect {
  const c = Math.abs(Math.cos(straightenRad));
  const s = Math.abs(Math.sin(straightenRad));
  const halfW = ((aspect * c + s) / (2 * aspect)) * pad;
  const halfH = ((aspect * s + c) / 2) * pad;
  return { x: 0.5 - halfW, y: 0.5 - halfH, width: 2 * halfW, height: 2 * halfH };
}

function inside(p: Vec2, straightenRad: number, aspect: number): boolean {
  const u = straightenedToSource(p, straightenRad, aspect);
  return u.x >= 0 && u.x <= 1 && u.y >= 0 && u.y <= 1;
}

// Whether the (axis-aligned, straightened-frame) crop lies fully within the
// rotated image — i.e. no empty corners.
export function cropFitsImage(
  crop: CropRect,
  straightenRad: number,
  aspect: number,
): boolean {
  const r = crop.x + crop.width;
  const b = crop.y + crop.height;
  return (
    inside({ x: crop.x, y: crop.y }, straightenRad, aspect) &&
    inside({ x: r, y: crop.y }, straightenRad, aspect) &&
    inside({ x: crop.x, y: b }, straightenRad, aspect) &&
    inside({ x: r, y: b }, straightenRad, aspect)
  );
}

// Shrink the crop about its center to the largest size that still fits the
// rotated image. Returns it unchanged when it already fits.
export function fitCropToImage(
  crop: CropRect,
  straightenRad: number,
  aspect: number,
): CropRect {
  if (cropFitsImage(crop, straightenRad, aspect)) return crop;
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    const w = crop.width * m;
    const h = crop.height * m;
    const c2 = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
    if (cropFitsImage(c2, straightenRad, aspect)) lo = m;
    else hi = m;
  }
  const w = crop.width * lo;
  const h = crop.height * lo;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}
