// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto } from "./types";
import { extractRawPreview, isRawFile } from "@/modules/library/raw-preview";
import { decodeNetpbm, isNetpbmName } from "@/modules/library/netpbm";
import { decodeTiff, isTiffName } from "@/modules/library/tiff-image";
import { decodeRawToBitmap, decodeRawToFloat } from "@/raw/decode";
import {
  normalizeRotation,
  orientationToRotation,
  previewUprightRotation,
  rotateBitmap,
  rotateFloatRGBA,
} from "./orient";
import { verifyPermission } from "./permissions";
import { rawCacheKey, readCachedPreview, writeCachedPreview } from "@/raw/raw-cache";
import { catalogStorage } from "./storage";

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

// Compare the decoded RAW float image's channel balance against the embedded
// JPEG preview (the camera's own rendering — always color-correct).
// Returns true when the decode looks plausible, false when it should be rejected.
//
// Metric: compute the R/G and B/G ratios for each image in linear space,
// then flag a mismatch when either ratio differs by more than 2×. This catches
// the well-known LibRaw <0.21 Canon EOS R bug (wrong color matrix → badly
// shifted R/B gains) without false-positives on legitimate warm/cool shots.
async function rawColorMatchesPreview(
  raw: { data: Float32Array; width: number; height: number },
  previewBlob: Blob,
): Promise<boolean> {
  try {
    // Downscale the preview to 64 px for a fast sample; use ImageBitmap resize
    // so we don't pull a big JPEG into a canvas.
    const thumb = await createImageBitmap(previewBlob, {
      resizeWidth: 64,
      resizeHeight: 64,
      resizeQuality: "pixelated",
    });
    const pf = bitmapToFloat(thumb);
    thumb.close();

    // Mean R/G/B of the JPEG preview (linear after inverse-sRGB in bitmapToFloat).
    let pR = 0, pG = 0, pB = 0;
    for (let i = 0; i < pf.data.length; i += 4) {
      pR += pf.data[i]; pG += pf.data[i + 1]; pB += pf.data[i + 2];
    }
    const pN = pf.data.length / 4;

    // Mean R/G/B of the RAW decode, sampled at a stride to keep it fast.
    const n = raw.width * raw.height;
    const step = Math.max(1, Math.floor(n / 4096));
    let rR = 0, rG = 0, rB = 0, rN = 0;
    for (let i = 0; i < n * 4; i += step * 4) {
      rR += raw.data[i]; rG += raw.data[i + 1]; rB += raw.data[i + 2]; rN++;
    }

    if (!rN || !pN) return true;
    const rg = (rG / rN) || 1e-6;
    const pg = (pG / pN) || 1e-6;

    // Normalised R/G and B/G ratios for each source.
    const rawRG = (rR / rN) / rg,  preRG = (pR / pN) / pg;
    const rawBG = (rB / rN) / rg,  preBG = (pB / pN) / pg;

    const rgFactor = Math.max(rawRG / preRG, preRG / rawRG);
    const bgFactor = Math.max(rawBG / preBG, preBG / rawBG);

    console.info(
      `[load] RAW vs JPEG — R/G: ${rawRG.toFixed(2)} vs ${preRG.toFixed(2)} (×${rgFactor.toFixed(2)}),` +
      ` B/G: ${rawBG.toFixed(2)} vs ${preBG.toFixed(2)} (×${bgFactor.toFixed(2)})`,
    );

    return rgFactor < 2.0 && bgFactor < 2.0;
  } catch {
    return true; // if comparison fails, trust the decode
  }
}

// Stable key for a photo's decoded source pixels, used by the GPU source cache.
// Develop edits are parameters (not pixels), so only identity + baked rotation
// change the decoded buffer. A rotation change re-decodes under a new key; the old
// entry ages out via LRU.
export function photoSourceKey(photo: CatalogPhoto): string {
  return `${photo.id}:${photo.rotation ?? 0}`;
}

export interface LoadImageOptions {
  // Called with a fast, near-full-res intermediate (the camera's embedded JPEG)
  // as soon as it's available, BEFORE the slow libraw float decode finishes.
  // Lets Develop paint a sharp image in ~1s on a cache miss instead of holding
  // the soft 768px thumbnail for 5-10s while libraw runs. Only fires on the RAW
  // slow path (a cache hit is already fast and skips it).
  onPreview?: (image: DecodedImage) => void;
}

