// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Per-photo opaque binary storage, exposed to extensions via
// api.develop.putPhotoData / getPhotoData. The renderer/edit pipeline stays
// blind to the contents: an extension (e.g. Image Warp) owns the format and
// drives load/save timing by reacting to the current photo + its own paramBag
// revision token. The bytes live as individual sidecars under the project's
// .safelight/blobs/, so a large payload never bloats the catalog.json rewrite.
//
// Both calls operate on the *currently loaded Develop photo*. getPhotoData
// captures that id at call time, so a result that arrives after a photo switch
// still refers to the photo it was requested for.

import { catalogStorage } from "@/catalog/storage";
import { useDevelopStore } from "@/state/develop-store";

/** Persist (or, with null, delete) an opaque blob for the current Develop photo
 *  under the already-namespaced `fullKey`. No-op when no photo is loaded or the
 *  active storage has no project open. */
export function putPhotoData(fullKey: string, data: Uint8Array | null): void {
  const photoId = useDevelopStore.getState().photoId;
  if (!photoId) return;
  void catalogStorage().putPhotoBlob?.(photoId, fullKey, data);
}

/** Read the opaque blob for the current Develop photo under `fullKey`, or null
 *  if none is stored (or no photo/project is open). */
export async function getPhotoData(fullKey: string): Promise<Uint8Array | null> {
  const photoId = useDevelopStore.getState().photoId;
  if (!photoId) return null;
  return (await catalogStorage().getPhotoBlob?.(photoId, fullKey)) ?? null;
}
