import { useEffect, useMemo, useRef } from "react";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { Thumbnail } from "@/ui/components/Thumbnail";
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

  // Keep grid/list thumbnails showing the develop-edited result, rendered in the
  // background while the Library is on screen.
  useEditedThumbnails(visible);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the active photo on screen as keyboard navigation moves through it.
  useEffect(() => {
    if (!activePhotoId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(
      `[data-photo-id="${CSS.escape(activePhotoId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activePhotoId]);

  const handleClick = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey) {
      // Range over the on-screen order so it tracks the current sort/filter.
      selectRange(
        id,
        visible.map((p) => p.id),
      );
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelect(id);
    } else {
      select(id);
    }
  };

  const handleDoubleClick = (id: string) => {
    setActivePhoto(id);
    setActiveModule("develop");
  };

  // Drag photos onto a Folders-panel folder to move them. Dragging a photo
  // that's part of the current selection drags the whole selection; dragging an
  // unselected one drags just it.
  const handleDragStart = (id: string, e: React.DragEvent) => {
    const ids = selectedIds.has(id) ? [...selectedIds] : [id];
    e.dataTransfer.setData(
      "application/x-safelight-photos",
      JSON.stringify(ids),
    );
    e.dataTransfer.effectAllowed = "move";
  };

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
      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto">
        {visible.map((photo) => (
          <LibraryListRow
            key={photo.id}
            photo={photo}
            selected={selectedIds.has(photo.id)}
            active={activePhotoId === photo.id}
            onClick={(e) => handleClick(photo.id, e)}
            onDoubleClick={() => handleDoubleClick(photo.id)}
            onDragStart={(e) => handleDragStart(photo.id, e)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex flex-1 flex-wrap content-start gap-2 overflow-y-auto p-3"
    >
      {visible.map((photo) => (
        <Thumbnail
          key={photo.id}
          photo={photo}
          selected={selectedIds.has(photo.id)}
          active={activePhotoId === photo.id}
          size={gridSize}
          onClick={(e) => handleClick(photo.id, e)}
          onDoubleClick={() => handleDoubleClick(photo.id)}
          onRatingChange={(rating) => setRating(photo.id, rating)}
          onDragStart={(e) => handleDragStart(photo.id, e)}
        />
      ))}
    </div>
  );
}
