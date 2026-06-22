import type { CropRect, LensCorrectionParams } from "@/catalog/types";
import type { ResolvedProfile } from "@/lens-profiles/types";
import { computeAutoCropScale } from "@/lens-profiles/auto-crop";
import { mat3Apply, type Mat3, type Vec2 } from "./transform";

export type { Vec2 } from "./transform";

// Lens distortion correction expressed in CPU form, mirroring lensCorrectedUV in
// shaders.ts so the crop constraint sees the SAME warped image the renderer draws
// (uniform-inset approximations let the crop be dragged into the black margins a
// curved distortion leaves behind). `model`: 1=poly3, 2=poly5, 3=ptlens, 0=none.
export interface LensDistort {
  model: number;
  a: number;
  b: number;
  c: number;
  manual: number; // additive manual-slider distortion (matches uLensDistortion)
  autoCropScale: number; // >= 1; zoom that hides the corrected borders
  aspect: number; // image width/height, for the aspect-correct radius
}

// Build the distortion descriptor exactly as the renderer configures its
// uniforms (see renderer.ts setParams), or null when no distortion is in play.
export function buildLensDistort(
  lc: LensCorrectionParams,
  profile: ResolvedProfile | null,
  aspect: number,
): LensDistort | null {
  if (lc.mode === "off") return null;
  const useProfile =
    lc.mode === "profile" && !!profile?.distortion && lc.distortionEnabled;
  let model = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  let autoCropScale = 1;
  if (useProfile && profile?.distortion) {
    const d = profile.distortion;
    model = d.model === "poly3" ? 1 : d.model === "poly5" ? 2 : 3;
    a = d.k[0] ?? 0;
    b = d.k.length > 1 ? d.k[1] : (d.k[0] ?? 0);
    c = d.k[2] ?? 0;
    // Auto-crop only applies to profile distortion and only when enabled — the
    // renderer gates uLensAutoCropScale the same way.
    if (lc.autoCrop) autoCropScale = computeAutoCropScale(d.model, d.k, lc.distortion, aspect);
  }
  const manual = lc.distortion; // additive in both profile and manual modes
  if (model === 0 && Math.abs(manual) <= 0.001) return null;
  return { model, a, b, c, manual, autoCropScale, aspect };
}

// Source UV -> sampled source UV after distortion correction. Black appears
// wherever this lands outside [0,1]², so this is exactly the renderer's
// validity test. Mirrors lensCorrectedUV (incl. lensRadius) in shaders.ts.
function lensCorrectUV(u: Vec2, d: LensDistort): Vec2 {
  const cx = u.x - 0.5;
  const cy = u.y - 0.5;
  const halfDiag = 0.5 * Math.sqrt(d.aspect * d.aspect + 1);
  const r = Math.hypot(cx * d.aspect, cy) / halfDiag;
  const r2 = r * r;
  let scale = 1;
  if (d.model === 1) scale = 1 - d.b + d.b * r2;
  else if (d.model === 2) scale = 1 + d.b * r2 + d.a * r2 * r2;
  else if (d.model === 3)
    scale = d.a * r2 * r + d.b * r2 + d.c * r + (1 - d.a - d.b - d.c);
  if (Math.abs(d.manual) > 0.001) scale += d.manual * 0.0003 * r2;
  let x = 0.5 + cx * scale;
  let y = 0.5 + cy * scale;
  if (d.autoCropScale > 1.001) {
    x = 0.5 + (x - 0.5) / d.autoCropScale;
    y = 0.5 + (y - 0.5) / d.autoCropScale;
  }
  return { x, y };
}

// Map a point in the (cropped) transformed frame to source UV via the inverse
// transform. Mirrors cropTransformUV in shaders.ts exactly.
export function transformedToSource(p: Vec2, inv: Mat3): Vec2 {
  return mat3Apply(inv, p.x, p.y);
}

