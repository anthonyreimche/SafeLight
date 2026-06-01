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

const MIN_CROP = 0.04; // smallest crop edge, normalized to the image

// Furthest position from `from` (which must be valid) toward `to` for which
// `test` holds. Validity is assumed monotonic along the segment.
function searchEdge(
  from: number,
  to: number,
  test: (v: number) => boolean,
): number {
  if (test(to)) return to;
  let lo = from;
  let hi = to;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (test(m)) lo = m;
    else hi = m;
  }
  return lo;
}

// Constrain a dragged crop to the rotated image so each handle rides the image
// edge nearest the cursor (rather than collapsing toward a corner). `mode` is
// the drag handle ("nw".."move"); `ratioLocked` keeps an aspect-locked crop's
// proportions by pulling straight back along the drag instead.
export function constrainCropToImage(
  start: CropRect,
  target: CropRect,
  mode: string,
  straightenRad: number,
  aspect: number,
  ratioLocked: boolean,
): CropRect {
  if (cropFitsImage(target, straightenRad, aspect)) return target;

  const fits = (l: number, t: number, r: number, b: number) =>
    r - l >= MIN_CROP &&
    b - t >= MIN_CROP &&
    cropFitsImage(
      { x: l, y: t, width: r - l, height: b - t },
      straightenRad,
      aspect,
    );

  const tx0 = target.x;
  const ty0 = target.y;
  const tx1 = target.x + target.width;
  const ty1 = target.y + target.height;

  // A move keeps its size (so the locked ratio is preserved automatically), and
  // wants the box at the position closest to the cursor. The valid translations
  // form a parallelogram whose sides run along the rotated image's edges: d1
  // (image x-edges) and d2 (image y-edges). In that basis the region is an
  // axis-aligned box, so clamping each component independently lands exactly on
  // the nearest valid spot — and slides along the tilted boundary when the box
  // is wedged between two opposite edges (where x/y nudges would both freeze).
  // (det[d1 d2] = 1, so the decomposition is exact.) Handled before the locked
  // branch so locked crops get the same closest-point move, not a lerp-back.
  if (mode === "move") {
    const w = target.width;
    const h = target.height;
    const c = Math.cos(straightenRad);
    const s = Math.sin(straightenRad);
    const d1x = s / aspect;
    const d1y = c;
    const d2x = -c;
    const d2y = aspect * s;
    const tx = tx0 - start.x;
    const ty = ty0 - start.y;
    const aT = aspect * s * tx + c * ty; // target component along d1
    const bT = -c * tx + (s / aspect) * ty; // target component along d2
    let a = 0;
    let b = 0;
    const moveFits = (va: number, vb: number) => {
      const x = start.x + va * d1x + vb * d2x;
      const y = start.y + va * d1y + vb * d2y;
      return fits(x, y, x + w, y + h);
    };
    for (let i = 0; i < 8; i++) {
      a = searchEdge(a, aT, (v) => moveFits(v, b));
      b = searchEdge(b, bT, (v) => moveFits(a, v));
    }
    return {
      x: start.x + a * d1x + b * d2x,
      y: start.y + a * d1y + b * d2y,
      width: w,
      height: h,
    };
  }

  if (ratioLocked) {
    // Resize shrinks about the anchor (corner opposite the handle) so the locked
    // ratio — including a just-flipped orientation — holds at the boundary.
    const anchorX = mode.includes("e") ? target.x : target.x + target.width;
    const anchorY = mode.includes("s") ? target.y : target.y + target.height;
    return fitLockedCrop(target, anchorX, anchorY, straightenRad, aspect);
  }

  // Free resize: coordinate descent from the (valid) start crop toward the
  // cursor, re-clamping each dragged edge against the others' latest values so
  // the handle slides along the tilted boundary instead of sticking.
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  for (let i = 0; i < 8; i++) {
    if (mode.includes("w")) left = searchEdge(left, tx0, (v) => fits(v, top, right, bottom));
    if (mode.includes("e")) right = searchEdge(right, tx1, (v) => fits(left, top, v, bottom));
    if (mode.includes("n")) top = searchEdge(top, ty0, (v) => fits(left, v, right, bottom));
    if (mode.includes("s")) bottom = searchEdge(bottom, ty1, (v) => fits(left, top, right, v));
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Shrink an aspect-locked crop about its anchor corner (opposite the dragged
// handle) until it fits the rotated image, preserving the crop's ratio so a
// constrained drag keeps its locked proportions at the boundary.
export function fitLockedCrop(
  target: CropRect,
  anchorX: number,
  anchorY: number,
  straightenRad: number,
  aspect: number,
): CropRect {
  if (cropFitsImage(target, straightenRad, aspect)) return target;
  const at = (m: number): CropRect => ({
    x: anchorX + (target.x - anchorX) * m,
    y: anchorY + (target.y - anchorY) * m,
    width: target.width * m,
    height: target.height * m,
  });
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (cropFitsImage(at(m), straightenRad, aspect)) lo = m;
    else hi = m;
  }
  return at(lo);
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
