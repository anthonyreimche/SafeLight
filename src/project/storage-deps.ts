// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What project-store opens each ProjectStorage with. Kept out of project-storage
// so it imports neither the library's importer, the settings nor the extension
// registry.

import { buildPreviewBlob, importPhoto, isSupportedName } from "@/modules/library/import-photos";
import { getSettings } from "@/state/settings-store";
import { emitPhotoImport } from "@/extensions/registry";
import type { ProjectStorageDeps } from "./project-storage";

// Each reads its import when called, not as this module loads: the importer and
// the catalogue store import each other, so either may still be loading here.
export const storageDeps: ProjectStorageDeps = {
  isSupportedName: (name) => isSupportedName(name),
  importPhoto: (fileHandle, directoryHandle) => importPhoto(fileHandle, directoryHandle),
  buildPreviewBlob: (photo) => buildPreviewBlob(photo),
  persistPreviews: () => getSettings().persistPreviews,
  emitPhotoImport: (ctx) => emitPhotoImport(ctx),
};
