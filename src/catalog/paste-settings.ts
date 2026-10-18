// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Copy and paste develop settings between Library photos without opening
// Develop: Copy reads one photo's saved edit; Paste merges the clipboard's partial
// params/bag over each photo's current look and appends the result as one history
// snapshot (see stored-edit). A never-edited photo's look starts from its as-shot
// white balance, which a RAW's import may have left for the background pass to
// read, so both read it first.

import { normalizeParams, withoutProcessVersion } from "./types";
import { appendStoredSnapshots, storedSnapshotTargets } from "./stored-edit";
import { loadSavedEdit, type SavedEdit } from "./edit-params";
import { settlePendingMetadata } from "@/modules/library/import-photos";
import { useCatalogStore } from "@/state/catalog-store";
import { normalizeParamBag } from "@/extensions/param-registry";
import type { DevelopClipboard } from "@/state/develop-clipboard";

const PASTE_LABEL = "Paste Settings";

/** Apply the clipboard's settings to every given photo, stored with one catalog
 *  write. Returns how many photos were updated. */
export async function pasteSettings(
  ids: string[],
  clip: DevelopClipboard,
): Promise<number> {
  await settlePendingMetadata(ids);
  return appendStoredSnapshots(storedSnapshotTargets(ids), PASTE_LABEL, (base) => ({
    params: normalizeParams({ ...base.params, ...withoutProcessVersion(clip.params) }),
    paramBag: { ...base.paramBag, ...normalizeParamBag(clip.paramBag) },
  }));
}

/** The saved edit Copy settings offers from `photoId`, as Develop would open it,
 *  or null for a photo not in the catalog. */
export async function copySettingsSource(photoId: string): Promise<SavedEdit | null> {
  await settlePendingMetadata([photoId]);
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  return photo ? loadSavedEdit(photoId, photo.exif.colorTemperature) : null;
}
