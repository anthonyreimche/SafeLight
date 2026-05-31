import { create } from "zustand";
import type { AppModule, SortDirection, SortField, ViewMode } from "@/catalog/types";
import { NO_FILTER, type LibraryFilter } from "@/modules/library/visible-photos";

interface UIState {
  activeModule: AppModule;
  setActiveModule: (module: AppModule) => void;

  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebar: (open: boolean) => void;
  setRightSidebar: (open: boolean) => void;
  rightSidebarWidth: number;
  setRightSidebarWidth: (width: number) => void;

  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  sortField: SortField;
  sortDirection: SortDirection;
  setSort: (field: SortField, direction: SortDirection) => void;

  filter: LibraryFilter;
  setFilter: (patch: Partial<LibraryFilter>) => void;
  clearFilters: () => void;

  activeCollectionId: string | null;
  setActiveCollection: (id: string | null) => void;

  gridSize: number;
  setGridSize: (size: number) => void;

  loupeDetached: boolean;
  setLoupeDetached: (detached: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeModule: "library",
  setActiveModule: (module) => set({ activeModule: module }),

  leftSidebarOpen: true,
  rightSidebarOpen: true,
  toggleLeftSidebar: () =>
    set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  toggleRightSidebar: () =>
    set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setLeftSidebar: (open) => set({ leftSidebarOpen: open }),
  setRightSidebar: (open) => set({ rightSidebarOpen: open }),
  rightSidebarWidth: 256,
  setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),

  viewMode: "grid",
  setViewMode: (mode) => set({ viewMode: mode }),

  sortField: "dateImported",
  sortDirection: "desc",
  setSort: (field, direction) => set({ sortField: field, sortDirection: direction }),

  filter: NO_FILTER,
  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  clearFilters: () => set({ filter: NO_FILTER }),

  activeCollectionId: null,
  setActiveCollection: (id) => set({ activeCollectionId: id }),

  gridSize: 200,
  setGridSize: (size) => set({ gridSize: size }),

  loupeDetached: false,
  setLoupeDetached: (detached) => set({ loupeDetached: detached }),
}));
