// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared photo navigation used by the Library culling shortcuts (↑/↓/←/→) and
// the Develop module (←/→ for prev / next). Both walk the same filtered+sorted
// list the grid displays, so navigation never lands on a hidden photo and the
// two modules stay in sync.

import { useMemo, useSyncExternalStore } from "react";
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
import { collapseStacks, type StackView } from "@/catalog/stacks";

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
  /** The photos `filtered` holds: `order` read against them. */
  photos: CatalogPhoto[];
  /** The photos that pass the filters, every stack member among them. */
  filtered: CatalogPhoto[];
  /** What `list` and `stacks` were collapsed from. */
  collapsedFrom: { filtered: CatalogPhoto[]; expanded: ReadonlySet<string> } | null;
  /** `filtered` with each collapsed stack down to its cover: what is shown. */
  list: CatalogPhoto[];
  stacks: ReadonlyMap<string, StackView>;
  positions: Map<string, number> | null;
}

// One derive shared by the grid, the filmstrip, the counts, extensions and
// keyboard navigation, so the filter + sort runs once per change to what it
// reads, not once per surface or per key press. Entries all share one catalogue
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
  expanded: ReadonlySet<string>,
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
      filtered: order.map((i) => photos[i]),
      collapsedFrom: null,
      list: [],
      stacks: new Map(),
      positions: null,
    };
    // A handful of filter variants at most (a surface leaving out its own filter).
    derived = [entry, ...derived.slice(0, 3)];
  } else if (entry.photos !== photos) {
    entry.photos = photos;
    entry.filtered = entry.order.map((i) => photos[i]);
  }
  // Stacks collapse over the cached order, so opening one never derives it again.
  if (entry.collapsedFrom?.filtered !== entry.filtered || entry.collapsedFrom.expanded !== expanded) {
    const hadStacks = entry.stacks.size > 0;
    const collapsed = collapseStacks(entry.filtered, expanded);
    entry.list = collapsed.list;
    entry.stacks = collapsed.stacks;
    entry.collapsedFrom = { filtered: entry.filtered, expanded };
    if (hadStacks || collapsed.stacks.size > 0) entry.positions = null;
  }
  return entry;
}

function useVisible<T>(
  pick: (derived: Derived) => T,
  pickKey: string,
  options: VisiblePhotosOptions | undefined,
): T {
  const photos = useCatalogStore((s) => s.photos);
  const filter = useUIStore((s) => s.filter);
  const sortField = useUIStore((s) => s.sortField);
  const sortDirection = useUIStore((s) => s.sortDirection);
  const activeFolder = useUIStore((s) => s.activeFolder);
  const expandedStacks = useUIStore((s) => s.expandedStacks);
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
      pick(
        deriveVisible(
          photos,
          filter,
          sortField,
          sortDirection,
          activeFolder,
          gridFilters.filter((g) => !without?.includes(g.id)),
          sort,
          expandedStacks,
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [photos, filter, sortField, sortDirection, activeFolder, expandedStacks, showSubfolderPhotos, gridFilters, sort, withoutKey, pickKey],
  );
}

/** Reactive `visibleList`: the grid's display order as a hook, re-derived when
 *  the catalogue, filters, sort, folder, expanded stacks or extension grid
 *  filters/sorts change. Backs the Library grid and api.catalog.useVisiblePhotos. */
export function useVisiblePhotos(options?: VisiblePhotosOptions): CatalogPhoto[] {
  return useVisible((derived) => derived.list, "", options);
}

const stackListeners = new Set<() => void>();
let detachStackSources: (() => void) | null = null;

// One subscription to everything the derivation reads, shared by every badge.
function subscribeToStacks(listener: () => void): () => void {
  stackListeners.add(listener);
  detachStackSources ??= (() => {
    const notify = () => stackListeners.forEach((l) => l());
    const detach = [
      useCatalogStore.subscribe(notify),
      useUIStore.subscribe(notify),
      useRegistry.subscribe(notify),
      useSettings.subscribe(notify),
    ];
    return () => detach.forEach((d) => d());
  })();
  return () => {
    stackListeners.delete(listener);
    if (stackListeners.size === 0) {
      detachStackSources?.();
      detachStackSources = null;
    }
  };
}

let stableViews = new Map<string, StackView>();
let stableViewsFrom: ReadonlyMap<string, StackView> | null = null;

function sameView(a: StackView, b: StackView): boolean {
  return (
    a.stackId === b.stackId && a.size === b.size && a.coverId === b.coverId && a.expanded === b.expanded
  );
}

// Each derivation builds its views anew; a photo keeps the view object it had
// while its stack looks the same, so a badge sees no change to re-render for.
function stableStack(id: string): StackView | undefined {
  const { stacks } = currentVisible();
  if (stableViewsFrom !== stacks) {
    const next = new Map<string, StackView>();
    for (const [photoId, view] of stacks) {
      const kept = stableViews.get(photoId);
      next.set(photoId, kept && sameView(kept, view) ? kept : view);
    }
    stableViews = next;
    stableViewsFrom = stacks;
  }
  return stableViews.get(id);
}

/** Reactive `visibleStack`, for the badge on a cell. It changes only when this
 *  photo's own stack (size, cover, expanded) does, not with every catalogue
 *  update. */
export function useVisibleStack(id: string): StackView | undefined {
  return useSyncExternalStore(subscribeToStacks, () => stableStack(id));
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
    ui.expandedStacks,
  );
}

/** The photos the grid is currently showing, in display order. */
export function visibleList(): CatalogPhoto[] {
  return currentVisible().list;
}

/** The stack a shown photo is a member of, as the grid draws it, or undefined
 *  when the photo is in no stack among the photos the filters let through. */
export function visibleStack(id: string): StackView | undefined {
  return currentVisible().stacks.get(id);
}

/** The ids of every member of `id`'s stack that passes the filters, those a
 *  collapsed stack hides included; just `id` for a photo in no stack. */
export function visibleStackMembers(id: string): string[] {
  const entry = currentVisible();
  const stackId = entry.stacks.get(id)?.stackId;
  if (!stackId) return [id];
  return entry.filtered.filter((p) => p.stackId === stackId).map((p) => p.id);
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
