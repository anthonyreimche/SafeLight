// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Render ONE arbitrary catalog photo through the full develop pipeline with
// caller-supplied params, off-screen, to an ImageBitmap — without disturbing the
// live Develop view or its bound source.
//
// `api.develop.captureFrame` renders whatever source the live Develop renderer
// currently has bound (the active photo), so it can't measure a *different*
// photo. This binds the requested photo's source into the thumb renderer (the
// same resident-source path edited-thumbnail.ts uses), applies the photo's own
// stage `paramBag`, renders small, and hands back the frame. Extensions use it to
// build a per-photo histogram for batch Auto Tone / Auto WB across a selection.

import type { DevelopParams } from "@/catalog/types";
import { getRenderBridge } from "@/rendering/render-bridge";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import { useCatalogStore } from "./catalog-store";

// Source cap mirrors edited-thumbnail.ts: small enough to stay cheap, with
// headroom above the measured frame so a tight crop still resolves.
const THUMB_SOURCE_MAX_EDGE = 1280;
// Measurement frames only feed a 256-bin histogram, so a small edge is plenty
// and keeps the per-photo convergence loop fast.
const MEASURE_MAX_EDGE = 640;

let reqSeq = 0;

/** Render `photoId` with `params` (and the photo's own extension-stage
 *  `paramBag`) to an ImageBitmap, or null if the photo can't be rendered. */
export async function renderPhotoFrame(
  photoId: string,
  params: DevelopParams,
  paramBag?: Record<string, unknown>,
): Promise<ImageBitmap | null> {
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!photo) return null;

  const bridge = getRenderBridge();
  await bridge.ready;

  const asShotTemperature = photo.exif.colorTemperature ?? 6500;
  const key = photoSourceKey(photo);
  const maxEdge = MEASURE_MAX_EDGE;

  // 1) Render from the resident source if it's already cached in the thumb
  //    renderer (e.g. a prior measure of this photo this run).
  let blob = await renderFromSource(bridge, key, params, asShotTemperature, maxEdge, paramBag);

  // 2) First touch of this photo: decode, upload a capped source once, retry.
  if (!blob) {
    const decoded = await loadPhotoImage(photo);
    if (decoded) {
      const image =
        decoded.kind === "bitmap"
          ? { kind: "bitmap" as const, bitmap: decoded.bitmap }
          : decoded;
      bridge.uploadSource(
        "thumb",
        key,
        image,
        THUMB_SOURCE_MAX_EDGE,
        decoded.kind === "float" ? decoded.isFallbackPreview : false,
        false,
      );
      blob = await renderFromSource(bridge, key, params, asShotTemperature, maxEdge, paramBag);
    }
  }

  // 3) Last resort: the in-memory camera JPEG preview (flatter, but lets Auto
  //    still measure something rather than skipping the photo).
  if (!blob && photo.thumbnailBlob) {
    try {
      const bitmap = await createImageBitmap(photo.thumbnailBlob);
      blob = await bridge.renderThumbnailAsync({
        requestId: `measure-${photoId}-${++reqSeq}`,
        image: { kind: "bitmap", bitmap },
        params,
        asShotTemperature,
        maxEdge,
        quality: 0.9,
        contributedParams: paramBag,
      });
    } catch {
      // fall through to null
    }
  }

  if (!blob) return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

function renderFromSource(
  bridge: ReturnType<typeof getRenderBridge>,
  key: string,
  params: DevelopParams,
  asShotTemperature: number,
  maxEdge: number,
  paramBag?: Record<string, unknown>,
): Promise<Blob | null> {
  return bridge.renderThumbnailFromSource({
    requestId: `measure-${key}-${++reqSeq}`,
    key,
    params,
    asShotTemperature,
    maxEdge,
    quality: 0.9,
    contributedParams: paramBag,
  });
}
