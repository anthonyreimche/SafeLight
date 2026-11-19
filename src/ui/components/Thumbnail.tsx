// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { photoDisplayName } from "@/catalog/copy-name";
import { useEditedAt } from "@/catalog/edit-times";
import { boundaryKey } from "@/extensions/guard";
import { useThumbnailBadges } from "@/extensions/registry";
import { useCatalogStore } from "@/state/catalog-store";
import { revokePreviewUrl } from "@/state/preview-urls";
import { useSettings } from "@/state/settings-store";
import { ErrorBoundary } from "./ErrorBoundary";
import { Rating } from "./Rating";
import { StackBadge } from "./StackBadge";
import { ThumbnailBadge } from "./ThumbnailBadge";
import { usePhotoOption } from "./use-photo-option";
import { usePreviewFade } from "./use-preview-fade";
import { usePreviewRequest } from "./use-preview-request";

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

// Cells on the thumbnailBlob fallback mint a new URL per mount and still fade in
// (see state/preview-urls for the previews that do not).

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
  // Active (the photo open in Develop) gets the brightest ring; other
  // members of a multi-selection get a clearly visible accent ring too.
  // Light-grey selection border. Uses `border` (not `ring`) so it relies on the
  // same colour tokens the rest of the UI does and isn't clipped by the cell's
  // overflow-hidden. box-border keeps the cell size constant across states.
  const borderClass = active
    ? "border-2 border-text-secondary"
    : selected
      ? "border-2 border-text-secondary/60"
      : "border-2 border-transparent hover:border-surface-4";

  // Colour label drives a solid bottom bar + a faint cell tint so a labelled photo
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
  // modest. Edits are seen in Develop, not the grid.
  // photo.thumbnailUrl is owned and revoked by the catalogue store, so it is used
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
    return () => revokePreviewUrl(url);
  }, [photo.thumbnailUrl, photo.thumbnailBlob]);
  const thumbUrl = photo.thumbnailUrl ?? blobUrl;
  const { src, loaded, onLoad } = usePreviewFade(thumbUrl, photo.id);
  // A turn is shown, eased, the moment it is asked for. The turned preview lands later
  // and is decoded before it is shown; until then the picture on screen keeps the turn
  // it had, and the swap takes the new picture and its turn in one frame without
  // easing, so the picture neither unturns nor spins back on the way.
  const turning = useCatalogStore((s) => s.pendingRotation[photo.id]);
  const swapping = src !== thumbUrl;
  const [heldTurn, setHeldTurn] = useState(turning);
  if (!swapping && heldTurn !== turning) setHeldTurn(turning);
  const shownTurn = swapping ? heldTurn : turning;
  const paintedSrc = useRef(src);
  useLayoutEffect(() => {
    paintedSrc.current = src;
  });
  const easeTurn = shownTurn !== undefined && paintedSrc.current === src;

  // Lazily pull the cached preview when this cell nears the viewport, so a freshly
  // opened folder loads on-screen thumbnails first instead of all of them up front.
  const cellRef = usePreviewRequest<HTMLDivElement>(photo.id, !thumbUrl);
  const optionProps = usePhotoOption(cellRef, photo.id, selected, active, onDoubleClick);
  const fileType = useSettings((s) => s.thumbnailFileType) ? fileTypeOf(photo.filename) : null;
  const showEdited = useSettings((s) => s.thumbnailEdited);
  const isEdited = useEditedAt(photo.id) !== undefined;
  const badges = useThumbnailBadges();

  return (
    <div
      ref={cellRef}
      {...optionProps}
      data-photo-id={photo.id}
      className={`group relative cursor-pointer overflow-hidden rounded ${labelTint} ${borderClass}`}
      style={{ width: size, height: size }}
      draggable={!!onDragStart}
      onDragStart={onDragStart ? (e) => onDragStart(photo.id, e) : undefined}
      onClick={(e) => onClick(photo.id, e)}
      onDoubleClick={onDoubleClick ? () => onDoubleClick(photo.id) : undefined}
      onContextMenu={onContextMenu ? (e) => onContextMenu(photo.id, e) : undefined}
    >
      {src ? (
        <img
          src={src}
          alt={displayName}
          className="h-full w-full object-contain group-hover:brightness-50"
          style={{
            opacity: loaded ? (isReject ? 0.4 : 1) : 0,
            rotate: shownTurn === undefined ? undefined : `${shownTurn}deg`,
            transition: easeTurn
              ? "opacity 150ms ease-out, filter 150ms ease-out, rotate 150ms ease-out"
              : "opacity 150ms ease-out, filter 150ms ease-out",
          }}
          loading="lazy"
          onLoad={onLoad}
        />
      ) : photo.decodeError ? (
        // Decode failed — show a static warning + reason on hover, not an endless
        // pulsing skeleton that reads as "still loading".
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-2 text-text-secondary"
          title={`${photo.filename}: ${photo.decodeError}`}
        >
          <span aria-hidden="true" className="text-lg leading-none">{"⚠"}</span>
          <span className="line-clamp-3 px-1 text-center text-[10px] leading-tight">{photo.decodeError}</span>
        </div>
      ) : (
        // Skeleton while the cached preview is still loading.
        <div className="sl-breathe h-full w-full bg-surface-2" />
      )}

      {/* Extension badges by order, then edited, the file type and the flag in the corner. */}
      <div data-thumbnail-badges="" className="absolute top-1 right-1 flex items-start gap-0.5">
        {badges.map(({ id, component: Badge }) => (
          <ErrorBoundary
            key={boundaryKey(id, Badge)}
            what={`Thumbnail badge "${id}"`}
            compact
            className="rounded bg-black/50 px-1 text-[10px] leading-tight text-danger"
          >
            <Badge photo={photo} />
          </ErrorBoundary>
        ))}
        {showEdited && isEdited && (
          <ThumbnailBadge title="Edited">
            <span aria-hidden="true">✎</span>
          </ThumbnailBadge>
        )}
        {fileType && <ThumbnailBadge title={`${fileType} file`}>{fileType}</ThumbnailBadge>}
        {(photo.flag === "pick" || photo.flag === "reject") && (
          <div
            role="img"
            aria-label={isReject ? "Rejected" : "Pick"}
            className={`rounded bg-black/50 px-1 text-[10px] leading-tight ${
              isReject ? "text-label-red" : "text-flag-pick"
            }`}
          >
            {isReject ? "✕" : "⚑"}
          </div>
        )}
      </div>

      {photo.keywords.length > 0 && (
        <div
          className="absolute top-1 left-1 flex items-center gap-0.5 rounded bg-black/50 px-1 text-[10px] leading-tight text-on-media-muted transition-opacity group-hover:opacity-0"
          title={photo.keywords.join(", ")}
        >
          <span aria-hidden="true">{"🏷"}</span>
          {photo.keywords.length > 1 && <span>{photo.keywords.length}</span>}
        </div>
      )}

      {photo.rating > 0 && (
        <div className="absolute bottom-1 left-1 rounded bg-black/50 px-1 text-[10px] leading-tight tracking-tight text-rating transition-opacity group-hover:opacity-0">
          {"★".repeat(photo.rating)}
        </div>
      )}

      {photo.stackId && <StackBadge photoId={photo.id} />}

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

/** A file name's extension in capitals ("NEF", "JPG"), or null when it has none. */
function fileTypeOf(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toUpperCase() : null;
}

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
