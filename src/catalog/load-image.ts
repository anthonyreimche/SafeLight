import type { CatalogPhoto } from "./types";
import { extractRawPreview, isRawFile } from "@/modules/library/raw-preview";
import { decodeRawToBitmap, decodeRawToFloat } from "@/raw/decode";
import { rotateBitmap, rotateFloatRGBA } from "./orient";
import { verifyPermission } from "./permissions";
import { readCachedPreview, writeCachedPreview } from "@/raw/raw-cache";

// Read an ImageBitmap into a linear Float32 RGBA image via a temporary WebGL2
// framebuffer. This is more reliable than OffscreenCanvas.getContext("2d")
// readback on Mesa/Linux, where accelerated 2D canvas readback can silently
// return all-zero data.
//
// Pixel layout: texImage2D without UNPACK_FLIP_Y places image row 0 at texture
// y=0 (OpenGL bottom). readPixels reads y=0 first (framebuffer bottom = texture
// y=0 = image row 0), so the output array is already top-to-bottom — no flip
// needed. This matches the layout the renderer expects for Float32 images.
function bitmapToFloat(
  bitmap: ImageBitmap,
): { data: Float32Array; width: number; height: number } {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  if (!gl) throw new Error("WebGL2 unavailable for pixel readback");

  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

  const fb = gl.createFramebuffer();
  if (!fb) throw new Error("createFramebuffer failed");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);

  // Apply the inverse sRGB transfer function (IEC 61966-2-1) to linearise.
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]     / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    data[i]     = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
    data[i + 1] = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
    data[i + 2] = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
    data[i + 3] = 1.0;
  }

  return { data, width, height };
}

// A decoded image for the renderer: a linear float buffer (full sensor precision,
// HDR-capable), a raw 16-bit sRGB buffer (cached develop preview — decoded to
// linear on the GPU), or an 8-bit sRGB bitmap (preview/JPEG fallback).
export type DecodedImage =
  | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
  | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
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
        // Fast path: return the cached develop preview (16-bit sRGB, gzip) from a
        // previous full decode. Skips libraw entirely — ~50ms vs 3-8s. Handed over
        // as raw 16-bit sRGB: the renderer uploads it to a normalized RGBA16 texture
        // and the shader does sRGB->linear, so there's no per-sample CPU decode and
        // the texture is half the bytes of the old Float32 path. Still full precision
        // (no 8-bit posterising under a big exposure push).
        const cached = await readCachedPreview(file);
        if (cached) {
          return { kind: "srgb16", data: cached.data, width: cached.width, height: cached.height };
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

        // If libraw fails, linearise the embedded JPEG preview via a WebGL2
        // framebuffer readback (bitmapToFloat). This keeps the full float
        // pipeline intact. The 2D-canvas readback (prior approach) fails
        // silently on some Mesa/Linux drivers, returning all-zero data.
        const preview = await extractRawPreview(file);
        if (preview) {
          const bitmap = await createImageBitmap(preview, { imageOrientation: "none" });
          const upright = await rotateBitmap(bitmap, photo.rotation ?? 0);
          if (upright !== bitmap) bitmap.close();
          const floatImg = bitmapToFloat(upright);
          upright.close();
          return {
            kind: "float",
            data: floatImg.data,
            width: floatImg.width,
            height: floatImg.height,
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
