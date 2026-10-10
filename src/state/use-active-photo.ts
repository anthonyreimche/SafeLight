// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "./catalog-store";

// Both select from the photo list rather than subscribing to it: a write to any
// other photo (a preview arriving, a rating) then leaves their readers alone.

export function useActivePhoto(): CatalogPhoto | undefined {
  return useCatalogStore((s) => s.photos.find((p) => p.id === s.activePhotoId));
}

/** The open photo's stored width:height, or 0 with no photo open or no stored
 *  height. */
export function useActivePhotoAspect(): number {
  return useCatalogStore((s) => {
    const p = s.photos.find((ph) => ph.id === s.activePhotoId);
    return p && p.height > 0 ? p.width / p.height : 0;
  });
}
