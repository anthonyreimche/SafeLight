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

import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { editFingerprint } from "@/catalog/edit-fingerprint";
import { getRenderBridge } from "@/rendering/render-bridge";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import { getSettings } from "@/state/settings-store";
import { catalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "./catalog-store";
import { isStoredPreview, standsForPhoto } from "./fallback-rules";

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
  // Fire and forget means *contained*: a failed render (worker gone, disk write
  // refused) must not escape as an unhandled rejection, and must still release
  // the photo so the next commit regenerates.
  void run(photoId, params, asShotTemperature, paramBag)
    .catch(() => {})
    .finally(() => {
      inFlight.delete(photoId);
      const next = pending.get(photoId);
      if (next) {
        pending.delete(photoId);
        regenerateEditedThumbnail(
          photoId,
          next.params,
          next.asShotTemperature,
          next.paramBag,
        );
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
  // The project this render belongs to: one opened meanwhile takes none of it.
  const storage = catalogStorage();

  const bridge = getRenderBridge();
  await bridge.ready;

  const maxEdge = getSettings().thumbMaxEdge;
  const key = photoSourceKey(photo);

  // 1) Render from the viewport's scene-linear source if it's already resident in
  //    the thumb renderer (every commit after the first). Matches the viewport
  //    tone exactly (base curve applied via the cached source's render state).
  let blob = await renderFromSource(bridge, key, params, asShotTemperature, maxEdge, paramBag);

  // 2) First commit for this photo: decode (warm cache while editing, so the RAW
  //    fast path returns the float16 preview in ~50ms — no libraw), upload a capped
  //    copy into the thumb renderer once, then render from it. A preview the load
  //    fell back on is rendered from once instead (standsForPhoto), and the stored
  //    preview not at all (isStoredPreview): the grid keeps it as it is until the
  //    photo's original can be read.
  if (!blob) {
    const decoded = await loadPhotoImage(photo, { background: true });
    if (decoded?.kind === "bitmap" && isStoredPreview(decoded)) {
      decoded.bitmap.close();
      return;
    }
    if (decoded) {
      const image =
        decoded.kind === "bitmap"
          ? { kind: "bitmap" as const, bitmap: decoded.bitmap }
          : decoded;
      if (standsForPhoto(decoded)) {
        bridge.uploadSource(
          "thumb",
          key,
          image,
          THUMB_SOURCE_MAX_EDGE,
          decoded.kind === "float" ? decoded.isFallbackPreview : false,
          // float16/float carry their own base-curve handling; a JPEG-fallback bitmap
          // is camera-toned and needs none, matching what the viewport shows.
          false,
        );
        blob = await renderFromSource(bridge, key, params, asShotTemperature, maxEdge, paramBag);
      } else {
        blob = await renderOnce(bridge, image, params, asShotTemperature, maxEdge, paramBag);
      }
    }
  }

  // 3) Last resort: the in-memory camera JPEG preview. Flatter than the viewport,
  //    but better than leaving the grid stale if the source can't be obtained. One
  //    that already shows an edit would get the edit twice.
  if (!blob && photo.thumbnailBlob && photo.previewEdit === undefined) {
    try {
      const bitmap = await createImageBitmap(photo.thumbnailBlob);
      const image = { kind: "bitmap" as const, bitmap };
      blob = await renderOnce(bridge, image, params, asShotTemperature, maxEdge, paramBag);
    } catch {
      // A preview that can't be decoded must not lose the existing one.
    }
  }

  if (!blob) return;

  // The photo may have been removed (or the project closed) while rendering.
  const current = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!current || catalogStorage() !== storage) return;
  // A preview rendered before the photo was turned shows it the old way round, so it
  // is rendered again at the photo's rotation now. The same goes for a turn made
  // while it was being stored: the turn's own write lands after it. A photo saved
  // with no rotation is unturned.
  const turned = (now: CatalogPhoto | undefined) =>
    now !== undefined && (now.rotation ?? 0) !== (photo.rotation ?? 0);
  if (turned(current)) return run(photoId, params, asShotTemperature, paramBag);

  const updated = {
    ...current,
    thumbnailBlob: blob,
    thumbnailUrl: URL.createObjectURL(blob),
    previewEdit: editFingerprint(params, paramBag ?? {}),
  };
  await storage.putPhoto(updated); // persists, and writes <id>.jpg when previews are stored
  if (catalogStorage() !== storage) {
    URL.revokeObjectURL(updated.thumbnailUrl);
    return;
  }
  if (turned(useCatalogStore.getState().photos.find((p) => p.id === photoId))) {
    URL.revokeObjectURL(updated.thumbnailUrl);
    return run(photoId, params, asShotTemperature, paramBag);
  }
  // Only the preview and the edit it shows go onto the photo as the store holds it
  // after the write. mergeRebuiltPhoto revokes the superseded object URL and
  // broadcasts catalog-change: the grid cell here repaints, and every other window
  // reloads the photo's preview (use-window-sync): the new <id>.jpg, or one built
  // from the file where previews aren't stored.
  const { thumbnailBlob, thumbnailUrl, previewEdit } = updated;
  useCatalogStore
    .getState()
    .mergeRebuiltPhoto(photoId, { thumbnailBlob, thumbnailUrl, previewEdit });
}

// Render a thumbnail from `image` without keeping it in the thumb renderer's
// cache. Resolves null on a render failure, so it never throws: the existing
// preview stays.
async function renderOnce(
  bridge: ReturnType<typeof getRenderBridge>,
  image: Parameters<ReturnType<typeof getRenderBridge>["renderThumbnailAsync"]>[0]["image"],
  params: DevelopParams,
  asShotTemperature: number,
  maxEdge: number,
  paramBag?: Record<string, unknown>,
): Promise<Blob | null> {
  try {
    return await bridge.renderThumbnailAsync({
      requestId: `edit-thumb-once-${++reqSeq}`,
      image,
      params,
      asShotTemperature,
      maxEdge,
      quality: 0.8,
      contributedParams: paramBag,
    });
  } catch {
    return null;
  }
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
