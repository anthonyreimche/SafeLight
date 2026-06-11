// Library dock panels: "Folders" (project tree + Open Folder) and "Filters"
// (quick catalog scopes + rating/label filters). Both are registered extension
// contributions docked left of the grid by default.

import { useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Rating } from "@/ui/components/Rating";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { useProjectStore } from "@/project/project-store";
import type { FolderNode } from "@/project/scan";
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

export function FoldersPanel() {
  const activeFolder = useUIStore((s) => s.activeFolder);
  const setActiveFolder = useUIStore((s) => s.setActiveFolder);
  const projectName = useProjectStore((s) => s.name);
  const tree = useProjectStore((s) => s.tree);
  const opening = useProjectStore((s) => s.opening);
  const openProjectPicker = useProjectStore((s) => s.openProjectPicker);

  return (
    <div className="flex flex-col gap-1 p-2">
      {tree ? (
        <>
          <FolderRow
            node={tree}
            depth={0}
            label={projectName || tree.name}
            activeFolder={activeFolder}
            onSelect={setActiveFolder}
          />
          {tree.children.map((c) => (
            <FolderTree
              key={c.path}
              node={c}
              depth={1}
              activeFolder={activeFolder}
              onSelect={setActiveFolder}
            />
          ))}
        </>
      ) : (
        <p className="px-2 py-1 text-[11px] text-text-muted">
          Open a folder to start — its images are decoded and cached in a
          .safelight working directory inside it.
        </p>
      )}
      <button
        onClick={() => void openProjectPicker()}
        disabled={opening}
        className="w-full rounded bg-surface-2 px-2 py-1 text-left text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
      >
        {opening ? "Opening…" : "Open Folder…"}
      </button>
    </div>
  );
}

export function LibraryFiltersPanel() {
  const photos = useCatalogStore((s) => s.photos);
  const filter = useUIStore((s) => s.filter);
  const setFilter = useUIStore((s) => s.setFilter);
  const clearFilters = useUIStore((s) => s.clearFilters);
  const activeFolder = useUIStore((s) => s.activeFolder);
  const setActiveFolder = useUIStore((s) => s.setActiveFolder);

  const picks = photos.filter((p) => p.flag === "pick").length;
  const rejects = photos.filter((p) => p.flag === "reject").length;
  const rated = photos.filter((p) => p.rating > 0).length;
  const active = isFilterActive(filter);

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
            active={!active && activeFolder === null}
            onClick={() => {
              clearFilters();
              setActiveFolder(null);
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
    </div>
  );
}

// One folder row; subtree rows collapse behind a disclosure toggle.
function FolderTree({
  node,
  depth,
  activeFolder,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  activeFolder: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <FolderRow
        node={node}
        depth={depth}
        activeFolder={activeFolder}
        onSelect={onSelect}
        expanded={node.children.length > 0 ? expanded : undefined}
        onToggle={() => setExpanded((e) => !e)}
      />
      {expanded &&
        node.children.map((c) => (
          <FolderTree
            key={c.path}
            node={c}
            depth={depth + 1}
            activeFolder={activeFolder}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

function FolderRow({
  node,
  depth,
  label,
  activeFolder,
  onSelect,
  expanded,
  onToggle,
}: {
  node: FolderNode;
  depth: number;
  label?: string;
  activeFolder: string | null;
  onSelect: (path: string) => void;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const isActive = activeFolder === node.path;
  return (
    <div
      onClick={() => onSelect(node.path)}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={`flex cursor-pointer items-center gap-1 rounded py-1 pr-2 text-[11px] ${
        isActive
          ? "bg-surface-3 text-text-primary"
          : "text-text-secondary hover:bg-surface-2 hover:text-text-primary"
      }`}
    >
      {expanded !== undefined ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          className="w-3 shrink-0 text-text-muted hover:text-text-primary"
        >
          {expanded ? "▾" : "▸"}
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span className="flex-1 truncate">{label ?? node.name}</span>
      {node.count > 0 && <span className="text-text-muted">{node.count}</span>}
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
