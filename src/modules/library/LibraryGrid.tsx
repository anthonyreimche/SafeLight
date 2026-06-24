// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useMemo, useRef, useState } from "react";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { Thumbnail } from "@/ui/components/Thumbnail";
import { VirtualGrid } from "@/ui/components/VirtualGrid";
import { ContextMenu, type ContextMenuEntry } from "@/ui/components/ContextMenu";
import { LibraryListRow } from "./LibraryListRow";
import { CopySettingsDialog } from "./CopySettingsDialog";
import { visiblePhotos } from "./visible-photos";
import { useGridFilters, useLibrarySorts } from "@/extensions/registry";
import { exportPhotoData } from "@/project/folder-ops";
import { getSettings, useSettings } from "@/state/settings-store";
import { loadSavedEdit } from "@/catalog/edit-params";
import { pasteSettings } from "@/catalog/paste-settings";
import { useDevelopClipboard } from "@/state/develop-clipboard";

export function LibraryGrid() {
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const select = useCatalogStore((s) => s.select);
  const toggleSelect = useCatalogStore((s) => s.toggleSelect);
  const selectRange = useCatalogStore((s) => s.selectRange);
  const setRating = useCatalogStore((s) => s.setRating);
  const rotatePhotos = useCatalogStore((s) => s.rotatePhotos);
  const removePhotos = useCatalogStore((s) => s.removePhotos);
  const setActivePhoto = useCatalogStore((s) => s.setActivePhoto);
  const setActiveModule = useUIStore((s) => s.setActiveModule);
  const setGridColumns = useUIStore((s) => s.setGridColumns);
  const gridSize = useUIStore((s) => s.gridSize);
  const viewMode = useUIStore((s) => s.viewMode);
  const filter = useUIStore((s) => s.filter);
  const sortField = useUIStore((s) => s.sortField);
  const sortDirection = useUIStore((s) => s.sortDirection);
  const clearFilters = useUIStore((s) => s.clearFilters);
  const activeFolder = useUIStore((s) => s.activeFolder);
  // Subscribe so the grid re-derives when the subfolder preference toggles;
  // visiblePhotos reads the value itself (see inFolder).
  const showSubfolderPhotos = useSettings((s) => s.showSubfolderPhotos);
  const clipboard = useDevelopClipboard((s) => s.clipboard);
  const setClipboard = useDevelopClipboard((s) => s.copy);
  const gridFilters = useGridFilters();
  const librarySorts = useLibrarySorts();
  const customCompare = librarySorts.find((s) => s.id === sortField)?.compare;

  const visible = useMemo(
    () =>
      visiblePhotos(
        photos,
        filter,
        sortField,
        sortDirection,
        activeFolder,
        gridFilters.map((g) => g.test),
        customCompare,
      ),
    [
      photos,
      activeFolder,
      showSubfolderPhotos,
      filter,
      sortField,
      sortDirection,
      gridFilters,
      customCompare,
    ],
  );

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

  // Right-clicking a photo that's part of the current selection targets the
  // whole selection; right-clicking an unselected one selects just it first
  // (mirrors the drag behavior). The targeted ids are captured when the menu
  // opens so later actions don't depend on the live selection.
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const handleContextMenu = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      const sel = useCatalogStore.getState().selectedIds;
      let ids: string[];
      if (sel.has(id)) {
        ids = [...sel];
      } else {
        select(id);
        ids = [id];
      }
      setMenu({ x: e.clientX, y: e.clientY, ids });
    },
    [select],
  );

  const handleExportData = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const n = await exportPhotoData(ids);
    window.alert(
      `Wrote ${n} sidecar file${n === 1 ? "" : "s"} (“<name>.safelight.json”) next to the selected photo${ids.length === 1 ? "" : "s"}. Move the photos with their sidecars and the next project to scan them will pick up the ratings, labels and edits.`,
    );
  }, []);

  const handleRemove = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      if (getSettings().confirmRemovePhotos) {
        const ok = window.confirm(
          `Remove ${ids.length} photo${ids.length === 1 ? "" : "s"} from the catalog? The original file${ids.length === 1 ? "" : "s"} on disk won't be deleted (they'll reappear on the next folder scan).`,
        );
        if (!ok) return;
      }
      removePhotos(ids);
    },
    [removePhotos],
  );

  // Copy/paste develop settings. Copy reads one photo's saved edit and opens the
  // checklist dialog; paste merges the clipboard's chosen adjustments onto every
  // targeted photo (see paste-settings).
  const [copyDialog, setCopyDialog] = useState<{
    params: DevelopParams;
    paramBag: Record<string, unknown>;
    sourceName: string;
  } | null>(null);

  const handleCopySettings = useCallback(async (id: string) => {
    const photo = useCatalogStore.getState().photos.find((p) => p.id === id);
    if (!photo) return;
    const { params, paramBag } = await loadSavedEdit(id, photo.exif.colorTemperature);
    setCopyDialog({ params, paramBag, sourceName: photo.filename });
  }, []);

  const handlePasteSettings = useCallback(async (ids: string[]) => {
    const clip = useDevelopClipboard.getState().clipboard;
    if (!clip) return;
    await pasteSettings(ids, clip);
  }, []);

  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    if (!menu) return [];
    const { ids } = menu;
    const n = ids.length;
    const suffix = n > 1 ? ` (${n})` : "";
    return [
      {
        label: "Open in Develop",
        disabled: n !== 1,
        onClick: () => {
          setActivePhoto(ids[0]);
          setActiveModule("develop");
        },
      },
      "separator",
      {
        label: "Copy settings…",
        disabled: n !== 1,
        onClick: () => void handleCopySettings(ids[0]),
      },
      {
        label: clipboard
          ? `Paste settings${suffix}`
          : "Paste settings (nothing copied)",
        disabled: !clipboard,
        onClick: () => void handlePasteSettings(ids),
      },
      "separator",
      { label: `Rotate clockwise${suffix}`, onClick: () => rotatePhotos(ids, 90) },
      {
        label: `Rotate counter-clockwise${suffix}`,
        onClick: () => rotatePhotos(ids, -90),
      },
      "separator",
      { label: `Export data…${suffix}`, onClick: () => void handleExportData(ids) },
      "separator",
      { label: `Remove${suffix}`, danger: true, onClick: () => handleRemove(ids) },
    ];
  }, [
    menu,
    clipboard,
    handleCopySettings,
    handlePasteSettings,
    rotatePhotos,
    handleExportData,
    handleRemove,
    setActivePhoto,
    setActiveModule,
  ]);

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

  const overlays = (
    <>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {copyDialog && (
        <CopySettingsDialog
          params={copyDialog.params}
          paramBag={copyDialog.paramBag}
          sourceName={copyDialog.sourceName}
          onCopy={(clip) => {
            setClipboard(clip);
            setCopyDialog(null);
          }}
          onCancel={() => setCopyDialog(null)}
        />
      )}
    </>
  );

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
