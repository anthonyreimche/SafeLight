// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Library dock panels: "Folders" (project tree + Open Folder) and "Filters"
// (quick catalog scopes + rating/label filters). Both are registered extension
// contributions docked left of the grid by default.

import { useEffect, useMemo, useRef, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Rating } from "@/ui/components/Rating";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { useProjectStore } from "@/project/project-store";
import type { FolderNode } from "@/project/scan";
import {
  createFolder,
  deleteFolder,
  moveFolder,
  movePhotos,
  renameFolder,
  uniqueFolderName,
} from "@/project/folder-ops";
import type { ColorLabel } from "@/catalog/types";
import { isFilterActive, type RatingOp } from "./visible-photos";

// Drag payload MIME types. Photos carry a JSON id array; a folder carries its
// relative path. Custom types so folder rows only accept our own drags.
const DND_PHOTOS = "application/x-safelight-photos";
const DND_FOLDER = "application/x-safelight-folder";

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

// Shared row behaviour threaded down the folder tree.
interface FolderTreeCtx {
  activeFolder: string | null;
  onSelect: (path: string) => void;
  editing: string | null;
  setEditing: (path: string | null) => void;
  onNewFolder: (node: FolderNode) => void;
}

export function FoldersPanel() {
  const activeFolder = useUIStore((s) => s.activeFolder);
  const setActiveFolder = useUIStore((s) => s.setActiveFolder);
  const projectName = useProjectStore((s) => s.name);
  const tree = useProjectStore((s) => s.tree);
  const opening = useProjectStore((s) => s.opening);
  const openProjectPicker = useProjectStore((s) => s.openProjectPicker);

  // relPath of the folder being renamed inline (null = none).
  const [editing, setEditing] = useState<string | null>(null);

  // Create a uniquely-named subfolder, then drop straight into rename mode.
  const onNewFolder = async (node: FolderNode) => {
    const name = uniqueFolderName(node.children.map((c) => c.name));
    const created = await createFolder(node.path, name);
    if (created) setEditing(created);
  };

  const ctx: FolderTreeCtx = {
    activeFolder,
    onSelect: setActiveFolder,
    editing,
    setEditing,
    onNewFolder,
  };

  return (
    <div className="flex flex-col gap-1 p-2">
      {tree ? (
        <>
          <FolderRow node={tree} depth={0} label={projectName || tree.name} ctx={ctx} />
          {tree.children.map((c) => (
            <FolderTree key={c.path} node={c} depth={1} ctx={ctx} />
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

          <KeywordFilterField />

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

function KeywordFilterField() {
  const photos = useCatalogStore((s) => s.photos);
  const filter = useUIStore((s) => s.filter);
  const setFilter = useUIStore((s) => s.setFilter);
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const allKeywords = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of photos) {
      for (const k of p.keywords) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    return counts;
  }, [photos]);

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const active = new Set(filter.keywords.map((k) => k.toLowerCase()));
    return [...allKeywords.entries()]
      .filter(([k]) => k.toLowerCase().includes(q) && !active.has(k.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [input, allKeywords, filter.keywords]);

  useEffect(() => setSelectedIdx(0), [suggestions.length]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const addKeywordFilter = (keyword: string) => {
    const k = keyword.trim();
    if (!k || filter.keywords.includes(k)) return;
    setFilter({ keywords: [...filter.keywords, k] });
    setInput("");
    setShowSuggestions(false);
  };

  const removeKeywordFilter = (keyword: string) => {
    setFilter({ keywords: filter.keywords.filter((k) => k !== keyword) });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (showSuggestions && suggestions.length > 0) {
        addKeywordFilter(suggestions[selectedIdx][0]);
      } else {
        addKeywordFilter(input);
      }
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    } else if (e.key === "ArrowDown" && showSuggestions) {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp" && showSuggestions) {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Backspace" && input === "" && filter.keywords.length > 0) {
      removeKeywordFilter(filter.keywords[filter.keywords.length - 1]);
    }
  };

  if (allKeywords.size === 0) return null;

  return (
    <div ref={containerRef} className="space-y-1.5">
      <span className="text-[11px] text-text-secondary">Keyword</span>
      {filter.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {filter.keywords.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-0.5 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-text-primary"
            >
              {k}
              <button
                onClick={() => removeKeywordFilter(k)}
                className="ml-0.5 text-text-muted hover:text-text-primary"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder="Filter by keyword…"
          className="w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-50 mt-0.5 rounded border border-border bg-surface-1 py-0.5 shadow-lg">
            {suggestions.map(([keyword, count], i) => (
              <button
                key={keyword}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addKeywordFilter(keyword);
                }}
                onMouseEnter={() => setSelectedIdx(i)}
                className={`flex w-full items-center justify-between px-2 py-1 text-[11px] ${
                  i === selectedIdx
                    ? "bg-accent/20 text-text-primary"
                    : "text-text-secondary hover:bg-surface-2"
                }`}
              >
                <span>{keyword}</span>
                <span className="text-text-muted">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// One folder row; subtree rows collapse behind a disclosure toggle.
function FolderTree({
  node,
  depth,
  ctx,
}: {
  node: FolderNode;
  depth: number;
  ctx: FolderTreeCtx;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <FolderRow
        node={node}
        depth={depth}
        ctx={ctx}
        expanded={node.children.length > 0 ? expanded : undefined}
        onToggle={() => setExpanded((e) => !e)}
      />
      {expanded &&
        node.children.map((c) => (
          <FolderTree key={c.path} node={c} depth={depth + 1} ctx={ctx} />
        ))}
    </>
  );
}

function FolderRow({
  node,
  depth,
  label,
  ctx,
  expanded,
  onToggle,
}: {
  node: FolderNode;
  depth: number;
  label?: string;
  ctx: FolderTreeCtx;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const isActive = ctx.activeFolder === node.path;
  const isRoot = node.path === "";
  const isEditing = ctx.editing === node.path;
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  // Single commit path: Enter/Escape just blur the input, and onBlur decides
  // whether to apply (avoids renaming twice off the now-stale path).
  const commitRename = (value: string) => {
    ctx.setEditing(null);
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    void renameFolder(node.path, value);
  };

  const handleDelete = () => {
    const ok = window.confirm(
      `Delete the folder "${node.name}" and everything inside it from disk, and remove its photos from the catalog? This can't be undone.`,
    );
    if (ok) void deleteFolder(node.path);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const photos = e.dataTransfer.getData(DND_PHOTOS);
    if (photos) {
      void movePhotos(JSON.parse(photos) as string[], node.path);
      return;
    }
    const folder = e.dataTransfer.getData(DND_FOLDER);
    if (folder) void moveFolder(folder, node.path);
  };

  return (
    <div
      draggable={!isRoot && !isEditing}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_FOLDER, node.path);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => {
        const t = e.dataTransfer.types;
        if (t.includes(DND_PHOTOS) || t.includes(DND_FOLDER)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (!dragOver) setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => ctx.onSelect(node.path)}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={`group flex cursor-pointer items-center gap-1 rounded py-1 pr-1 text-[11px] ${
        dragOver
          ? "bg-accent/20 ring-1 ring-accent"
          : isActive
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

      {isEditing ? (
        <input
          ref={inputRef}
          defaultValue={node.name}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              cancelRef.current = true;
              e.currentTarget.blur();
            }
          }}
          onBlur={(e) => commitRename(e.currentTarget.value)}
          className="min-w-0 flex-1 rounded bg-surface-1 px-1 text-[11px] text-text-primary outline-none ring-1 ring-accent"
        />
      ) : (
        <span className="flex-1 truncate">{label ?? node.name}</span>
      )}

      {!isEditing && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            title="New subfolder"
            onClick={(e) => {
              e.stopPropagation();
              void ctx.onNewFolder(node);
            }}
            className="hidden w-4 text-text-muted hover:text-text-primary group-hover:block"
          >
            +
          </button>
          {!isRoot && (
            <>
              <button
                title="Rename folder"
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.setEditing(node.path);
                }}
                className="hidden w-4 text-text-muted hover:text-text-primary group-hover:block"
              >
                ✎
              </button>
              <button
                title="Delete folder"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                className="hidden w-4 text-text-muted hover:text-label-red group-hover:block"
              >
                {"🗑"}
              </button>
            </>
          )}
          {node.count > 0 && (
            <span className="ml-0.5 text-text-muted">{node.count}</span>
          )}
        </div>
      )}
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
