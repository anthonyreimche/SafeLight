// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The import pixel stage — decode → orient → thumbnail encode — as a pure task
// that runs identically inside the import worker pool or inline on the main
// thread. It must stay DOM-free and must not import anything with module-level
// side effects (settings, stores): everything it needs arrives in the input.
//
// The task covers the fast path only: RAW embedded previews and plain
// browser-decodable images. Anything else — TIFF, NetPBM, rendered-mode RAW,
// libraw fallbacks — answers { ok: false } and the caller runs the full inline
// decode chain (import-photos.ts).

import {
  distrustsEmbeddedPreview,
  extractRawPreviewDecoded,
  isRawFile,
  jpegDimensions,
  prefersEmbeddedPreview,
} from "./raw-preview";
import {
  orientationToRotation,
  previewUprightRotation,
  rotateBitmap,
} from "@/catalog/orient";
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

  // Plain browser-decodable image. JPEG bytes get the same decode-at-thumbnail-
  // scale shortcut via their SOF header; other formats decode at full size.
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
    bitmap = await createImageBitmap(file, { imageOrientation: "none", ...resize });
  } catch {
    return { ok: false };
  }
  const bake = orientationToRotation(orientation);
  const thumb = await createThumbnail(bitmap, bake, thumbMaxEdge);
  const srcW = dims?.width ?? bitmap.width;
  const srcH = dims?.height ?? bitmap.height;
  bitmap.close();
  const swap = bake === 90 || bake === 270;
  return {
    ok: true,
    thumb,
    width: swap ? srcH : srcW,
    height: swap ? srcW : srcH,
  };
}
