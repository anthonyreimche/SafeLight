import { useEffect, useMemo, useRef } from "react";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { Thumbnail } from "@/ui/components/Thumbnail";
import { LibraryListRow } from "./LibraryListRow";
import { visiblePhotos } from "./visible-photos";

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
  const collections = useCatalogStore((s) => s.collections);
  const activeCollectionId = useUIStore((s) => s.activeCollectionId);

  const visible = useMemo(() => {
    let scoped = photos;
    if (activeCollectionId) {
      const coll = collections.find((c) => c.id === activeCollectionId);
      if (coll) {
        const ids = new Set(coll.photoIds);
        scoped = photos.filter((p) => ids.has(p.id));
      }
    }
    return visiblePhotos(scoped, filter, sortField, sortDirection);
  }, [photos, collections, activeCollectionId, filter, sortField, sortDirection]);

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

  if (photos.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-text-muted">
        <div className="text-4xl">{"📷"}</div>
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
        />
      ))}
    </div>
  );
}
