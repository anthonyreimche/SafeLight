import { useUIStore } from "@/state/ui-store";
import { useCatalogStore } from "@/state/catalog-store";
import type { SortField } from "@/catalog/types";
import { Slider } from "@/ui/components/Slider";
import { importFiles, importDirectory } from "./import-photos";

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
  const addPhotos = useCatalogStore((s) => s.addPhotos);
  const addCollection = useCatalogStore((s) => s.addCollection);
  const removePhotos = useCatalogStore((s) => s.removePhotos);
  const rotatePhotos = useCatalogStore((s) => s.rotatePhotos);
  const removeFromCollection = useCatalogStore((s) => s.removeFromCollection);
  const activeCollectionId = useUIStore((s) => s.activeCollectionId);
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);

  const handleImportFiles = async () => {
    const newPhotos = await importFiles();
    if (newPhotos.length > 0) {
      await addPhotos(newPhotos);
    }
  };

  const handleImportFolder = async () => {
    const { photos: newPhotos, name } = await importDirectory();
    if (newPhotos.length > 0) {
      await addPhotos(newPhotos);
      // Group a folder import into a collection named after the folder.
      if (name) {
        await addCollection(
          name,
          newPhotos.map((p) => p.id),
        );
      }
    }
  };

  const handleRemove = () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Remove ${ids.length} photo${ids.length === 1 ? "" : "s"} from the catalog? The original file${ids.length === 1 ? "" : "s"} on disk won't be deleted.`,
    );
    if (ok) removePhotos(ids);
  };

  const handleRemoveFromCollection = () => {
    if (!activeCollectionId || selectedIds.size === 0) return;
    removeFromCollection(activeCollectionId, [...selectedIds]);
  };

  return (
    <div className="flex items-center justify-between border-b border-border-subtle bg-surface-1 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <button
          onClick={handleImportFiles}
          className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
        >
          + Files
        </button>
        <button
          onClick={handleImportFolder}
          className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
        >
          + Folder
        </button>
        <span className="text-[10px] text-text-muted">
          {photos.length} photos{selectedIds.size > 0 && ` · ${selectedIds.size} selected`}
        </span>
        {selectedIds.size > 0 && (
          <>
            <button
              onClick={() => rotatePhotos([...selectedIds], -90)}
              title="Rotate 90° counter-clockwise ( [ )"
              className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
            >
              {"⟲"}
            </button>
            <button
              onClick={() => rotatePhotos([...selectedIds], 90)}
              title="Rotate 90° clockwise ( ] )"
              className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
            >
              {"⟳"}
            </button>
            {activeCollectionId && (
              <button
                onClick={handleRemoveFromCollection}
                title="Remove selected from this collection"
                className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
              >
                From collection
              </button>
            )}
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
          <select
            value={sortField}
            onChange={(e) => setSort(e.target.value as SortField, sortDirection)}
            className="rounded bg-surface-2 px-1.5 py-1 text-[11px] text-text-secondary outline-none hover:text-text-primary"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              setSort(sortField, sortDirection === "asc" ? "desc" : "asc")
            }
            className="rounded bg-surface-2 px-1.5 py-1 text-[11px] text-text-secondary hover:text-text-primary"
            title={sortDirection === "asc" ? "Ascending" : "Descending"}
          >
            {sortDirection === "asc" ? "↑" : "↓"}
          </button>
        </div>

        <div className="flex rounded bg-surface-2">
          <button
            onClick={() => setViewMode("grid")}
            className={`px-2 py-1 text-[11px] ${
              viewMode === "grid" ? "bg-surface-3 text-text-primary" : "text-text-muted"
            } rounded-l`}
          >
            Grid
          </button>
          <button
            onClick={() => setViewMode("list")}
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
