// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Regenerate one photo's grid thumbnail after it's edited in Develop, so the
// Library reflects the change.
//
// Deliberately narrow in scope (see feedback-plain-grid-thumbnails): the old
// `useEditedThumbnails` pump re-rendered *every* edited photo through the GPU on
// folder open, decoding each on a cache miss. That was removed. This touches only
// the single photo you actively edit.
//
// To make the thumbnail MATCH the Develop viewport (not the flatter camera JPEG),
// it renders from the same scene-linear source the viewport uses (cached RAW
// preview -> base curve applied), via the thumb renderer's resident source cache:
// the source is uploaded once per photo (capped small), then every later commit
// is a cheap render-from-source (no decode, no per-commit transfer, full frame,
// zoom-independent). Falls back to the in-memory camera JPEG only if that source
// can't be obtained. The folder-wide pass is not reintroduced.

import type { DevelopParams } from "@/catalog/types";
import { getRenderBridge } from "@/rendering/render-bridge";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import { getSettings } from "@/state/settings-store";
import { catalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "./catalog-store";

// Cap for the thumb renderer's resident source — small enough to stay cheap, with
// headroom above thumbMaxEdge (max 960) so a tight crop still resolves.
const THUMB_SOURCE_MAX_EDGE = 1280;

let reqSeq = 0;
// Per-photo coalescing: while one regen is in flight, a newer commit overwrites
// the pending params and re-runs once at the end — so rapid edits collapse to a
// single trailing render that reflects the latest committed look.
const inFlight = new Set<string>();
const pending = new Map<
  string,
  { params: DevelopParams; asShotTemperature: number; paramBag?: Record<string, unknown> }
>();

/** Re-render and persist the grid thumbnail for a just-committed edit. The
 *  worker's thumb renderer carries the live stages / pipeline / param bag for the
 *  ACTIVE photo, so a commit to a different photo (batch sync/reset/auto) must
 *  pass that photo's own `paramBag` — otherwise the active photo's extension
 *  stage params bleed into the rendered thumbnail. `params` is the freshly
 *  committed look. Fire and forget — never blocks the commit. */
export function regenerateEditedThumbnail(
  photoId: string,
  params: DevelopParams,
  asShotTemperature: number,
  paramBag?: Record<string, unknown>,
): void {
  if (inFlight.has(photoId)) {
    pending.set(photoId, { params, asShotTemperature, paramBag });
    return;
  }
  inFlight.add(photoId);
  void run(photoId, params, asShotTemperature, paramBag).finally(() => {
    inFlight.delete(photoId);
    const next = pending.get(photoId);
    if (next) {
      pending.delete(photoId);
      regenerateEditedThumbnail(photoId, next.params, next.asShotTemperature, next.paramBag);
    }
  });
}

async function run(
  photoId: string,
  params: DevelopParams,
  asShotTemperature: number,
  paramBag?: Record<string, unknown>,
): Promise<void> {
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!photo) return;

  const bridge = getRenderBridge();
  await bridge.ready;

  const maxEdge = getSettings().thumbMaxEdge;
  const key = photoSourceKey(photo);

  // 1) Render from the viewport's scene-linear source if it's already resident in
  //    the thumb renderer (every commit after the first). Matches the viewport
  //    tone exactly (base curve applied via the cached source's render state).
  let blob = await renderFromSource(bridge, key, params, asShotTemperature, maxEdge, paramBag);

  // 2) First commit for this photo: decode (warm cache while editing, so the RAW
  //    fast path returns the srgb16 preview in ~50ms — no libraw), upload a capped
  //    copy into the thumb renderer once, then render from it.
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
        // srgb16/float carry their own base-curve handling; a JPEG-fallback bitmap
        // is camera-toned and needs none, matching what the viewport shows.
        false,
      );
      blob = await renderFromSource(bridge, key, params, asShotTemperature, maxEdge, paramBag);
    }
  }

  // 3) Last resort: the in-memory camera JPEG preview. Flatter than the viewport,
  //    but better than leaving the grid stale if the source can't be obtained.
  if (!blob && photo.thumbnailBlob) {
    try {
      const bitmap = await createImageBitmap(photo.thumbnailBlob);
      blob = await bridge.renderThumbnailAsync({
        requestId: `edit-thumb-${photoId}-${++reqSeq}`,
        image: { kind: "bitmap", bitmap },
        params,
        asShotTemperature,
        maxEdge,
        quality: 0.8,
        contributedParams: paramBag,
      });
    } catch {
      // A render failure must not lose the existing preview.
    }
  }

  if (!blob) return;

  // The photo may have been removed (or the project closed) while rendering.
  const current = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!current) return;

  const updated = {
    ...current,
    thumbnailBlob: blob,
    thumbnailUrl: URL.createObjectURL(blob),
  };
  await catalogStorage().putPhoto(updated); // writes <id>.jpg + persists
  // updatePhoto revokes the superseded object URL and broadcasts catalog-change,
  // so the grid cell (this window) repaints. (Other windows don't yet reload on
  // that broadcast — single-window only for now; see feedback-plain-grid-thumbnails.)
  useCatalogStore.getState().updatePhoto(updated);
}

// Render a thumbnail from a source resident in the thumb renderer's cache.
// Resolves null on a cache miss (caller uploads the source and retries) or a
// render failure (caller falls back), so it never throws.
function renderFromSource(
  bridge: ReturnType<typeof getRenderBridge>,
  key: string,
  params: DevelopParams,
  asShotTemperature: number,
  maxEdge: number,
  paramBag?: Record<string, unknown>,
): Promise<Blob | null> {
  return bridge.renderThumbnailFromSource({
    requestId: `edit-thumb-${key}-${++reqSeq}`,
    key,
    params,
    asShotTemperature,
    maxEdge,
    quality: 0.8,
    contributedParams: paramBag,
  });
}
