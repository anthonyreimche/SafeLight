// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCatalogStore } from "./catalog-store";
import { useDevelopStore } from "./develop-store";
import { loadLensDb } from "@/lens-profiles/loader";
import { resolveForPhoto } from "@/lens-profiles/matcher";

/**
 * Resolve the lens profile for a photo by matching EXIF against the Lensfun
 * database. Updates the develop store's ephemeral resolvedLensProfile field.
 * Non-blocking — the database is loaded lazily on first call.
 */
export async function resolveLensForPhoto(photoId: string): Promise<void> {
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!photo?.exif) return;

  const db = await loadLensDb();
  if (db.length === 0) return;

  // Only update if the develop store is still showing the same photo
  if (useDevelopStore.getState().photoId !== photoId) return;

  const result = resolveForPhoto(photo.exif, db);
  if (result) {
    useDevelopStore.getState().setResolvedLensProfile(
      result.profile,
      `${result.lens.maker} ${result.lens.model}`,
    );
  }
}
