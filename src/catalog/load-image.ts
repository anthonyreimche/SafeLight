import type { CatalogPhoto } from "./types";
import { extractRawPreview, isRawFile } from "@/modules/library/raw-preview";
import { decodeRawToBitmap, decodeRawToFloat } from "@/raw/decode";
import { rotateBitmap, rotateFloatRGBA } from "./orient";
import { verifyPermission } from "./permissions";
import { readCachedPreview, writeCachedPreview } from "@/raw/raw-cache";

// Convert sRGB ImageBitmap to pseudo-linear Float32Array by applying inverse gamma
// This allows embedded JPEG previews to be processed through the same shader pipeline
// as true linear RAW data, with limited dynamic range compensation.
async function bitmapToPseudoLinear(
  bitmap: ImageBitmap,
): Promise<{ data: Float32Array; width: number; height: number }> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D context");
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const pixels = imageData.data;
  const floatData = new Float32Array(pixels.length);
  
  // Apply inverse sRGB gamma to convert to pseudo-linear space
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    
    // Inverse sRGB gamma (approximate as power 2.2 for performance)
    floatData[i] = Math.pow(r, 2.2);
    floatData[i + 1] = Math.pow(g, 2.2);
    floatData[i + 2] = Math.pow(b, 2.2);
    floatData[i + 3] = 1.0; // Alpha
  }
  
  return { data: floatData, width: bitmap.width, height: bitmap.height };
}

// A decoded image for the renderer: either a linear float buffer (full sensor
// precision, HDR-capable) or an 8-bit sRGB bitmap (preview/JPEG fallback).
export type DecodedImage =
  | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
  | { kind: "bitmap"; bitmap: ImageBitmap; cached?: boolean };

// Prefer a full-precision linear RAW decode (so exposure/highlight recovery work
// on the sensor's real data); otherwise fall back to the 8-bit bitmap path.
export async function loadPhotoImage(
  photo: CatalogPhoto,
): Promise<DecodedImage | null> {
  if (photo.fileHandle && (await verifyPermission(photo.fileHandle))) {
    try {
      const file = await photo.fileHandle.getFile();
      if (isRawFile(file)) {
        // Fast path: return the cached develop preview (JPEG stored from a
        // previous full decode). Skips libraw entirely — ~50ms vs 3-8s.
        const cached = await readCachedPreview(file);
        if (cached) {
          return { kind: "bitmap", bitmap: cached, cached: true };
        }

        // Slow path: full libraw decode. Write result to cache asynchronously
        // so the next open hits the fast path above.
        const f = await decodeRawToFloat(file);
        if (f) {
          // libraw already applies EXIF orientation; the in-house path doesn't.
          const r = f.oriented
            ? { data: f.data, width: f.width, height: f.height }
            : rotateFloatRGBA(f.data, f.width, f.height, photo.rotation ?? 0);

          // Write to cache in the background — don't block the render.
          writeCachedPreview(file, r.data, r.width, r.height);

          return { kind: "float", data: r.data, width: r.width, height: r.height };
        }

        // If libraw fails, try converting the embedded preview to pseudo-linear
        const preview = await extractRawPreview(file);
        if (preview) {
          const bitmap = await createImageBitmap(preview, { imageOrientation: "none" });
          const upright = await rotateBitmap(bitmap, photo.rotation ?? 0);
          if (upright !== bitmap) bitmap.close();
          const pseudoLinear = await bitmapToPseudoLinear(upright);
          upright.close();
          return {
            kind: "float",
            data: pseudoLinear.data,
            width: pseudoLinear.width,
            height: pseudoLinear.height,
            isFallbackPreview: true,
          };
        }
      }
    } catch {
      // fall through to the bitmap path
    }
  }
  const bitmap = await loadPhotoBitmap(photo);
  return bitmap ? { kind: "bitmap", bitmap } : null;
}

// Decode a photo to a full(er)-resolution bitmap for editing/preview. Prefers
// the original file via its handle; for RAW it attempts a true sensor decode and
// falls back to the embedded JPEG preview, then to the stored thumbnail when the
// handle is gone or permission was not re-granted.
//
// We decode raw pixels (imageOrientation: "none") and apply the photo's baked
// rotation ourselves, so orientation is consistent across JPEG and RAW. The
// stored thumbnail is already upright, so it is used as-is.
export async function loadPhotoBitmap(
  photo: CatalogPhoto,
): Promise<ImageBitmap | null> {
  if (photo.fileHandle && (await verifyPermission(photo.fileHandle))) {
    try {
      const file = await photo.fileHandle.getFile();
      let raw: ImageBitmap | null = null;

      if (isRawFile(file)) {
        raw = await decodeRawToBitmap(file);
        if (!raw) {
          const preview = await extractRawPreview(file);
          raw = preview
            ? await createImageBitmap(preview, { imageOrientation: "none" })
            : null;
        }
      } else {
        raw = await createImageBitmap(file, { imageOrientation: "none" });
      }

      if (raw) {
        const upright = await rotateBitmap(raw, photo.rotation ?? 0);
        if (upright !== raw) raw.close();
        return upright;
      }
    } catch {
      // fall through to the stored thumbnail
    }
  }

  // Fallback: the stored thumbnail is already baked upright.
  if (photo.thumbnailBlob) {
    try {
      return await createImageBitmap(photo.thumbnailBlob, {
        imageOrientation: "none",
      });
    } catch {
      return null;
    }
  }
  return null;
}
