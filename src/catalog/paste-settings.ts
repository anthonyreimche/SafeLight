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

import { pasteLook } from "./paste-look";
import { appendStoredSnapshots, storedSnapshotTargets } from "./stored-edit";
import { loadSavedEdit, type SavedEdit } from "./edit-params";
import { settlePendingMetadata } from "@/modules/library/import-photos";
import { useCatalogStore } from "@/state/catalog-store";
import { withoutComputedParams } from "@/extensions/param-registry";
import type { DevelopClipboard } from "@/state/develop-clipboard";

const PASTE_LABEL = "Paste Settings";

/** Apply the clipboard's settings to every given photo, stored with one catalogue
 *  write. Returns how many photos were updated. */
export async function pasteSettings(
  ids: string[],
  clip: DevelopClipboard,
): Promise<number> {
  await settlePendingMetadata(ids);
  return appendStoredSnapshots(storedSnapshotTargets(ids), PASTE_LABEL, (base) => pasteLook(base, clip));
}

/** The saved edit Copy settings offers from `photoId`, as Develop would open it
 *  but without the values extensions compute for that photo alone, or null for
 *  a photo not in the catalogue. */
export async function copySettingsSource(photoId: string): Promise<SavedEdit | null> {
  await settlePendingMetadata([photoId]);
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!photo) return null;
  const edit = await loadSavedEdit(photoId, photo.exif.colorTemperature);
  return { ...edit, paramBag: withoutComputedParams(edit.paramBag) };
}
