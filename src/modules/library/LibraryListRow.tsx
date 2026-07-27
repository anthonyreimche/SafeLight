// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { memo, useEffect, useState } from "react";
import type { CatalogPhoto } from "@/catalog/types";

const colorDot: Record<string, string> = {
  red: "bg-label-red",
  yellow: "bg-label-yellow",
  green: "bg-label-green",
  blue: "bg-label-blue",
  purple: "bg-label-purple",
};

interface LibraryListRowProps {
  photo: CatalogPhoto;
  selected: boolean;
  active: boolean;
  // Id-based callbacks so the parent passes one stable function to every row;
  // with memo() below, a selection re-renders only the rows that changed.
  onClick: (id: string, e: React.MouseEvent) => void;
  onDoubleClick: (id: string) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
  onDragStart?: (id: string, e: React.DragEvent) => void;
}

function LibraryListRowImpl({
  photo,
  selected,
  active,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
}: LibraryListRowProps) {
  // photo.thumbnailUrl is owned and revoked by the catalog store, so it is used
  // as-is. The thumbnailBlob fallback is created (and revoked) here: without the
  // effect cleanup below, every virtualized remount would leak an object URL.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (photo.thumbnailUrl || !photo.thumbnailBlob) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(photo.thumbnailBlob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo.thumbnailUrl, photo.thumbnailBlob]);
  const thumbUrl = photo.thumbnailUrl ?? blobUrl;

  const rowClass = active
    ? "bg-surface-4 text-text-primary"
    : selected
      ? "bg-surface-3 text-text-primary"
      : "text-text-secondary hover:bg-surface-2";

  return (
    <div
      data-photo-id={photo.id}
      draggable={!!onDragStart}
      onDragStart={onDragStart ? (e) => onDragStart(photo.id, e) : undefined}
      onClick={(e) => onClick(photo.id, e)}
      onDoubleClick={() => onDoubleClick(photo.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(photo.id, e) : undefined}
      className={`relative flex cursor-pointer items-center gap-3 border-b border-border-subtle px-3 py-1.5 ${rowClass} ${
        photo.flag === "reject" ? "opacity-40" : ""
      }`}
    >
      {photo.colorLabel !== "none" && (
        <span
          className={`absolute inset-y-0 left-0 w-1 ${colorDot[photo.colorLabel] ?? ""}`}
        />
      )}

      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt={photo.filename}
          className="h-10 w-14 shrink-0 rounded object-contain"
          loading="lazy"
        />
      ) : (
        <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded bg-surface-2 text-text-muted">
          {"🖼"}
        </div>
      )}

      <span className="flex-1 truncate text-xs">{photo.filename}</span>

      {photo.keywords.length > 0 && (
        <span
          className="shrink-0 text-[10px] text-text-muted"
          title={photo.keywords.join(", ")}
        >
          {"🏷"}
          {photo.keywords.length > 1 ? ` ${photo.keywords.length}` : ""}
        </span>
      )}

      {photo.flag === "pick" && (
        <span className="shrink-0 rounded bg-black/40 px-1 text-[10px] text-flag-pick">
          {"⚑"}
        </span>
      )}
      {photo.flag === "reject" && (
        <span className="shrink-0 rounded bg-black/40 px-1 text-[10px] text-label-red">
          {"⚑"}
        </span>
      )}

      <span className="w-16 shrink-0 text-right text-[10px] text-rating">
        {photo.rating > 0 ? "★".repeat(photo.rating) : ""}
      </span>

      <span className="w-24 shrink-0 text-right text-[10px] tabular-nums text-text-muted">
        {photo.width}×{photo.height}
      </span>

      <span className="hidden w-36 shrink-0 truncate text-right text-[10px] text-text-muted md:block">
        {photo.exif.cameraModel ?? ""}
      </span>
    </div>
  );
}

export const LibraryListRow = memo(LibraryListRowImpl);
