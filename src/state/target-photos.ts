// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useMemo } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "./catalog-store";

/** The photos a command acts on: the selection, else the active photo. */
export function targetPhotoIds(state: { selectedIds: ReadonlySet<string>; activePhotoId: string | null }): string[] {
  if (state.selectedIds.size > 0) return [...state.selectedIds];
  return state.activePhotoId ? [state.activePhotoId] : [];
}

/** The target photos in the catalogue's order. React hook. */
export function useTargetPhotos(): CatalogPhoto[] {
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  return useMemo(() => {
    const ids = new Set(targetPhotoIds({ selectedIds, activePhotoId }));
    return ids.size > 0 ? photos.filter((p) => ids.has(p.id)) : [];
  }, [photos, selectedIds, activePhotoId]);
}
