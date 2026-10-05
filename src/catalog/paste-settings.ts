// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Paste copied develop settings onto Library photos without opening Develop:
// merge the clipboard's partial params/bag over each photo's current look and
// append the result as one history snapshot (see stored-edit).

import { NEUTRAL_TEMPERATURE_K, normalizeParams, withoutProcessVersion } from "./types";
import { appendStoredSnapshot } from "./stored-edit";
import { normalizeParamBag } from "@/extensions/param-registry";
import { useCatalogStore } from "@/state/catalog-store";
import type { DevelopClipboard } from "@/state/develop-clipboard";

const PASTE_LABEL = "Paste Settings";

async function pasteToPhoto(
  photoId: string,
  clip: DevelopClipboard,
  asShot: number,
): Promise<void> {
  await appendStoredSnapshot(photoId, asShot, PASTE_LABEL, (base) => ({
    params: normalizeParams({ ...base.params, ...withoutProcessVersion(clip.params) }),
    paramBag: { ...base.paramBag, ...normalizeParamBag(clip.paramBag) },
  }));
}

/** Apply the clipboard's settings to every given photo. Returns how many photos
 *  were updated. */
export async function pasteSettings(
  ids: string[],
  clip: DevelopClipboard,
): Promise<number> {
  if (ids.length === 0) return 0;
  const photos = useCatalogStore.getState().photos;
  let n = 0;
  for (const id of ids) {
    const photo = photos.find((p) => p.id === id);
    if (!photo) continue;
    await pasteToPhoto(id, clip, photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K);
    n++;
  }
  return n;
}
