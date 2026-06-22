// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared photo navigation used by the Library culling shortcuts (↑/↓/←/→) and
// the Develop module (←/→ for prev / next). Both walk the same filtered+sorted
// list the grid displays, so navigation never lands on a hidden photo and the
// two modules stay in sync.

import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { visiblePhotos } from "./visible-photos";
import { gridFilterPredicates, librarySortCompare } from "@/extensions/registry";

/** The photos the grid is currently showing, in display order. */
export function visibleList() {
  const catalog = useCatalogStore.getState();
  const ui = useUIStore.getState();
  return visiblePhotos(
    catalog.photos,
    ui.filter,
    ui.sortField,
    ui.sortDirection,
    ui.activeFolder,
    gridFilterPredicates(),
    librarySortCompare(ui.sortField),
  );
}

/**
 * Move the active photo by `step` positions within the visible list (negative =
 * earlier, e.g. -columns to jump up a grid row). Clamps to the ends; with no
 * active photo it lands on the last (stepping back) or first (stepping forward).
 */
export function moveActivePhoto(step: number): void {
  const catalog = useCatalogStore.getState();
  const list = visibleList();
  if (list.length === 0) return;
  const curIdx = catalog.activePhotoId
    ? list.findIndex((p) => p.id === catalog.activePhotoId)
    : -1;
  const nextIdx =
    curIdx === -1
      ? step < 0
        ? list.length - 1
        : 0
      : Math.max(0, Math.min(list.length - 1, curIdx + step));
  catalog.select(list[nextIdx].id);
}
