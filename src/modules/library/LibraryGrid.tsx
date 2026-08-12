// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useMemo, useRef } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { Thumbnail } from "@/ui/components/Thumbnail";
import { VirtualGrid } from "@/ui/components/VirtualGrid";
import { LibraryListRow } from "./LibraryListRow";
import { useVisiblePhotos } from "./photo-navigation";
import { usePhotoActions } from "./photo-actions";

export function LibraryGrid() {
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const select = useCatalogStore((s) => s.select);
  const toggleSelect = useCatalogStore((s) => s.toggleSelect);
  const selectRange = useCatalogStore((s) => s.selectRange);
  const setRating = useCatalogStore((s) => s.setRating);
  const setActivePhoto = useCatalogStore((s) => s.setActivePhoto);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const setGridColumns = useUIStore((s) => s.setGridColumns);
  const gridSize = useUIStore((s) => s.gridSize);
  const viewMode = useUIStore((s) => s.viewMode);
  const clearFilters = useUIStore((s) => s.clearFilters);

  const visible = useVisiblePhotos();

  // The right-click menu and its dialogs, shared with every other photo surface
  // (see photo-actions).
  const { onContextMenu: handleContextMenu, overlays } = usePhotoActions();

  const activeIndex = useMemo(
    () => (activePhotoId ? visible.findIndex((p) => p.id === activePhotoId) : -1),
    [activePhotoId, visible],
  );

  const getKey = useCallback((p: CatalogPhoto) => p.id, []);

  // Stable handlers (passed to every memoized cell) so a selection re-renders
  // only the cells whose selected/active flipped. The on-screen order for
  // shift-range and the live selection for drag are read through refs / the
  // store at call time, so these callbacks never need to change identity.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const handleClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        selectRange(id, visibleRef.current.map((p) => p.id));
      } else if (e.ctrlKey || e.metaKey) {
        toggleSelect(id);
      } else {
        select(id);
      }
    },
    [select, toggleSelect, selectRange],
  );

  const handleDoubleClick = useCallback(
    (id: string) => {
      setActivePhoto(id);
      setActiveModule("develop");
    },
    [setActivePhoto, setActiveModule],
  );

  // Clicking the grid's empty space (between or around the cells) — anything that
  // isn't a photo cell — clears the selection. A click that lands on a thumbnail
  // bubbles here too, but its data-photo-id ancestor exempts it.
  const deselectAll = useCatalogStore((s) => s.deselectAll);
  const handleBackgroundClick = useCallback(
    (e: React.MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-photo-id]")) deselectAll();
    },
    [deselectAll],
  );

  // Drag photos onto a Folders-panel folder to move them. Dragging a photo
  // that's part of the current selection drags the whole selection; dragging an
  // unselected one drags just it.
  const handleDragStart = useCallback((id: string, e: React.DragEvent) => {
    const sel = useCatalogStore.getState().selectedIds;
    const ids = sel.has(id) ? [...sel] : [id];
    e.dataTransfer.setData(
      "application/x-safelight-photos",
      JSON.stringify(ids),
    );
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleRate = useCallback(
    (id: string, rating: number) => setRating(id, rating),
    [setRating],
  );

  if (photos.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-muted">
        <p className="text-sm">No photos imported</p>
        <p className="text-xs">
          Click <strong>+ Files</strong> or <strong>+ Folder</strong> to get
          started
        </p>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-muted">
        <p className="text-sm">No photos match the current filter</p>
        <button
          onClick={clearFilters}
          className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
        >
          Clear filters
        </button>
      </div>
    );
  }

  if (viewMode === "list") {
    return (
      <>
        <VirtualGrid
          items={visible}
          cellHeight={53}
          columns={1}
          overscan={6}
          getKey={getKey}
          scrollToIndex={activeIndex >= 0 ? activeIndex : undefined}
          onColumnsChange={setGridColumns}
          onClick={handleBackgroundClick}
          className="flex-1"
          renderCell={(photo) => (
            <LibraryListRow
              photo={photo}
              selected={selectedIds.has(photo.id)}
              active={activePhotoId === photo.id}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onContextMenu={handleContextMenu}
              onDragStart={handleDragStart}
            />
          )}
        />
        {overlays}
      </>
    );
  }

  return (
    <>
      <VirtualGrid
        items={visible}
        cellWidth={gridSize}
        cellHeight={gridSize}
        gap={8}
        padding={12}
        overscan={3}
        getKey={getKey}
        scrollToIndex={activeIndex >= 0 ? activeIndex : undefined}
        onColumnsChange={setGridColumns}
        onClick={handleBackgroundClick}
        className="flex-1"
        renderCell={(photo) => (
          <Thumbnail
            photo={photo}
            selected={selectedIds.has(photo.id)}
            active={activePhotoId === photo.id}
            size={gridSize}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
            onRatingChange={handleRate}
            onDragStart={handleDragStart}
          />
        )}
      />
      {overlays}
    </>
  );
}
