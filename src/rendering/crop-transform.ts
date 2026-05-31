import type { CropRect } from "@/catalog/types";

export interface Vec2 {
  x: number;
  y: number;
}

// Reference implementation of the crop + straighten inverse map performed by the
// develop fragment shader (cropStraightenUV in shaders.ts). Output coord `o` is
// in [0,1] with (0,0) at the crop's top-left; returns the source image UV (also
// top-left origin, matching the shader's already-V-flipped vUv). Kept in lockstep
// with the GLSL and unit-tested, so the geometry is verified without a GPU.
//
// Straighten rotates the sampled content about the crop center in square-pixel
// space (hence the aspect compensation), which is why a centered point is fixed
// under any angle.
export function sourceUV(
  o: Vec2,
  crop: CropRect,
  straightenRad: number,
  aspect: number,
): Vec2 {
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  const localX = (o.x - 0.5) * crop.width;
  const localY = (o.y - 0.5) * crop.height;
  const c = Math.cos(straightenRad);
  const s = Math.sin(straightenRad);
  const sx = localX * aspect;
  const sy = localY;
  const rx = sx * c - sy * s;
  const ry = sx * s + sy * c;
  return { x: cx + rx / aspect, y: cy + ry };
}

// Largest centered crop of a given target aspect ratio (width:height, in pixels)
// that fits inside the image. Returns a normalized CropRect.
export function computeCropForAspect(
  targetRatio: number,
  imageAspect: number,
): CropRect {
  // width/height in *normalized* units so that (w·W)/(h·H) == targetRatio.
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
