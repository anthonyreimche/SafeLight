// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The key of the colour a photo's mask components compare (maskInputKey), as
// the window reckons it for a photo and its edit: what api.develop.maskInputKey
// answers, and what a "mask" capture carries as its inputKey.

import type { DevelopParams } from "@/catalog/types";
import { photoSourceKey } from "@/catalog/load-image";
import { useRegistry } from "@/extensions/registry";
import { frameStageBag } from "@/rendering/stage-bag";
import { maskInputKey } from "@/rendering/webgl/split-signature";
import { photoById, useCatalogStore } from "./catalog-store";
import { useDevelopStore } from "./develop-store";

/** The mask input key of photo `photoId` drawn with `params` and its own
 *  `paramBag`; null for a photo the catalogue doesn't hold. */
export function photoMaskInputKey(
  photoId: string,
  params: DevelopParams,
  paramBag: Record<string, unknown> = {},
): string | null {
  const photo = photoById(useCatalogStore.getState().photos, photoId);
  if (!photo) return null;
  return maskInputKey({
    params,
    bag: frameStageBag(params, paramBag, photoId),
    stages: Object.values(useRegistry.getState().processingStages),
    asShotTemperature: photo.exif.colorTemperature ?? 6500,
    source: photoSourceKey(photo),
  });
}

/** The open photo's mask input key, with its committed edit; null with none open. */
export function liveMaskInputKey(): string | null {
  const { photoId, params, paramBag } = useDevelopStore.getState();
  return photoId ? photoMaskInputKey(photoId, params, paramBag) : null;
}
