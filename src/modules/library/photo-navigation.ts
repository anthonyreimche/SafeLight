// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared photo navigation used by the Library culling shortcuts (↑/↓/←/→) and
// the Develop module (←/→ for prev / next). Both walk the same filtered+sorted
// list the grid displays, so navigation never lands on a hidden photo and the
// two modules stay in sync.

import { useMemo } from "react";
import { fieldChanges, structureVersion, useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { getSettings, useSettings } from "@/state/settings-store";
import { NO_FILTER, orderFieldsRead, visibleOrder, type LibraryFilter } from "./visible-photos";
import {
  useGridFilters,
  useLibrarySorts,
  useRegistry,
  type RegisteredGridFilter,
  type RegisteredLibrarySort,
} from "@/extensions/registry";
import { guardCallback } from "@/extensions/guard";
import type { CatalogPhoto, SortDirection } from "@/catalog/types";

export interface VisiblePhotosOptions {
  /** Grid-filter contribution ids to leave out — for a surface that registers
   *  a filter and must not narrow itself by it. */
  without?: readonly string[];
}

interface Derived {
  structure: number;
  filter: LibraryFilter;
  sortField: string;
  sortDirection: SortDirection;
  folder: string | null;
  subfolders: boolean;
  // The registry's entries, not the functions they hold: registering anew makes
  // a new entry, so an extension that re-registers the same test or compare to
  // say its outside state changed still re-derives.
  filters: readonly RegisteredGridFilter[];
  sort: RegisteredLibrarySort | undefined;
  /** The fields the order was derived from, or null when an extension filter or
   *  sort may have read any of them. */
  reads: readonly string[] | null;
  /** fieldChanges(photos, reads) when `order` was derived. */
  changes: number;
  order: number[];
  /** The photos `list` holds: `order` read against them. */
  photos: CatalogPhoto[];
  list: CatalogPhoto[];
  positions: Map<string, number> | null;
}

// One derive shared by the grid, the filmstrip, the counts, extensions and
// keyboard navigation, so the filter + sort runs once per change to what it
// reads, not once per surface or per key press. Entries all share one catalog
// structure; an update to fields the entry doesn't read (a preview, or a rating
// while sorting by name) re-reads the order against the new photos.
let derived: Derived[] = [];

function sameFilters(
  a: readonly RegisteredGridFilter[],
  b: readonly RegisteredGridFilter[],
): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

function deriveVisible(
  photos: CatalogPhoto[],
  filter: LibraryFilter,
  sortField: string,
  sortDirection: SortDirection,
  folder: string | null,
  filters: readonly RegisteredGridFilter[],
  sort: RegisteredLibrarySort | undefined,
): Derived {
  const structure = structureVersion(photos);
  const subfolders = getSettings().showSubfolderPhotos;
  if (derived[0]?.structure !== structure) derived = [];
  let entry = derived.find(
    (e) =>
      e.filter === filter &&
      e.sortField === sortField &&
      e.sortDirection === sortDirection &&
      e.folder === folder &&
      e.subfolders === subfolders &&
      e.sort === sort &&
      sameFilters(e.filters, filters),
  );
  const reads = filters.length > 0 || sort ? null : orderFieldsRead(filter, sortField, folder);
  const changes = fieldChanges(photos, reads);
  if (entry && entry.changes !== changes) {
    const stale = entry;
    derived = derived.filter((e) => e !== stale);
    entry = undefined;
  }
  if (!entry) {
    const order = visibleOrder(
      photos,
      filter,
      sortField,
      sortDirection,
      folder,
      // A filter that throws shows the photo; a sort that throws leaves the pair
      // to the date tiebreak.
      filters.map((g) => guardCallback(g.extensionId, "grid filter", g.test, true, g)),
      sort && guardCallback(sort.extensionId, "library sort", sort.compare, 0, sort),
    );
    entry = {
      structure,
      filter,
      sortField,
      sortDirection,
      folder,
      subfolders,
      filters,
      sort,
      reads,
      changes,
      order,
      photos,
      list: order.map((i) => photos[i]),
      positions: null,
    };
    // A handful of filter variants at most (a surface leaving out its own filter).
    derived = [entry, ...derived.slice(0, 3)];
  } else if (entry.photos !== photos) {
    entry.photos = photos;
    entry.list = entry.order.map((i) => photos[i]);
  }
  return entry;
}

/** Reactive `visibleList`: the grid's display order as a hook, re-derived when
 *  the catalog, filters, sort, folder or extension grid filters/sorts change.
 *  Backs the Library grid and api.catalog.useVisiblePhotos. */
export function useVisiblePhotos(options?: VisiblePhotosOptions): CatalogPhoto[] {
  const photos = useCatalogStore((s) => s.photos);
  const filter = useUIStore((s) => s.filter);
  const sortField = useUIStore((s) => s.sortField);
  const sortDirection = useUIStore((s) => s.sortDirection);
  const activeFolder = useUIStore((s) => s.activeFolder);
  // Subscribe so the list re-derives when the subfolder preference toggles;
  // the derive reads the value itself (see inFolder).
  const showSubfolderPhotos = useSettings((s) => s.showSubfolderPhotos);
  const gridFilters = useGridFilters();
  const librarySorts = useLibrarySorts();
  const sort = librarySorts.find((s) => s.id === sortField);
  // Callers pass `without` as a literal; key the memo on its contents, not its identity.
  const without = options?.without;
  const withoutKey = without?.join("\0") ?? "";
  return useMemo(
    () =>
      deriveVisible(
        photos,
        filter,
        sortField,
        sortDirection,
        activeFolder,
        gridFilters.filter((g) => !without?.includes(g.id)),
        sort,
      ).list,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [photos, filter, sortField, sortDirection, activeFolder, showSubfolderPhotos, gridFilters, sort, withoutKey],
  );
}

function currentVisible(): Derived {
  const ui = useUIStore.getState();
  const registry = useRegistry.getState();
  return deriveVisible(
    useCatalogStore.getState().photos,
    ui.filter,
    ui.sortField,
    ui.sortDirection,
    ui.activeFolder,
    Object.values(registry.gridFilters),
    registry.librarySorts[ui.sortField],
  );
}

/** The photos the grid is currently showing, in display order. */
export function visibleList(): CatalogPhoto[] {
  return currentVisible().list;
}

/** Where photo `id` sits in visibleList(), or -1 when the grid isn't showing it. */
export function visibleIndex(id: string): number {
  const entry = currentVisible();
  entry.positions ??= new Map(entry.list.map((p, i) => [p.id, i]));
  return entry.positions.get(id) ?? -1;
}

/** How many visible photos sort before `id` when the filter is ignored: where a
 *  photo the filter just dropped (rated, rejected) would sit in the visible list. */
function visibleBefore(id: string): number {
  const ui = useUIStore.getState();
  const photos = useCatalogStore.getState().photos;
  const sort = useRegistry.getState().librarySorts[ui.sortField];
  const order = visibleOrder(
    photos,
    NO_FILTER,
    ui.sortField,
    ui.sortDirection,
    ui.activeFolder,
    [],
    sort && guardCallback(sort.extensionId, "library sort", sort.compare, 0, sort),
  );
  let before = 0;
  for (const i of order) {
    if (photos[i].id === id) return before;
    if (visibleIndex(photos[i].id) !== -1) before++;
  }
  return -1;
}

/**
 * Move the active photo by `step` positions within the visible list (negative =
 * earlier, e.g. -columns to jump up a grid row). Clamps to the ends; with no
 * active photo it lands on the last (stepping back) or first (stepping forward).
 * An active photo the filter has dropped counts as sitting between its visible
 * neighbours, so stepping forward lands on the one that took its place.
 */
export function moveActivePhoto(step: number): void {
  const catalog = useCatalogStore.getState();
  const list = visibleList();
  if (list.length === 0) return;
  const id = catalog.activePhotoId;
  const curIdx = id ? visibleIndex(id) : -1;
  const hiddenAt = id && curIdx === -1 ? visibleBefore(id) : -1;
  const nextIdx =
    curIdx !== -1
      ? Math.max(0, Math.min(list.length - 1, curIdx + step))
      : hiddenAt !== -1
        ? Math.max(0, Math.min(list.length - 1, hiddenAt + (step > 0 ? step - 1 : step)))
        : step < 0
          ? list.length - 1
          : 0;
  catalog.select(list[nextIdx].id);
}
