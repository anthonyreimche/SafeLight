// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a RAW decode learns about its photo that the RAW cache doesn't keep: the
// as-shot white balance, the exposure bias a Fujifilm DR mode left in the raw,
// and the camera match. Develop's open and the cache pass both store it.

import type { CatalogPhoto, ExifData } from "./types";
import { catalogStorage } from "./storage";
import { useCatalogStore } from "@/state/catalog-store";

export type DecodeLearned = Partial<Pick<ExifData, "colorTemperature" | "rawExposureBias" | "baselineExposure">>;

/** Puts what the decode learned on `photo` for the load in hand, and on the
 *  catalog's record of it as the record is now: a decode takes seconds, and
 *  another window may have changed the photo meanwhile. A photo that left the
 *  catalog in that time gets nothing stored. */
export function rememberLearned(photo: CatalogPhoto, learned: DecodeLearned): void {
  if (Object.keys(learned).length === 0) return;
  Object.assign(photo.exif, learned);
  const current = useCatalogStore.getState().photos.find((p) => p.id === photo.id);
  if (current) void catalogStorage().putPhoto({ ...current, exif: { ...current.exif, ...learned } });
}
