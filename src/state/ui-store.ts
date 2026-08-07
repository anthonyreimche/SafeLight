// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import type { AppModule, SortDirection, ViewMode } from "@/catalog/types";
import { NO_FILTER, type LibraryFilter } from "@/modules/library/visible-photos";
import { runGridFilterClears } from "@/extensions/registry";
import { getSettings } from "@/state/settings-store";

// Last-used library sort, restored on boot. The Preferences "Default sort"
// only seeds a profile that has never chosen a sort. The field may be an
// extension sort id, so it stays a plain string here; unknown ids fall back
// to dateImported downstream (visible-photos sortValue).
const SORT_KEY = "sl_sort_v1";

interface StoredSort {
  field: string;
  direction: SortDirection;
}

function loadStoredSort(): StoredSort | null {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredSort>;
    if (typeof v.field !== "string" || !v.field) return null;
    if (v.direction !== "asc" && v.direction !== "desc") return null;
    return { field: v.field, direction: v.direction };
  } catch {
    return null;
  }
}

function persistSort(field: string, direction: SortDirection): void {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify({ field, direction }));
  } catch {
    /* quota/private mode — the session keeps working, only persistence is lost */
  }
}

const storedSort = loadStoredSort();

// The range the toolbar thumbnail slider exposes; the keyboard stepper walks
// the same scale one slider stop per press.
export const GRID_SIZE_MIN = 100;
export const GRID_SIZE_MAX = 400;
export const GRID_SIZE_STEP = 20;

// Last-used thumbnail size, restored on boot like the sort; the Preferences
// "Default grid size" seeds a profile that has never moved the slider.
const GRID_KEY = "sl_grid_size_v1";

function loadStoredGridSize(): number | null {
  try {
    const raw = localStorage.getItem(GRID_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= GRID_SIZE_MIN && n <= GRID_SIZE_MAX ? n : null;
  } catch {
    return null;
  }
}

function persistGridSize(size: number): void {
  try {
    localStorage.setItem(GRID_KEY, String(size));
  } catch {
    /* quota/private mode — the session keeps working, only persistence is lost */
  }
}

interface UIState {
  activeModule: AppModule;
  setActiveModule: (module: AppModule) => void;

  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // A built-in SortField or an extension-contributed sort id.
  sortField: string;
  sortDirection: SortDirection;
  setSort: (field: string, direction: SortDirection) => void;

  filter: LibraryFilter;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  clearFilters: () => void;

  /** Project folder filter: relative path ("" = whole project), null = all. */
  activeFolder: string | null;
  setActiveFolder: (path: string | null) => void;

  gridSize: number;
  setGridSize: (size: number) => void;
  stepGridSize: (direction: 1 | -1) => void;

  // Live column count of the grid, published by LibraryGrid's VirtualGrid so the
  // ↑/↓ shortcuts can jump a whole row. 1 in list view (and before first layout).
  gridColumns: number;
  setGridColumns: (n: number) => void;

  // Modules currently popped out into their own windows (main-window view).
  detached: Set<AppModule>;
  markDetached: (module: AppModule) => void;
  markAttached: (module: AppModule) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeModule: "library",
  setActiveModule: (module) => set({ activeModule: module }),

  viewMode: "grid",
  setViewMode: (mode) => set({ viewMode: mode }),

  sortField: storedSort?.field ?? getSettings().defaultSortField,
  sortDirection: storedSort?.direction ?? getSettings().defaultSortDirection,
  setSort: (field, direction) => {
    persistSort(field, direction);
    set({ sortField: field, sortDirection: direction });
  },

  filter: NO_FILTER,
  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  clearFilters: () => {
    // Also clear any extension-contributed grid filters (e.g. the search bar),
    // so "Clear filters" empties both the filter panel and the search.
    runGridFilterClears();
    set({ filter: NO_FILTER });
  },

  activeFolder: null,
  setActiveFolder: (path) => set({ activeFolder: path }),

  gridSize: loadStoredGridSize() ?? getSettings().defaultGridSize,
  setGridSize: (size) => {
    persistGridSize(size);
    set({ gridSize: size });
  },
  stepGridSize: (direction) =>
    set((s) => {
      const next = Math.min(
        GRID_SIZE_MAX,
        Math.max(GRID_SIZE_MIN, s.gridSize + direction * GRID_SIZE_STEP),
      );
      persistGridSize(next);
      return { gridSize: next };
    }),

  gridColumns: 1,
  setGridColumns: (n) => set((s) => (s.gridColumns === n ? s : { gridColumns: n })),

  detached: new Set<AppModule>(),
  markDetached: (module) =>
    set((s) => ({ detached: new Set(s.detached).add(module) })),
  markAttached: (module) =>
    set((s) => {
      const next = new Set(s.detached);
      next.delete(module);
      return { detached: next };
    }),
}));
