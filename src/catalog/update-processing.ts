// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Move Library photos from the older processing to the current one without
// opening Develop. Each photo gets one appended history step that raises only the
// process version, so every other setting stays and the step can be undone. The
// open photo's own button is develop-store's updateProcessing.

import { CURRENT_PROCESS_VERSION, UPDATE_PROCESSING_LABEL, usesOlderProcessing } from "./types";
import { appendStoredSnapshots, storedSnapshotTargets } from "./stored-edit";

/** Update every given photo whose stored edit is on the older processing. A photo
 *  that is already current, or was never edited (it opens on the current
 *  processing), is skipped. The photos are stored with one catalog write. Returns
 *  how many photos changed. */
export async function updateProcessing(ids: string[]): Promise<number> {
  return appendStoredSnapshots(storedSnapshotTargets(ids), UPDATE_PROCESSING_LABEL, (base) =>
    usesOlderProcessing(base.params)
      ? {
          params: { ...base.params, processVersion: CURRENT_PROCESS_VERSION },
          paramBag: base.paramBag,
        }
      : null,
  );
}
