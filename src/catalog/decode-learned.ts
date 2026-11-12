// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a RAW decode learns about its photo that the RAW cache doesn't keep: the
// as-shot white balance, the exposure bias a Fujifilm DR mode left in the raw,
// and the camera match. Develop's open and the cache pass both store it. Also the
// size of a library source's photo its source listed none for.

import type { CatalogPhoto, ExifData } from "./types";
import { CAMERA_MATCH_VERSION, type CameraMatch } from "@/raw/camera-match";
import { catalogStorage } from "./storage";
import { useCatalogStore } from "@/state/catalog-store";
import { sourceItemOf } from "@/project/library-sources";

export type DecodeLearned = Partial<
  Pick<
    ExifData,
    "colorTemperature" | "rawExposureBias" | "baselineExposure" | "baselineShadows" | "cameraMatchVersion"
  >
>;

/** Whether the photo has its camera match from the current version. An older
 *  one is learned again: the first held only an exposure, which left Active
 *  D-Lighting shots too bright in the highlights, and read the scene down a
 *  few columns of some frame widths. */
export function hasCameraMatch(photo: CatalogPhoto): boolean {
  return photo.exif?.cameraMatchVersion === CAMERA_MATCH_VERSION;
}

/** A camera match as the photo keeps it: null for both when the decode found
 *  no usable match, so the maker table applies and it isn't sought again. */
export function learnedMatch(match: CameraMatch | undefined): DecodeLearned {
  return {
    baselineExposure: match?.exposure ?? null,
    baselineShadows: match?.shadows ?? null,
    cameraMatchVersion: CAMERA_MATCH_VERSION,
  };
}

/** Puts what the decode learned on `photo` for the load in hand, and on the
 *  catalogue's record of it as the record is now: a decode takes seconds, and
 *  another window may have changed the photo meanwhile. A photo that left the
 *  catalogue in that time gets nothing stored. */
export function rememberLearned(photo: CatalogPhoto, learned: DecodeLearned): void {
  if (Object.keys(learned).length === 0) return;
  Object.assign(photo.exif, learned);
  const current = useCatalogStore.getState().photos.find((p) => p.id === photo.id);
  // Lazy: a decode learns it again if the save is lost.
  if (current) {
    void catalogStorage().putPhoto(
      { ...current, exif: { ...current.exif, ...learned } },
      { lazy: true },
    );
  }
}

/** A library source's photo listed without a size is catalogued at its grid
 *  preview's until its original is decoded: then the original's own size,
 *  upright as the photo is turned, takes its place in the catalogue and the
 *  grid. A size the source listed, or a photo turned or gone meanwhile, is left
 *  as it is. */
export function rememberSourceFrame(photo: CatalogPhoto, width: number, height: number): void {
  const item = sourceItemOf(photo.fileHandle);
  if (!item || (item.width && item.height) || !(width > 0 && height > 0)) return;
  const current = useCatalogStore.getState().photos.find((p) => p.id === photo.id);
  if (!current || current.rotation !== photo.rotation) return;
  if (current.width === width && current.height === height) return;
  useCatalogStore.getState().mergeRebuiltPhoto(photo.id, { width, height });
  // Lazy: the next decode learns it again if the save is lost.
  void catalogStorage()
    .putPhoto({ ...current, width, height }, { lazy: true })
    .catch((e: unknown) => console.warn(`[load] the size of ${photo.filename} wasn't stored:`, e));
}
