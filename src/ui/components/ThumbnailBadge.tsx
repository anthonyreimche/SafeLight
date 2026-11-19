// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ReactNode } from "react";

export interface ThumbnailBadgeProps {
  children: ReactNode;
  /** The tooltip, and the name a screen reader gives the badge. */
  title?: string;
}

/** A small marker on a thumbnail, with the look of the flag and keyword badges:
 *  edited, the file type, or a badge an extension registers (api.registerThumbnailBadge). */
export function ThumbnailBadge({ children, title }: ThumbnailBadgeProps) {
  return (
    <div
      title={title}
      aria-label={title}
      className="sl-thumbnail-badge rounded bg-black/50 px-1 text-[10px] leading-tight text-on-media-muted"
    >
      {children}
    </div>
  );
}
