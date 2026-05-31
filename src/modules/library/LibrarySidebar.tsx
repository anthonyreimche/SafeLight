import { Panel } from "@/ui/components/Panel";
import { Rating } from "@/ui/components/Rating";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import type { ColorLabel } from "@/catalog/types";
import { isFilterActive, type RatingOp } from "./visible-photos";

const LABEL_SWATCHES: { value: ColorLabel; className: string }[] = [
  { value: "red", className: "bg-label-red" },
  { value: "yellow", className: "bg-label-yellow" },
  { value: "green", className: "bg-label-green" },
  { value: "blue", className: "bg-label-blue" },
  { value: "purple", className: "bg-label-purple" },
];

const RATING_OPS: RatingOp[] = ["lt", "gt", "lte", "gte", "eq", "neq"];
const RATING_OP_SYMBOL: Record<RatingOp, string> = {
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  eq: "=",
  neq: "≠",
};

export function LibrarySidebar() {
  const photos = useCatalogStore((s) => s.photos);
  const collections = useCatalogStore((s) => s.collections);
  const filter = useUIStore((s) => s.filter);
  const setFilter = useUIStore((s) => s.setFilter);
  const clearFilters = useUIStore((s) => s.clearFilters);
  const activeCollectionId = useUIStore((s) => s.activeCollectionId);
  const setActiveCollection = useUIStore((s) => s.setActiveCollection);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const addCollection = useCatalogStore((s) => s.addCollection);
  const deleteCollection = useCatalogStore((s) => s.deleteCollection);
  const addToCollection = useCatalogStore((s) => s.addToCollection);

  const picks = photos.filter((p) => p.flag === "pick").length;
  const rejects = photos.filter((p) => p.flag === "reject").length;
  const rated = photos.filter((p) => p.rating > 0).length;
  const active = isFilterActive(filter);

  const handleNewCollection = () => {
    const name = window.prompt("New collection name");
    if (name?.trim()) {
      addCollection(name.trim(), selectedIds.size > 0 ? [...selectedIds] : []);
    }
  };

  const handleDeleteCollection = (id: string, name: string) => {
    if (
      window.confirm(
        `Delete collection "${name}"? The photos stay in your catalog.`,
      )
    ) {
      deleteCollection(id);
      if (activeCollectionId === id) setActiveCollection(null);
    }
  };

  const cycleRatingOp = () => {
    const i = RATING_OPS.indexOf(filter.ratingOp);
    setFilter({ ratingOp: RATING_OPS[(i + 1) % RATING_OPS.length] });
  };

  return (
    <div className="flex flex-col">
      <Panel title="Catalog">
        <div className="space-y-1">
          <SidebarItem
            label="All Photos"
            count={photos.length}
            active={!active && !activeCollectionId}
            onClick={() => {
              clearFilters();
              setActiveCollection(null);
            }}
          />
          <SidebarItem
            label="Picks"
            count={picks}
            active={filter.flag === "pick"}
            onClick={() =>
              setFilter({ flag: filter.flag === "pick" ? "any" : "pick" })
            }
          />
          <SidebarItem
            label="Rejects"
            count={rejects}
            active={filter.flag === "reject"}
            onClick={() =>
              setFilter({ flag: filter.flag === "reject" ? "any" : "reject" })
            }
          />
          <SidebarItem
            label="Rated"
            count={rated}
            active={filter.ratingOp === "gte" && filter.rating > 0}
            onClick={() =>
              setFilter({
                rating: filter.rating > 0 ? 0 : 1,
                ratingOp: "gte",
              })
            }
          />
        </div>
      </Panel>

      <Panel title="Filters">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <span>Rating</span>
              <button
                onClick={cycleRatingOp}
                title="Change comparison (<, >, ≤, ≥, =, ≠)"
                className="w-5 rounded bg-surface-2 py-0.5 text-center text-text-primary hover:bg-surface-3"
              >
                {RATING_OP_SYMBOL[filter.ratingOp]}
              </button>
            </div>
            <Rating
              value={filter.rating}
              onChange={(rating) => setFilter({ rating })}
              size="md"
            />
          </div>

          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-secondary">Label</span>
            <div className="flex gap-1.5">
              {LABEL_SWATCHES.map((s) => (
                <button
                  key={s.value}
                  onClick={() =>
                    setFilter({ label: filter.label === s.value ? "any" : s.value })
                  }
                  className={`h-3.5 w-3.5 rounded-full ${s.className} ${
                    filter.label === s.value
                      ? "ring-2 ring-text-primary"
                      : "opacity-60 hover:opacity-100"
                  }`}
                  aria-label={s.value}
                />
              ))}
            </div>
          </div>

          <button
            onClick={clearFilters}
            disabled={!active}
            className="w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear filters
          </button>
        </div>
      </Panel>

      <Panel title="Collections">
        <div className="space-y-1">
          {collections.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-text-muted">
              No collections yet
            </p>
          )}
          {collections.map((c) => {
            const isActive = activeCollectionId === c.id;
            return (
              <div
                key={c.id}
                onClick={() => setActiveCollection(c.id)}
                className={`group flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[11px] ${
                  isActive
                    ? "bg-surface-3 text-text-primary"
                    : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                }`}
              >
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-text-muted">{c.photoIds.length}</span>
                {selectedIds.size > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      addToCollection(c.id, [...selectedIds]);
                    }}
                    title={`Add ${selectedIds.size} selected`}
                    className="opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
                  >
                    {"＋"}
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteCollection(c.id, c.name);
                  }}
                  title="Delete collection"
                  className="opacity-0 transition-opacity hover:text-label-red group-hover:opacity-100"
                >
                  {"✕"}
                </button>
              </div>
            );
          })}

          <button
            onClick={handleNewCollection}
            className="w-full rounded bg-surface-2 px-2 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          >
            {selectedIds.size > 0
              ? `＋ New from ${selectedIds.size} selected`
              : "＋ New collection"}
          </button>
        </div>
      </Panel>
    </div>
  );
}

function SidebarItem({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center justify-between rounded px-2 py-1 text-[11px] ${
        active
          ? "bg-surface-3 text-text-primary"
          : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
      } cursor-pointer`}
    >
      <span>{label}</span>
      <span className="text-text-muted">{count}</span>
    </div>
  );
}
