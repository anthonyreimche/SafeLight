// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a RAW decode learns about its photo that the RAW cache doesn't keep: the
// as-shot white balance, the exposure bias a Fujifilm DR mode left in the raw,
// and the camera match. Develop's open and the cache pass both store it.

import type { CatalogPhoto, ExifData } from "./types";
import type { CameraMatch } from "@/raw/camera-match";
import { catalogStorage } from "./storage";
import { useCatalogStore } from "@/state/catalog-store";

export type DecodeLearned = Partial<
  Pick<ExifData, "colorTemperature" | "rawExposureBias" | "baselineExposure" | "baselineShadows">
>;

/** Whether the photo has its camera match. One learned before the match had a
 *  shadows lift holds only the exposure, which leaves Active D-Lighting shots
 *  too bright in the highlights, so it is learned again. */
export function hasCameraMatch(photo: CatalogPhoto): boolean {
  return photo.exif?.baselineShadows !== undefined;
}

/** A camera match as the photo keeps it: null for both when the decode found
 *  no usable match, so the maker table applies and it isn't sought again. */
export function learnedMatch(match: CameraMatch | undefined): DecodeLearned {
  return { baselineExposure: match?.exposure ?? null, baselineShadows: match?.shadows ?? null };
}

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
