// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The RAW cache key of a catalogue photo, from its record alone (a cached decode
// is served while the original is offline). A photo in a folder is its path,
// size and turn. A library source's photo is its source key instead of its path:
// the cache folder is its catalogue's own, one per extension, source and
// library, so that key names the photo there, and follows it through an album
// move or a rename while a photo that takes a removed one's path never takes its
// decode. A relative path never starts with "/", so the two never meet.

import type { CatalogPhoto } from "@/catalog/types";
import { rawCacheKey } from "@/raw/raw-cache";

export function photoCacheKey(
  photo: Pick<CatalogPhoto, "relPath" | "fileSize" | "rotation" | "sourceKey">,
): string {
  const name = photo.sourceKey === undefined ? photo.relPath : `/source/${photo.sourceKey}`;
  return rawCacheKey(name, photo.fileSize, photo.rotation ?? 0);
}
