// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What other windows write to the catalog reaches this window's ProjectStorage
// (see project-storage). The catalog store and Develop hold copies of their own
// and write them back on their next edit, so they take those records on as well.

import { catalogStorage } from "@/catalog/storage";
import { onRemoteRecords } from "@/project/project-storage";
import { useCatalogStore } from "./catalog-store";
import { useDevelopStore } from "./develop-store";

/** Keep the catalog store, and the photo open in Develop, in step with what other
 *  windows write to the catalog. Returns the unsubscribe. */
export function followCatalogRecords(): () => void {
  return onRemoteRecords((records, storage) => {
    // A storage this window doesn't show (one still opening) has no say here.
    if (storage !== catalogStorage()) return;
    useCatalogStore.getState().mergeRemoteRecords(records.photos, records.deletedIds);
    // Develop's next commit writes back its in-memory history, which would drop
    // the other window's step, so the open photo reloads from the catalog.
    const develop = useDevelopStore.getState();
    const open = develop.photoId;
    if (open && records.edits.some((editState) => editState.photoId === open))
      void develop.loadEdit(open, develop.asShotTemperature);
  });
}
