// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Move Library photos from the older processing to the current one without
// opening Develop. Each photo gets one appended history step that raises only the
// process version, so every other setting stays and the step can be undone. The
// open photo's own button is develop-store's updateProcessing.

import {
  CURRENT_PROCESS_VERSION,
  NEUTRAL_TEMPERATURE_K,
  UPDATE_PROCESSING_LABEL,
  usesOlderProcessing,
} from "./types";
import { appendStoredSnapshot } from "./stored-edit";
import { useCatalogStore } from "@/state/catalog-store";

/** Update every given photo whose stored edit is on the older processing. A photo
 *  that is already current, or was never edited (it opens on the current
 *  processing), is skipped. Returns how many photos changed. */
export async function updateProcessing(ids: string[]): Promise<number> {
  const photos = useCatalogStore.getState().photos;
  let n = 0;
  for (const id of ids) {
    const photo = photos.find((p) => p.id === id);
    if (!photo) continue;
    const changed = await appendStoredSnapshot(
      id,
      photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K,
      UPDATE_PROCESSING_LABEL,
      (base) =>
        usesOlderProcessing(base.params)
          ? {
              params: { ...base.params, processVersion: CURRENT_PROCESS_VERSION },
              paramBag: base.paramBag,
            }
          : null,
    );
    if (changed) n++;
  }
  return n;
}
