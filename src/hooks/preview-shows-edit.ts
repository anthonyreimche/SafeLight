// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { editFingerprint } from "@/catalog/edit-fingerprint";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";

/** The edit Develop opens a photo on: its params and bag, and where its history stands. */
export interface OpenEdit {
  params: DevelopParams;
  paramBag: Record<string, unknown>;
  historyIndex: number;
}

/** Whether `photo`'s stored preview shows `edit`: a preview rendered with that very edit,
 *  or one built from the file while the history sits at its Original. Paste Settings,
 *  Update processing and extensions change an edit without a new preview, and a rebuilt
 *  preview shows no edit. Develop draws the stored preview first only when it does. */
export function previewShowsEdit(photo: CatalogPhoto, edit: OpenEdit): boolean {
  if (photo.previewEdit === undefined) return edit.historyIndex === 0;
  return photo.previewEdit === editFingerprint(edit.params, edit.paramBag);
}