// Output (crop) coord -> source UV. `o` is [0,1] over the crop region.
export function sourceUV(o: Vec2, crop: CropRect, inv: Mat3): Vec2 {
  return mat3Apply(inv, crop.x + o.x * crop.width, crop.y + o.y * crop.height);
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

// A region (in transformed-frame coords) that encloses the whole image after
// the geometry transform, so crop mode can show it all with dark margins.
export function transformedViewCrop(forward: Mat3, pad = 1.06): CropRect {
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [u, v] of corners) {
    const p = mat3Apply(forward, u, v);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfW = ((maxX - minX) / 2) * pad;
  const halfH = ((maxY - minY) / 2) * pad;
  return { x: cx - halfW, y: cy - halfH, width: 2 * halfW, height: 2 * halfH };
}

function inside(p: Vec2, inv: Mat3, distort?: LensDistort | null): boolean {
  let u = mat3Apply(inv, p.x, p.y);
  if (distort) u = lensCorrectUV(u, distort);
  return u.x >= 0 && u.x <= 1 && u.y >= 0 && u.y <= 1;
}

// Whether the (axis-aligned, transformed-frame) crop lies fully within the
// transformed image — i.e. no empty corners. With lens distortion the image
// boundary curves (and can go concave), so corners alone don't bound the rect;
// we also sample along each edge.
export function cropFitsImage(
  crop: CropRect,
  inv: Mat3,
  distort?: LensDistort | null,
): boolean {
  const r = crop.x + crop.width;
  const b = crop.y + crop.height;
  if (
    !inside({ x: crop.x, y: crop.y }, inv, distort) ||
    !inside({ x: r, y: crop.y }, inv, distort) ||
    !inside({ x: crop.x, y: b }, inv, distort) ||
    !inside({ x: r, y: b }, inv, distort)
  ) {
    return false;
  }
  if (!distort) return true;
  // Curved boundary: check interior points along each edge too.
  const SEGS = 4;
  for (let i = 1; i < SEGS; i++) {
    const t = i / SEGS;
    const x = crop.x + t * crop.width;
    const y = crop.y + t * crop.height;
    if (
      !inside({ x, y: crop.y }, inv, distort) ||
      !inside({ x, y: b }, inv, distort) ||
      !inside({ x: crop.x, y }, inv, distort) ||
      !inside({ x: r, y }, inv, distort)
    ) {
      return false;
    }
  }
  return true;
}

const MIN_CROP = 0.04; // smallest crop edge, normalized to the image

interface Plane {
  nx: number;
  ny: number;
  b: number;
} // half-plane: nx·x + ny·y ≤ b

// Closest point to `p` within the intersection of half-planes (a convex polygon
// that always contains the origin). Returns `p` if already inside; otherwise the
// nearest boundary point (checking edge-line projections and vertices).
function closestInHalfplanes(p: Vec2, planes: Plane[]): Vec2 {
  const eps = 1e-7;
  const feasible = (q: Vec2) =>
    planes.every((pl) => pl.nx * q.x + pl.ny * q.y <= pl.b + eps);
  if (feasible(p)) return p;

  let best: Vec2 = { x: 0, y: 0 }; // t=0 (start position) is always valid
  let bestD = p.x * p.x + p.y * p.y;
  const consider = (q: Vec2) => {
    if (!feasible(q)) return;
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  };
  for (const pl of planes) {
    const len2 = pl.nx * pl.nx + pl.ny * pl.ny;
    if (len2 < 1e-12) continue;
    const dist = (pl.nx * p.x + pl.ny * p.y - pl.b) / len2;
    consider({ x: p.x - dist * pl.nx, y: p.y - dist * pl.ny });
  }
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      const a = planes[i];
      const b = planes[j];
      const det = a.nx * b.ny - a.ny * b.nx;
      if (Math.abs(det) < 1e-12) continue;
      consider({
        x: (a.b * b.ny - a.ny * b.b) / det,
        y: (a.nx * b.b - a.b * b.nx) / det,
      });
    }
  }
  return best;
}

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

