// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The import pixel stage — decode → orient → thumbnail encode — as a pure task
// that runs identically inside the import worker pool or inline on the main
// thread. It must stay DOM-free and must not import anything with module-level
// side effects (settings, stores): everything it needs arrives in the input.
//
// The task covers RAW embedded previews, TIFF and Netpbm (whose pure-JS
// decoders would otherwise hold the main thread through a whole 16-bit scan),
// and plain browser-decodable images. Anything else — rendered-mode RAW,
// libraw fallbacks — answers { ok: false }, as does a file it can't decode, and
// the caller runs the full inline decode chain (import-photos.ts).

import {
  distrustsEmbeddedPreview,
  extractRawPreviewDecoded,
  isRawFile,
  jpegDimensions,
  prefersEmbeddedPreview,
  sensorNativeJpeg,
} from "@/raw/raw-preview";
import {
  orientationToRotation,
  previewUprightRotation,
  rotateBitmap,
} from "@/catalog/orient";
import { decodeNetpbm, isNetpbmName } from "@/raw/netpbm";
import { decodeTiffBuffer, isTiffName } from "@/raw/tiff-image";
import type { PreviewSource } from "@/state/settings-store";

export interface ThumbTaskInput {
  /** The file's bytes — transferred to the worker, so the sender's copy detaches. */
  buffer: ArrayBuffer;
  name: string;
  type: string;
  lastModified: number;
  orientation: number | undefined;
  previewSource: PreviewSource;
  thumbMaxEdge: number;
}

export type ThumbTaskResult =
  | { ok: true; thumb: Blob; width: number; height: number }
  | { ok: false };

// Bake `rotation` into a JPEG grid preview capped at maxSize on the long edge.
// (Moved here from import-photos so the worker and the inline chain share one
// definition.) 768 default: comfortably covers the largest grid cell.
export async function createThumbnail(
  bitmap: ImageBitmap,
  rotation: number,
  maxSize: number = 768,
): Promise<Blob> {
  // Upright dimensions (swapped for quarter turns), then bake the rotation in so
  // the stored thumbnail is already correctly oriented.
  const swap = rotation === 90 || rotation === 270;
  const srcW = swap ? bitmap.height : bitmap.width;
  const srcH = swap ? bitmap.width : bitmap.height;
  const scale = Math.min(maxSize / srcW, maxSize / srcH, 1);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
}

// A sensor-native bitmap baked upright from the EXIF orientation. `width` and
// `height` are the true size it stands for, which a downscaled decode is under.
async function bakedThumb(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  orientation: number | undefined,
  thumbMaxEdge: number,
): Promise<ThumbTaskResult> {
  const bake = orientationToRotation(orientation);
  const thumb = await createThumbnail(bitmap, bake, thumbMaxEdge);
  bitmap.close();
  const swap = bake === 90 || bake === 270;
  return {
    ok: true,
    thumb,
    width: swap ? height : width,
    height: swap ? width : height,
  };
}

export async function runThumbTask(input: ThumbTaskInput): Promise<ThumbTaskResult> {
  const { buffer, name, type, lastModified, orientation, previewSource, thumbMaxEdge } =
    input;
  const file = new File([buffer], name, { type, lastModified });

  if (isRawFile(file)) {
    // Rendered mode and distrusted containers (CRW) always take the libraw
    // chain; auto/embedded try the camera's preview.
    if (previewSource === "rendered" || distrustsEmbeddedPreview(file))
      return { ok: false };
    const preview = await extractRawPreviewDecoded(file, {
      targetLongEdge: thumbMaxEdge,
    });
    if (!preview) return { ok: false };
    const longEdge = Math.max(preview.width, preview.height);
    const accept =
      previewSource === "embedded" ||
      longEdge >= thumbMaxEdge ||
      prefersEmbeddedPreview(file);
    if (!accept) {
      preview.bitmap.close();
      return { ok: false };
    }
    // Upright from the master RAW's EXIF (the preview's own tag is unreliable,
    // often absent); the true frame size swaps with the same turn.
    const deg = previewUprightRotation(
      preview.bitmap.width,
      preview.bitmap.height,
      orientationToRotation(orientation),
      orientation,
    );
    const upright = await rotateBitmap(preview.bitmap, deg);
    if (upright !== preview.bitmap) preview.bitmap.close();
    const thumb = await createThumbnail(upright, 0, thumbMaxEdge);
    upright.close();
    const swap = deg === 90 || deg === 270;
    return {
      ok: true,
      thumb,
      width: swap ? preview.height : preview.width,
      height: swap ? preview.width : preview.height,
    };
  }

  // TIFF from a reduced-resolution copy when the file carries one big enough.
  if (isTiffName(name)) {
    const tiff = await decodeTiffBuffer(buffer, thumbMaxEdge);
    if (!tiff) return { ok: false };
    return bakedThumb(tiff.bitmap, tiff.width, tiff.height, orientation, thumbMaxEdge);
  }
  if (isNetpbmName(name)) {
    const bitmap = await decodeNetpbm(file);
    if (!bitmap) return { ok: false };
    return bakedThumb(bitmap, bitmap.width, bitmap.height, orientation, thumbMaxEdge);
  }

  // Plain browser-decodable image. JPEG bytes get the same decode-at-thumbnail-
  // scale shortcut via their SOF header, and shed their Exif segment so the
  // decode is sensor-native (see sensorNativeJpeg); other formats decode at
  // full size.
  const u8 = new Uint8Array(buffer);
  const isJpegBytes =
    u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff;
  const dims = isJpegBytes ? jpegDimensions(u8, 0) : null;
  const long = dims ? Math.max(dims.width, dims.height) : 0;
  const resize =
    dims && long > thumbMaxEdge
      ? {
          resizeWidth: Math.round((dims.width * thumbMaxEdge) / long),
          resizeHeight: Math.round((dims.height * thumbMaxEdge) / long),
          resizeQuality: "medium" as const,
        }
      : undefined;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(isJpegBytes ? sensorNativeJpeg(u8) : file, {
      imageOrientation: "none",
      ...resize,
    });
  } catch {
    return { ok: false };
  }
  return bakedThumb(
    bitmap,
    dims?.width ?? bitmap.width,
    dims?.height ?? bitmap.height,
    orientation,
    thumbMaxEdge,
  );
}
