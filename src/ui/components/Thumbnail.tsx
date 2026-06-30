// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { photoDisplayName } from "@/catalog/copy-name";
import { requestThumbnail } from "@/state/thumbnail-loader";
import { Rating } from "./Rating";

// Callbacks take the photo id so the parent can pass ONE stable function to every
// cell (instead of a fresh per-cell closure). Combined with the memo() below, a
// selection change only re-renders the two cells whose selected/active flipped —
// not all (potentially hundreds of) visible cells.
interface ThumbnailProps {
  photo: CatalogPhoto;
  selected: boolean;
  active: boolean;
  size: number;
  onClick: (id: string, e: React.MouseEvent) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
  onRatingChange?: (id: string, rating: number) => void;
  onDragStart?: (id: string, e: React.DragEvent) => void;
}

function ThumbnailImpl({
  photo,
  selected,
  active,
  size,
  onClick,
  onDoubleClick,
  onContextMenu,
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

  // Color label drives a solid bottom bar + a faint cell tint so a labelled photo
  // reads at a glance while scanning, instead of a single 2px corner dot.
  const labelBar = photo.colorLabel !== "none" ? colorLabelClasses[photo.colorLabel] : null;
  const labelTint =
    photo.colorLabel !== "none" ? colorLabelTints[photo.colorLabel] : "bg-surface-1";

  // Rejected photos recede: dim only the image so they read as rejected while
  // the flag/rating badges stay crisp. No desaturation — dimming, not B&W.
  // Folded into the inline opacity below: the load-in fade sets opacity inline,
  // and an inline opacity overrides a Tailwind opacity-* class, so a class here
  // would never take effect on the grid tile.
  const isReject = photo.flag === "reject";

  // Virtual copies show "base_<copyName>.ext" so they read distinctly from the
  // master they share a file with.
  const displayName = photoDisplayName(photo);

  // The grid shows the original compressed preview (generated at import) — no
  // per-edit re-render or decode. Cheap and space-light; quality is intentionally
  // modest. Edits are seen in Develop/Loupe, not the grid.
  const thumbUrl = useMemo(() => {
    if (photo.thumbnailUrl) return photo.thumbnailUrl;
    if (photo.thumbnailBlob) return URL.createObjectURL(photo.thumbnailBlob);
    return null;
  }, [photo.thumbnailUrl, photo.thumbnailBlob]);
  const [loaded, setLoaded] = useState(false);
  const prevUrl = useRef(thumbUrl);
  if (prevUrl.current !== thumbUrl) {
    prevUrl.current = thumbUrl;
    setLoaded(false);
  }
  const onLoad = useCallback(() => setLoaded(true), []);

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
      className={`group relative cursor-pointer overflow-hidden rounded ${labelTint} ${borderClass}`}
      style={{ width: size, height: size }}
      draggable={!!onDragStart}
      onDragStart={onDragStart ? (e) => onDragStart(photo.id, e) : undefined}
      onClick={(e) => onClick(photo.id, e)}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(photo.id) : undefined}
      onContextMenu={onContextMenu ? (e) => onContextMenu(photo.id, e) : undefined}
    >
      {thumbUrl ? (
        <img
          src={thumbUrl}
          alt={displayName}
          className="h-full w-full object-contain transition group-hover:brightness-50"
          style={{ opacity: loaded ? (isReject ? 0.4 : 1) : 0, transition: "opacity 150ms ease-in" }}
          loading="lazy"
          onLoad={onLoad}
        />
      ) : photo.decodeError ? (
        // Decode failed — show a static warning + reason on hover, not an endless
        // pulsing skeleton that reads as "still loading".
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 text-text-secondary"
          title={`Couldn't decode ${photo.filename}: ${photo.decodeError}`}
        >
          <span className="text-lg leading-none">{"⚠"}</span>
          <span className="px-1 text-center text-[9px] leading-tight">no preview</span>
        </div>
      ) : (
        // Skeleton while the cached preview is still loading.
        <div className="h-full w-full animate-pulse bg-surface-2" />
      )}

      {(photo.flag === "pick" || photo.flag === "reject") && (
        <div
          className={`absolute top-1 right-1 rounded bg-black/50 px-1 text-[10px] leading-tight ${
            photo.flag === "pick" ? "text-flag-pick" : "text-label-red"
          }`}
        >
          {"⚑"}
        </div>
      )}

      {photo.keywords.length > 0 && (
        <div
          className="absolute top-1 left-1 flex items-center gap-0.5 rounded bg-black/50 px-1 text-[10px] leading-tight text-text-secondary transition-opacity group-hover:opacity-0"
          title={photo.keywords.join(", ")}
        >
          <span>{"🏷"}</span>
          {photo.keywords.length > 1 && <span>{photo.keywords.length}</span>}
        </div>
      )}

      {photo.rating > 0 && (
        <div className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[10px] leading-tight tracking-tight text-rating transition-opacity group-hover:opacity-0">
          {"★".repeat(photo.rating)}
        </div>
      )}

      {labelBar && (
        <div className={`pointer-events-none absolute inset-x-0 bottom-0 h-[3px] ${labelBar}`} />
      )}

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <p className="truncate text-[10px] text-text-primary">{displayName}</p>
        <Rating
          value={photo.rating}
          onChange={onRatingChange ? (r) => onRatingChange(photo.id, r) : undefined}
          size="sm"
        />
      </div>
    </div>
  );
}

export const Thumbnail = memo(ThumbnailImpl);

const colorLabelClasses: Record<string, string> = {
  red: "bg-label-red",
  yellow: "bg-label-yellow",
  green: "bg-label-green",
  blue: "bg-label-blue",
  purple: "bg-label-purple",
};

// Faint wash behind the (object-contain) thumbnail so the label colour reads in
// the letterbox margins as well as on the bottom bar.
const colorLabelTints: Record<string, string> = {
  red: "bg-label-red/20",
  yellow: "bg-label-yellow/20",
  green: "bg-label-green/20",
  blue: "bg-label-blue/20",
  purple: "bg-label-purple/20",
};
