import { memo, useMemo } from "react";
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
  onDragStart?: (id: string, e: React.DragEvent) => void;
}

function LibraryListRowImpl({
  photo,
  selected,
  active,
  onClick,
  onDoubleClick,
  onDragStart,
}: LibraryListRowProps) {
  const thumbUrl = useMemo(() => {
    if (photo.thumbnailUrl) return photo.thumbnailUrl;
    if (photo.thumbnailBlob) return URL.createObjectURL(photo.thumbnailBlob);
    return null;
  }, [photo.thumbnailUrl, photo.thumbnailBlob]);

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
      className={`flex cursor-pointer items-center gap-3 border-b border-border-subtle px-3 py-1.5 ${rowClass} ${
        photo.flag === "reject" ? "opacity-50" : ""
      }`}
    >
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

      {photo.colorLabel !== "none" && (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${colorDot[photo.colorLabel] ?? ""}`}
        />
      )}

      {photo.flag === "pick" && (
        <span className="shrink-0 text-[10px] text-flag-pick">{"⚑"}</span>
      )}
      {photo.flag === "reject" && (
        <span className="shrink-0 text-[10px] text-label-red">{"⚑"}</span>
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
