import { useEffect, useMemo, useRef } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { useEditedThumbUrl } from "@/state/edited-thumbnails";
import { requestThumbnail } from "@/state/thumbnail-loader";
import { Rating } from "./Rating";

interface ThumbnailProps {
  photo: CatalogPhoto;
  selected: boolean;
  active: boolean;
  size: number;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onRatingChange?: (rating: number) => void;
  onDragStart?: (e: React.DragEvent) => void;
}

export function Thumbnail({
  photo,
  selected,
  active,
  size,
  onClick,
  onDoubleClick,
  onRatingChange,
  onDragStart,
}: ThumbnailProps) {
  // Active (the photo open in Develop/Loupe) gets the brightest ring; other
  // members of a multi-selection get a clearly visible accent ring too.
  // Light-grey selection border. Uses `border` (not `ring`) so it relies on the
  // same color tokens the rest of the UI does and isn't clipped by the cell's
  // overflow-hidden. box-border keeps the cell size constant across states.
  const borderClass = active
    ? "border-2 border-text-secondary"
    : selected
      ? "border-2 border-text-secondary/60"
      : "border-2 border-transparent hover:border-surface-4";

  const labelColor = photo.colorLabel !== "none" ? colorLabelClasses[photo.colorLabel] : null;

  // Rejected photos recede: dim only the image so flag/rating badges stay crisp.
  const dimClass = photo.flag === "reject" ? "opacity-40" : "";

  const editedUrl = useEditedThumbUrl(photo.id);
  const originalUrl = useMemo(() => {
    if (photo.thumbnailUrl) return photo.thumbnailUrl;
    if (photo.thumbnailBlob) return URL.createObjectURL(photo.thumbnailBlob);
    return null;
  }, [photo.thumbnailUrl, photo.thumbnailBlob]);
  // Prefer the develop-edited render once it's ready; fall back to the original.
  const thumbUrl = editedUrl ?? originalUrl;

  // Lazily pull the cached preview when this cell nears the viewport, so a freshly
  // opened folder loads on-screen thumbnails first instead of all of them up front.
  const cellRef = useRef<HTMLDivElement>(null);
  const needsLoad = !thumbUrl;
  useEffect(() => {
    if (!needsLoad) return;
    const el = cellRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          requestThumbnail(photo.id);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [needsLoad, photo.id]);

  return (
    <div
      ref={cellRef}
      data-photo-id={photo.id}
      className={`group relative cursor-pointer overflow-hidden rounded bg-surface-1 ${borderClass}`}
      style={{ width: size, height: size }}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt={photo.filename}
          className={`h-full w-full object-contain transition group-hover:brightness-50 ${dimClass}`}
          loading="lazy"
        />
      ) : (
        // Skeleton while the cached preview is still loading.
        <div className="h-full w-full animate-pulse bg-surface-2" />
      )}

      {labelColor && (
        <div className={`absolute top-1 left-1 h-2 w-2 rounded-full ${labelColor}`} />
      )}

      {photo.flag === "pick" && (
        <div className="absolute top-1 right-1 text-[10px] text-flag-pick">{"⚑"}</div>
      )}

      {photo.flag === "reject" && (
        <div className="absolute top-1 right-1 text-[10px] text-label-red">{"⚑"}</div>
      )}

      {photo.rating > 0 && (
        <div className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[10px] leading-tight tracking-tight text-rating transition-opacity group-hover:opacity-0">
          {"★".repeat(photo.rating)}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <p className="truncate text-[10px] text-text-primary">{photo.filename}</p>
        <Rating value={photo.rating} onChange={onRatingChange} size="sm" />
      </div>
    </div>
  );
}

const colorLabelClasses: Record<string, string> = {
  red: "bg-label-red",
  yellow: "bg-label-yellow",
  green: "bg-label-green",
  blue: "bg-label-blue",
  purple: "bg-label-purple",
};
