// Bake 90°-step rotation into pixels with an OffscreenCanvas, so the GL renderer
// and the thumbnail grid stay orientation-agnostic. EXIF orientation is read at
// import and applied here; manual rotate buttons add further 90° steps.

export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

// EXIF Orientation tag -> clockwise rotation in degrees. The mirrored
// orientations (2/4/5/7) are uncommon; we approximate them to no rotation.
export function orientationToRotation(orientation: number | undefined): number {
  switch (orientation) {
    case 3:
      return 180;
    case 6:
      return 90;
    case 8:
      return 270;
    default:
      return 0;
  }
}

function drawRotated(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  deg: number,
): OffscreenCanvas {
  const swap = deg === 90 || deg === 270;
  const w = swap ? srcH : srcW;
  const h = swap ? srcW : srcH;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(source, -srcW / 2, -srcH / 2, srcW, srcH);
  return canvas;
}

// Returns a new upright bitmap. When no rotation is needed, returns the input
// unchanged (the caller keeps ownership and is responsible for closing it).
export async function rotateBitmap(
  bitmap: ImageBitmap,
  deg: number,
): Promise<ImageBitmap> {
  const d = normalizeRotation(deg);
  if (d === 0) return bitmap;
  const canvas = drawRotated(bitmap, bitmap.width, bitmap.height, d);
  return createImageBitmap(canvas);
}

// Rotate an encoded image blob by a 90° step, re-encoding to JPEG.
export async function rotateBlob(blob: Blob, deg: number): Promise<Blob> {
  const d = normalizeRotation(deg);
  if (d === 0) return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = drawRotated(bitmap, bitmap.width, bitmap.height, d);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}
