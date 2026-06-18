import { useCallback, useMemo, useRef } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { Thumbnail } from "@/ui/components/Thumbnail";
import { VirtualGrid } from "@/ui/components/VirtualGrid";
import { LibraryListRow } from "./LibraryListRow";
import { visiblePhotos } from "./visible-photos";
import { useEditedThumbnails } from "./use-edited-thumbnails";

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
  const gridSize = useUIStore((s) => s.gridSize);
  const viewMode = useUIStore((s) => s.viewMode);
  const filter = useUIStore((s) => s.filter);
  const sortField = useUIStore((s) => s.sortField);
  const sortDirection = useUIStore((s) => s.sortDirection);
  const clearFilters = useUIStore((s) => s.clearFilters);
  const activeFolder = useUIStore((s) => s.activeFolder);

  const visible = useMemo(
    () => visiblePhotos(photos, filter, sortField, sortDirection, activeFolder),
    [photos, activeFolder, filter, sortField, sortDirection],
  );

  useEditedThumbnails(visible);

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
      <VirtualGrid
        items={visible}
        cellHeight={53}
        columns={1}
        overscan={6}
        getKey={getKey}
        scrollToIndex={activeIndex >= 0 ? activeIndex : undefined}
        className="flex-1"
        renderCell={(photo) => (
          <LibraryListRow
            photo={photo}
            selected={selectedIds.has(photo.id)}
            active={activePhotoId === photo.id}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onDragStart={handleDragStart}
          />
        )}
      />
    );
  }

  return (
    <VirtualGrid
      items={visible}
      cellWidth={gridSize}
      cellHeight={gridSize}
      gap={8}
      padding={12}
      overscan={3}
      getKey={getKey}
      scrollToIndex={activeIndex >= 0 ? activeIndex : undefined}
      className="flex-1"
      renderCell={(photo) => (
        <Thumbnail
          photo={photo}
          selected={selectedIds.has(photo.id)}
          active={activePhotoId === photo.id}
          size={gridSize}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onRatingChange={handleRate}
          onDragStart={handleDragStart}
        />
      )}
    />
  );
}
