// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a renderer may do with a preview loadPhotoImage fell back on (Fallback),
// by the rules Develop follows: the grid's edited previews, off-screen measuring
// and export render the same way.

import type { DecodedImage } from "@/catalog/load-image";

/** Whether `image` may stand for its photo in a renderer's source cache, which a
 *  later render binds without loading anything: the photo's own pixels, and the
 *  camera's preview of a RAW the decoder can't use, which loading again wouldn't
 *  better. Any other preview the load fell back on (a decode that timed out or
 *  failed for now, an original that couldn't be read) is rendered from once, and
 *  the next render loads the photo again. */
export function standsForPhoto(image: DecodedImage): boolean {
  if (image.kind !== "bitmap" || !image.fallback) return true;
  return image.fallback.unsupported && image.fallback.from === "embedded";
}

/** Whether `image` is the photo's stored preview rendered with its edit, the
 *  original out of reach: an edit rendered over it would apply twice, so it is
 *  never a source. */
export function showsEdit(image: DecodedImage): boolean {
  return image.kind === "bitmap" && image.fallback?.from === "stored-edited";
}

/** Whether `image` is the photo's stored preview, plain or edited, standing in for
 *  an original out of reach (or one nothing in decodes). A grid preview rendered
 *  over a plain one and stored would name its edit, and the next load would hand
 *  it over as already edited, which Develop never renders over: the stored
 *  preview stays as it is until the original can be read. */
export function isStoredPreview(image: DecodedImage): boolean {
  const from = image.kind === "bitmap" ? image.fallback?.from : undefined;
  return from === "stored" || from === "stored-edited";
}
