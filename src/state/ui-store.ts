// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import type { AppModule, SortDirection, ViewMode } from "@/catalog/types";
import { NO_FILTER, type LibraryFilter } from "@/modules/library/visible-photos";
import { runGridFilterClears } from "@/extensions/registry";
import { getSettings } from "@/state/settings-store";

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

  sortField: getSettings().defaultSortField,
  sortDirection: getSettings().defaultSortDirection,
  setSort: (field, direction) => set({ sortField: field, sortDirection: direction }),

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

  gridSize: getSettings().defaultGridSize,
  setGridSize: (size) => set({ gridSize: size }),

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
