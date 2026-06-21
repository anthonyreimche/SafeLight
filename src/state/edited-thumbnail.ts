// Regenerate one photo's grid thumbnail after it's edited in Develop, so the
// Library reflects the change.
//
// Deliberately narrow in scope (see feedback-plain-grid-thumbnails): the old
// `useEditedThumbnails` pump re-rendered *every* edited photo through the GPU on
// folder open, decoding each on a cache miss. That was removed. This does the
// opposite — it touches only the single photo you actively edit, renders the
// in-memory import preview (≤thumbMaxEdge) through the worker's thumb renderer
// (no full decode, off the main thread), and persists the result. The expensive
// folder-wide pass is not reintroduced.

import type { DevelopParams } from "@/catalog/types";
import { getRenderBridge } from "@/rendering/render-bridge";
import { loadPhotoImage } from "@/catalog/load-image";
import { getSettings } from "@/state/settings-store";
import { catalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "./catalog-store";

let reqSeq = 0;
// Per-photo coalescing: while one regen is in flight, a newer commit overwrites
// the pending params and re-runs once at the end — so rapid edits collapse to a
// single trailing render that reflects the latest committed look.
const inFlight = new Set<string>();
const pending = new Map<string, { params: DevelopParams; asShotTemperature: number }>();

/** Re-render and persist the grid thumbnail for a just-committed edit. The
 *  worker's thumb renderer already carries the live stages / pipeline / param
 *  bag for the active photo; `params` is the freshly committed look. Fire and
 *  forget — never blocks the commit. */
export function regenerateEditedThumbnail(
  photoId: string,
  params: DevelopParams,
  asShotTemperature: number,
): void {
  if (inFlight.has(photoId)) {
    pending.set(photoId, { params, asShotTemperature });
    return;
  }
  inFlight.add(photoId);
  void run(photoId, params, asShotTemperature).finally(() => {
    inFlight.delete(photoId);
    const next = pending.get(photoId);
    if (next) {
      pending.delete(photoId);
      regenerateEditedThumbnail(photoId, next.params, next.asShotTemperature);
    }
  });
}

async function run(
  photoId: string,
  params: DevelopParams,
  asShotTemperature: number,
): Promise<void> {
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!photo) return;

  // Source: prefer the in-memory import preview (cheap, no decode). Fall back to
  // a full decode only when this photo has no cached preview yet — rare, and
  // bounded to the one photo being edited.
  let image:
    | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
    | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
    | { kind: "bitmap"; bitmap: ImageBitmap }
    | null = null;
  if (photo.thumbnailBlob) {
    try {
      // The import preview is baked upright, so it feeds the pipeline as-is.
      image = { kind: "bitmap", bitmap: await createImageBitmap(photo.thumbnailBlob) };
    } catch {
      image = null;
    }
  }
  if (!image) {
    const decoded = await loadPhotoImage(photo);
    if (!decoded) return;
    image =
      decoded.kind === "bitmap"
        ? { kind: "bitmap", bitmap: decoded.bitmap }
        : decoded;
  }

  const bridge = getRenderBridge();
  await bridge.ready;

  let blob: Blob;
  try {
    blob = await bridge.renderThumbnailAsync({
      requestId: `edit-thumb-${photoId}-${++reqSeq}`,
      image,
      params,
      asShotTemperature,
      maxEdge: getSettings().thumbMaxEdge,
      quality: 0.8,
    });
  } catch {
    // A render failure must not lose the existing preview.
    if (image.kind === "bitmap") image.bitmap.close();
    return;
  }

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
  // so the grid cell (this window) repaints and other windows reload from disk.
  useCatalogStore.getState().updatePhoto(updated);
}