// Constrain a dragged crop to the transformed image so each handle rides the
// image edge nearest the cursor. `mode` is the drag handle ("nw".."move").
// `inv` maps transformed coord -> source UV; `forward` maps source -> transformed
// (used to find the image quadrilateral for the exact move projection). `aspect`
// is the image aspect, used as the on-screen distance metric.
export function constrainCropToImage(
  start: CropRect,
  target: CropRect,
  mode: string,
  inv: Mat3,
  forward: Mat3,
  aspect: number,
  ratioLocked: boolean,
  distort?: LensDistort | null,
): CropRect {
  if (cropFitsImage(target, inv, distort)) return target;

  const fits = (l: number, t: number, r: number, b: number) =>
    r - l >= MIN_CROP &&
    b - t >= MIN_CROP &&
    cropFitsImage({ x: l, y: t, width: r - l, height: b - t }, inv, distort);

  const tx0 = target.x;
  const ty0 = target.y;
  const tx1 = target.x + target.width;
  const ty1 = target.y + target.height;

  // A move keeps its size, so the locked ratio is preserved automatically and we
  // just want the box at the position closest to the cursor. The image occupies
  // a convex quadrilateral Q in the transformed frame; the translations that
  // keep all crop corners inside Q form a convex polygon (Q eroded by the crop).
  // We project the desired translation onto that polygon in screen-isotropic
  // space — the exact nearest valid position, for rotation and perspective
  // alike. Handled before the locked branch so locked crops move the same way.
  if (mode === "move") {
    // Lens distortion makes the boundary non-convex, so the half-plane
    // projection below no longer holds. Slide from the (valid) start toward the
    // desired position as far as the whole box stays inside.
    if (distort) {
      const dx = target.x - start.x;
      const dy = target.y - start.y;
      const at = (m: number): CropRect => ({
        x: start.x + dx * m,
        y: start.y + dy * m,
        width: target.width,
        height: target.height,
      });
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const m = (lo + hi) / 2;
        if (cropFitsImage(at(m), inv, distort)) lo = m;
        else hi = m;
      }
      return at(lo);
    }
    const w = target.width;
    const h = target.height;
    const Q = [
      mat3Apply(forward, 0, 0),
      mat3Apply(forward, 1, 0),
      mat3Apply(forward, 1, 1),
      mat3Apply(forward, 0, 1),
    ];
    const cx = (Q[0].x + Q[1].x + Q[2].x + Q[3].x) / 4;
    const cy = (Q[0].y + Q[1].y + Q[2].y + Q[3].y) / 4;
    const corners = [
      { x: start.x, y: start.y },
      { x: start.x + w, y: start.y },
      { x: start.x + w, y: start.y + h },
      { x: start.x, y: start.y + h },
    ];
    // Half-planes n·t ≤ b on the translation t, rescaled into screen-isotropic
    // space (x·aspect) so the projection minimizes on-screen distance.
    const planes: Plane[] = [];
    for (let e = 0; e < 4; e++) {
      const A = Q[e];
      const B = Q[(e + 1) % 4];
      let nx = B.y - A.y;
      let ny = -(B.x - A.x);
      let d = nx * A.x + ny * A.y;
      if (nx * cx + ny * cy > d) {
        nx = -nx;
        ny = -ny;
        d = -d;
      }
      let maxNC = -Infinity;
      for (const c of corners) maxNC = Math.max(maxNC, nx * c.x + ny * c.y);
      planes.push({ nx: nx / aspect, ny, b: d - maxNC });
    }
    const uStar = { x: (tx0 - start.x) * aspect, y: ty0 - start.y };
    const u = closestInHalfplanes(uStar, planes);
    return { x: start.x + u.x / aspect, y: start.y + u.y, width: w, height: h };
  }

  if (ratioLocked) {
    // Resize shrinks about the anchor so the locked ratio — including a
    // just-flipped orientation — holds at the boundary. For a corner that anchor
    // is the opposite corner; for an edge it's the opposite edge's midpoint, so
    // shrinking keeps the perpendicular axis centred (matching applyDrag).
    let anchorX: number, anchorY: number;
    if (mode === "e" || mode === "w") {
      anchorX = mode === "e" ? target.x : target.x + target.width;
      anchorY = target.y + target.height / 2;
    } else if (mode === "n" || mode === "s") {
      anchorX = target.x + target.width / 2;
      anchorY = mode === "s" ? target.y : target.y + target.height;
    } else {
      anchorX = mode.includes("e") ? target.x : target.x + target.width;
      anchorY = mode.includes("s") ? target.y : target.y + target.height;
    }
    return fitLockedCrop(target, anchorX, anchorY, inv, distort);
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
// handle) until it fits the transformed image, preserving the crop's ratio.
export function fitLockedCrop(
  target: CropRect,
  anchorX: number,
  anchorY: number,
  inv: Mat3,
  distort?: LensDistort | null,
): CropRect {
  if (cropFitsImage(target, inv, distort)) return target;
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
    if (cropFitsImage(at(m), inv, distort)) lo = m;
    else hi = m;
  }
  return at(lo);
}

// Shrink the crop about its center to the largest size that still fits the
// transformed image. Returns it unchanged when it already fits.
export function fitCropToImage(
  crop: CropRect,
  inv: Mat3,
  distort?: LensDistort | null,
): CropRect {
  if (cropFitsImage(crop, inv, distort)) return crop;
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    const w = crop.width * m;
    const h = crop.height * m;
    const c2 = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
    if (cropFitsImage(c2, inv, distort)) lo = m;
    else hi = m;
  }
  const w = crop.width * lo;
  const h = crop.height * lo;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

// Largest centered crop that fits inside the transformed image. When
// cropAspect > 0 the crop keeps that ratio; otherwise it scales a full-frame
// rectangle uniformly. Used by "constrain crop" to maximise the visible area.
export function maxCropForTransform(
  inv: Mat3,
  cropAspect: number,
  distort?: LensDistort | null,
): CropRect {
  const full: CropRect = cropAspect > 0
    ? computeCropForAspect(cropAspect, 1)
    : { x: 0, y: 0, width: 1, height: 1 };
  return fitCropToImage(
    { x: 0.5 - full.width / 2, y: 0.5 - full.height / 2, width: full.width, height: full.height },
    inv,
    distort,
  );
}