// Prefer a full-precision linear RAW decode (so exposure/highlight recovery work
// on the sensor's real data); otherwise fall back to the 8-bit bitmap path.
export async function loadPhotoImage(
  photo: CatalogPhoto,
  opts?: LoadImageOptions,
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
        const cacheKey = rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0);
        const cached = await readCachedPreview(cacheKey);
        if (cached) {
          return { kind: "srgb16", data: cached.data, width: cached.width, height: cached.height };
        }

        // Slow path: full libraw decode. Write result to cache asynchronously
        // so the next open hits the fast path above.
        // Extract the embedded JPEG preview once — used both for the color
        // validation below and as the fallback if the RAW decode looks wrong.
        const preview = await extractRawPreview(file);

        // Paint the embedded preview immediately (camera-rendered, decodes in
        // ~1s) so the user sees a sharp frame while libraw grinds. The precise
        // float decode swaps in below; a slight tonal shift on swap is expected
        // (preview is camera-toned, the float decode is linear + base curve).
        if (preview && opts?.onPreview) {
          try {
            const bm = await createImageBitmap(preview, { imageOrientation: "none" });
            // Embedded previews are usually sensor-native and carry no orientation
            // tag — orient from the master EXIF, aspect-gated (see orient.ts).
            const deg = previewUprightRotation(
              bm.width, bm.height, photo.rotation ?? 0, photo.exif?.orientation,
            );
            const upright = await rotateBitmap(bm, deg);
            if (upright !== bm) bm.close();
            opts.onPreview({ kind: "bitmap", bitmap: upright });
          } catch { /* preview paint is best-effort */ }
        }

        const f = await decodeRawToFloat(file);
        if (f) {
          // Propagate the as-shot WB temperature from the decode to the photo's
          // EXIF so the UI can display the camera's actual shooting temperature.
          if (f.colorTemperature && !photo.exif.colorTemperature) {
            photo.exif.colorTemperature = f.colorTemperature;
            // Persist so the cached-preview fast path has it next time.
            catalogStorage().putPhoto(photo);
          }

          // photo.rotation = EXIF orientation + manual user rotation (from import).
          // When the decoder already oriented the pixels, subtract the EXIF portion
          // so only manual rotation remains — otherwise we'd double-rotate.
          let rotateDeg = photo.rotation ?? 0;
          if (f.oriented) {
            rotateDeg = normalizeRotation(rotateDeg - orientationToRotation(photo.exif?.orientation));
          }
          const r = rotateFloatRGBA(f.data, f.width, f.height, rotateDeg);

          // Validate the decode's color against the embedded JPEG preview.
          // An unrecognised camera body (e.g. newer Canon EOS R bodies with
          // LibRaw <0.21) produces grossly wrong R/G and B/G ratios. If either
          // is off by more than 2× vs the preview, reject the decode and fall
          // through to the JPEG-based float path below.
          const colorOk = !preview || await rawColorMatchesPreview(r, preview);
          if (colorOk) {
            // Skip the cache when the decode was marginal (inferred dimensions).
            if (!f.suspicious) {
              writeCachedPreview(cacheKey, r.data, r.width, r.height);
            }
            return { kind: "float", data: r.data, width: r.width, height: r.height };
          }
          console.warn("[load] RAW color mismatch vs embedded JPEG — using JPEG fallback");
        }

        // libraw failed or produced bad colors: fall back to the embedded JPEG
        // preview as an 8-bit bitmap. We deliberately do NOT route it through
        // bitmapToFloat's WebGL2 readback here — that spins up a second GL
        // context (fragile on old Mesa/Linux GPUs, where readback can silently
        // return all zeros → a black export/preview) and quadruples memory for
        // no gain: the JPEG is already 8-bit sRGB with the camera's tone baked
        // in, so there's no extra dynamic range to recover. The renderer's 8-bit
        // bitmap path handles edits the same way it does for any JPEG.
        if (preview) {
          const bitmap = await createImageBitmap(preview, { imageOrientation: "none" });
          const deg = previewUprightRotation(
            bitmap.width, bitmap.height, photo.rotation ?? 0, photo.exif?.orientation,
          );
          const upright = await rotateBitmap(bitmap, deg);
          if (upright !== bitmap) bitmap.close();
          return { kind: "bitmap", bitmap: upright };
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
      let decoderOriented = false;
      // True when `raw` is an embedded camera preview (sensor-native, no own
      // orientation tag): orient it from the master EXIF, aspect-gated, rather
      // than blindly applying photo.rotation as if it were already correct.
      let fromPreview = false;

      if (isRawFile(file)) {
        const result = await decodeRawToBitmap(file);
        if (result) {
          raw = result.bitmap;
          decoderOriented = result.oriented;
        } else {
          const preview = await extractRawPreview(file);
          raw = preview
            ? await createImageBitmap(preview, { imageOrientation: "none" })
            : null;
          fromPreview = raw !== null;
        }
      } else if (isNetpbmName(file.name)) {
        raw = await decodeNetpbm(file);
      } else if (isTiffName(file.name)) {
        raw = await decodeTiff(file);
      } else {
        raw = await createImageBitmap(file, { imageOrientation: "none" });
      }

      if (raw) {
        let rotateDeg = photo.rotation ?? 0;
        if (decoderOriented) {
          rotateDeg = normalizeRotation(rotateDeg - orientationToRotation(photo.exif?.orientation));
        } else if (fromPreview) {
          rotateDeg = previewUprightRotation(
            raw.width, raw.height, rotateDeg, photo.exif?.orientation,
          );
        }
        const upright = await rotateBitmap(raw, rotateDeg);
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
