// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useProjectStore } from "@/project/project-store";
import { exportPhotoData } from "@/project/folder-ops";
import type { SortField } from "@/catalog/types";
import { Slider } from "@/ui/components/Slider";
import { Select } from "@/ui/components/Select";
import { Slot } from "@/extensions/Slot";
import { useLibrarySorts } from "@/extensions/registry";
import { getSettings } from "@/state/settings-store";

const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: "dateImported", label: "Imported" },
  { value: "dateCreated", label: "Captured" },
  { value: "filename", label: "Name" },
  { value: "rating", label: "Rating" },
];

export function LibraryToolbar() {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const gridSize = useUIStore((s) => s.gridSize);
  const setGridSize = useUIStore((s) => s.setGridSize);
  const sortField = useUIStore((s) => s.sortField);
  const sortDirection = useUIStore((s) => s.sortDirection);
  const setSort = useUIStore((s) => s.setSort);
  const removePhotos = useCatalogStore((s) => s.removePhotos);
  const rotatePhotos = useCatalogStore((s) => s.rotatePhotos);
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const stopImport = useProjectStore((s) => s.stopImport);
  const importDone = useProjectStore((s) => s.importDone);
  const importTotal = useProjectStore((s) => s.importTotal);
  const importing = importTotal > 0 && importDone < importTotal;
  const importPct = importing ? Math.round((importDone / importTotal) * 100) : 0;
  const librarySorts = useLibrarySorts();

  const handleRemove = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (getSettings().confirmRemovePhotos) {
      const ok = window.confirm(
        `Remove ${ids.length} photo${ids.length === 1 ? "" : "s"} from the catalog? The original file${ids.length === 1 ? "" : "s"} on disk won't be deleted, and won't be re-imported on the next folder scan.`,
      );
      if (!ok) return;
    }
    removePhotos(ids);
  };

  const handleExportData = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const n = await exportPhotoData(ids);
    window.alert(
      `Wrote ${n} sidecar file${n === 1 ? "" : "s"} (“<name>.safelight.json”) next to the selected photo${ids.length === 1 ? "" : "s"}. Move the photos with their sidecars and the next project to scan them will pick up the ratings, labels and edits.`,
    );
  };

  return (
    <div className="relative flex items-center justify-between border-b border-border-subtle bg-surface-1 px-3 py-1.5">
      {importing && (
        <div
          className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-3"
          title={`Importing ${importDone} / ${importTotal}`}
        >
          <div
            className="h-full bg-accent transition-[width] duration-150 ease-out"
            style={{ width: `${importPct}%` }}
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Slot name="library-toolbar" />
        <span className="text-[10px] text-text-muted" role="status" aria-live="polite">
          {importing
            ? `Importing ${importDone}/${importTotal}…`
            : `${photos.length} photos${selectedIds.size > 0 ? ` · ${selectedIds.size} selected` : ""}`}
        </span>
        {importing && (
          <button
            onClick={stopImport}
            className="rounded bg-surface-3 px-2 py-0.5 text-[10px] text-text-secondary hover:bg-surface-4 hover:text-label-red"
            title="Stop importing new photos (already-imported photos are kept)"
          >
            Stop
          </button>
        )}
        {selectedIds.size > 0 && (
          <>
            <button
              onClick={() => rotatePhotos([...selectedIds], -90)}
              title="Rotate 90° counter-clockwise ( [ )"
              aria-label="Rotate 90° counter-clockwise"
              className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
            >
              <span aria-hidden="true">{"⟲"}</span>
            </button>
            <button
              onClick={() => rotatePhotos([...selectedIds], 90)}
              title="Rotate 90° clockwise ( ] )"
              aria-label="Rotate 90° clockwise"
              className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
            >
              <span aria-hidden="true">{"⟳"}</span>
            </button>
            <button
              onClick={() => void handleExportData()}
              title="Write .safelight.json sidecars (ratings, labels, edits) next to the selected files so the data follows them to another project"
              className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
            >
              Export Data
            </button>
            <button
              onClick={handleRemove}
              className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-label-red"
            >
              Remove
            </button>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <Select
            value={sortField}
            onChange={(v) => setSort(v, sortDirection)}
            ariaLabel="Sort photos by"
            groups={[
              { items: SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label })) },
              ...(librarySorts.length > 0
                ? [{ title: "Metadata", items: librarySorts.map((o) => ({ value: o.id, label: o.label })) }]
                : []),
            ]}
          />
          <button
            onClick={() =>
              setSort(sortField, sortDirection === "asc" ? "desc" : "asc")
            }
            className="rounded bg-surface-2 px-1.5 py-1 text-[11px] text-text-secondary hover:text-text-primary"
            title={sortDirection === "asc" ? "Ascending" : "Descending"}
            aria-label={`Sort direction: ${sortDirection === "asc" ? "ascending" : "descending"}`}
          >
            <span aria-hidden="true">{sortDirection === "asc" ? "↑" : "↓"}</span>
          </button>
        </div>

        <div className="flex rounded bg-surface-2" role="group" aria-label="View mode">
          <button
            onClick={() => setViewMode("grid")}
            aria-pressed={viewMode === "grid"}
            className={`px-2 py-1 text-[11px] ${
              viewMode === "grid" ? "bg-surface-3 text-text-primary" : "text-text-muted"
            } rounded-l`}
          >
            Grid
          </button>
          <button
            onClick={() => setViewMode("list")}
            aria-pressed={viewMode === "list"}
            className={`px-2 py-1 text-[11px] ${
              viewMode === "list" ? "bg-surface-3 text-text-primary" : "text-text-muted"
            } rounded-r`}
          >
            List
          </button>
        </div>

        <div className="w-24">
          <Slider
            label=""
            ariaLabel="Thumbnail size"
            hideValue
            value={gridSize}
            min={100}
            max={400}
            step={20}
            defaultValue={200}
            onChange={setGridSize}
          />
        </div>
      </div>
    </div>
  );
}
