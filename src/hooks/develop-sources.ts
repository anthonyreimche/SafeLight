// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the develop view knows of the sources it put in the GPU source cache: which
// are only a preview of their photo, which still lack the centre sample, and the
// neighbours it decodes ahead. Kept per bridge, whose worker holds the cache.

import type { RefObject } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { onCacheEntryFilled } from "@/catalog/cache-events";
import { loadPhotoImage, photoSourceKey, refreshStaleSource } from "@/catalog/load-image";
import type { DecodedImage, Fallback } from "@/catalog/load-image";
import type { RenderBridge } from "@/rendering/render-bridge";
import type { StoredSample } from "@/rendering/source-sample";
import { standsForPhoto } from "@/state/fallback-rules";
import { getSettings } from "@/state/settings-store";
import { visibleIndex, visibleList } from "@/modules/library/photo-navigation";

/** Whether a load settled on a preview of the photo instead of its own pixels: a fallback
 *  (the camera's preview, or the stored one), or a float the decoder marked as one. */
export function isPreview(image: DecodedImage): boolean {
  if (image.kind === "float") return image.isFallbackPreview ?? false;
  return image.kind === "bitmap" && image.fallback !== undefined;
}

/** Why the canvas shows a preview of the photo for good, in the words of its corner. */
export function previewReason(fallback: Fallback | null | undefined): string | null {
  if (fallback?.unsupported) return "Safelight can't open this RAW yet";
  if (fallback?.timedOut) return "this RAW took too long to open";
  if (fallback?.offline) return "the original isn't available";
  return null;
}

/** The key a fallback the load settled on goes into the GPU source cache under. The
 *  renderer binds back the source it held after a neighbour is uploaded without binding
 *  (prefetchNeighbors) only when it held it under a key, so the open photo's source
 *  always has one; but no open binds this one, so the next open loads the photo again. */
export const fallbackKey = (key: string): string => `${key}#fallback`;

// The keys of the sources this view put in the GPU cache that are a preview (isPreview),
// with what the load fell back on, so a photo bound from there again isn't taken for its
// full decode and still says why. Kept per bridge, whose worker holds the cache.
const previewSources = new WeakMap<RenderBridge, Map<string, Fallback | null>>();

function notePreviewSource(bridge: RenderBridge, key: string, image: DecodedImage) {
  let keys = previewSources.get(bridge);
  if (!keys) {
    keys = new Map();
    previewSources.set(bridge, keys);
  }
  if (!isPreview(image)) keys.delete(key);
  else keys.set(key, image.kind === "bitmap" ? (image.fallback ?? null) : null);
}

// The keys of the sources this view put in the GPU cache as a cached preview
// without the centre sample (a RAW cache entry written before 3.1.0). Once that
// entry is rewritten, such a source takes the decoded size and sample in place
// (cache-events.ts). Kept per bridge, whose worker holds the cache.
const staleSources = new WeakMap<RenderBridge, Set<string>>();

function noteStaleSource(bridge: RenderBridge, key: string, image: DecodedImage) {
  let keys = staleSources.get(bridge);
  if (!keys) {
    keys = new Set();
    staleSources.set(bridge, keys);
  }
  if (image.kind === "float16" && !image.sample) keys.add(key);
  else keys.delete(key);
}

/** Notes what `image`, just put in the GPU cache under `key`, is: a preview, a source
 *  waiting for its sample, or neither. */
export function noteSource(bridge: RenderBridge, key: string, image: DecodedImage): void {
  notePreviewSource(bridge, key, image);
  noteStaleSource(bridge, key, image);
}

/** What the source under `key` fell back on when it was put in the GPU cache: undefined
 *  for a source that is not a preview, null for a preview with no reason to give. */
export function keptPreview(bridge: RenderBridge, key: string): Fallback | null | undefined {
  return previewSources.get(bridge)?.get(key);
}

/** Hand the worker a stale source's decoded size and sample, once per key:
 *  false when the key is not (or no longer) stale for this bridge. */
function relayStaleSource(
  bridge: RenderBridge,
  key: string,
  take: () => { fullWidth: number; fullHeight: number; sample: StoredSample },
): boolean {
  if (!staleSources.get(bridge)?.delete(key)) return false;
  bridge.setSourceSample(key, take());
  return true;
}

/** A cached preview this view holds without its centre sample takes the decoded size and
 *  sample once its RAW cache entry is rewritten, so the open photo turns native
 *  (sourceSize.native) without a reload. Cut only for such a source, and once per key.
 *  Returns the stop. */
export function watchCacheFills(
  bridge: RenderBridge,
  openPhotoIdRef: RefObject<string | undefined>,
): () => void {
  return onCacheEntryFilled((entry) => {
    const relayed = relayStaleSource(bridge, photoSourceKey(entry.photo), () => ({
      fullWidth: entry.fullWidth,
      fullHeight: entry.fullHeight,
      sample: entry.cutSample(),
    }));
    if (relayed && openPhotoIdRef.current === entry.photo.id) bridge.render(false);
  });
}

/** A photo held from an entry written before 3.1.0, shown again: its entry may have been
 *  rewritten while no view was listening, or never asked to be (a neighbour prefetch does
 *  not ask). Either way it takes the size and sample, or its rewrite is asked for and the
 *  event relays it. */
export function refreshHeldSource(
  bridge: RenderBridge,
  photo: CatalogPhoto,
  key: string,
  openPhotoIdRef: RefObject<string | undefined>,
): void {
  if (!staleSources.get(bridge)?.has(key)) return;
  void refreshStaleSource(photo).then((update) => {
    if (update && relayStaleSource(bridge, key, () => update) && openPhotoIdRef.current === photo.id) {
      bridge.render(false);
    }
  });
}

/** Background-decode the prev/next photo (in the Library's visible order) so
 *  navigating to it is an instant bindSource hit. Best-effort and cancellable;
 *  gated by a preference. Uploads with bind=false so the displayed image is
 *  untouched. Runs after a short delay so rapid navigation skips it. */
export async function prefetchNeighbors(
  bridge: RenderBridge,
  photo: CatalogPhoto,
  cancelled: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  if (!getSettings().developPrefetchNeighbors) return;
  await new Promise((r) => setTimeout(r, 250));
  if (cancelled()) return;
  const ordered = visibleList();
  const idx = visibleIndex(photo.id);
  if (idx < 0) return;
  const neighbours = [ordered[idx + 1], ordered[idx - 1]].filter(Boolean);
  const maxEdge = getSettings().developMaxEdge;
  for (const np of neighbours) {
    if (cancelled()) return;
    const nk = photoSourceKey(np);
    if (await bridge.hasSource("main", nk)) continue;
    if (cancelled()) return;
    // The develop renderer keeps the native sample (render-worker.ts), and a
    // neighbour bound later restores what was uploaded, so ask for it now.
    const image = await loadPhotoImage(np, { background: true, signal, sample: true });
    if (cancelled()) {
      if (image?.kind === "bitmap") image.bitmap.close();
      return;
    }
    // Null: the decoder passed it over for now, or nothing of it could be read.
    if (!image) continue;
    if (!standsForPhoto(image)) {
      if (image.kind === "bitmap") image.bitmap.close();
      continue;
    }
    noteSource(bridge, nk, image);
    if (image.kind === "bitmap") {
      bridge.uploadSource("main", nk, { kind: "bitmap", bitmap: image.bitmap }, maxEdge, false, false);
    } else {
      bridge.uploadSource("main", nk, image, maxEdge, image.kind === "float" ? image.isFallbackPreview : false, false);
    }
  }
}
