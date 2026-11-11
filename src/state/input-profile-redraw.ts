// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An edited thumbnail is drawn from its photo's source (edited-thumbnail.ts),
// which for a non-RAW photo is the input profile resolver's conversion when
// there is one. When the conversion changes, the thumbnail is drawn again: for
// the photos whose token changed, and for every edited non-RAW photo when the
// resolver comes, goes or says its answers changed. A RAW's source never
// depends on it, and a plain grid preview is the browser's decode either way.

import { loadSavedEdit } from "@/catalog/edit-params";
import { onInputProfilesChanged } from "@/catalog/input-profiles";
import type { CatalogPhoto } from "@/catalog/types";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { mapLimit } from "@/project/fs";
import { isRawFile } from "@/raw/raw-preview";
import { useCatalogStore } from "./catalog-store";
import { regenerateEditedThumbnail } from "./edited-thumbnail";

// Each redraw decodes its photo's original: two at a time keeps a resolver
// change from stalling Develop behind a catalogue's worth of decodes.
const REDRAW_CONCURRENCY = 2;

const converts = (photo: CatalogPhoto): boolean => !isRawFile({ name: photo.filename } as File);

/** Draw again the edited thumbnails of the non-RAW photos among `ids` (every
 *  photo when none are given), each with its saved edit. */
export async function redrawEditedThumbnails(ids?: readonly string[]): Promise<void> {
  const named = ids && new Set(ids);
  const stale = useCatalogStore
    .getState()
    .photos.filter((p) => p.previewEdit !== undefined && converts(p) && (!named || named.has(p.id)));
  await mapLimit(stale, REDRAW_CONCURRENCY, async (photo) => {
    const asShot = photo.exif.colorTemperature;
    const { params, paramBag } = await loadSavedEdit(photo.id, asShot);
    await regenerateEditedThumbnail(photo.id, params, asShot ?? 6500, paramBag);
  });
}

/** Store `token` on the photos (api.catalog.setInputProfile), then draw their
 *  edited thumbnails again from the source it gives them. */
export async function setInputProfiles(ids: string[], token: string | null): Promise<void> {
  await useCatalogStore.getState().setInputProfile(ids, token);
  await redrawEditedThumbnails(ids);
}

/** Draw every edited non-RAW thumbnail again after each change of the resolver
 *  once the extensions have started; returns the stop. Changes that come
 *  together draw once. A resolver registered as the app starts draws nothing:
 *  the thumbnails stored were drawn with it last time. */
export function watchInputProfiles(): () => void {
  let queued = false;
  return onInputProfilesChanged(() => {
    if (queued || !useExternalPluginsSettled.getState().settled) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void redrawEditedThumbnails();
    });
  });
}
