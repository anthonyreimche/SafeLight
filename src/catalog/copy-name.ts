// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Display naming for virtual copies. A copy's `filename` always mirrors its
// master's real file (so file ops + the project scan keep working), and its
// `copyName` is the user-facing distinguisher. The displayed/exported name
// folds the two together as `base_<copyName>.ext`, so a copy reads distinctly
// from its master and siblings everywhere a name is shown.

import type { CatalogPhoto } from "./types";

type Named = Pick<CatalogPhoto, "filename" | "copyName">;

/** Split a filename into [base, ext] (ext includes the dot, or ""). */
export function splitFilename(filename: string): [base: string, ext: string] {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
}

/** Human display name, e.g. "IMG_0001_copy.NEF" for a copy, or the plain
 *  filename for a master (or any record without a copy name). */
export function photoDisplayName(photo: Named): string {
  if (!photo.copyName) return photo.filename;
  const [base, ext] = splitFilename(photo.filename);
  return `${base}_${photo.copyName}${ext}`;
}

/** Base name (no extension) for output filenames — distinct per copy so copies
 *  of one frame don't collide on export. */
export function photoExportBase(photo: Named): string {
  return splitFilename(photoDisplayName(photo))[0];
}
