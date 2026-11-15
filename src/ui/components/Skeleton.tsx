// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CSSProperties } from "react";

export interface SkeletonProps {
  /** Size and shape: the caller gives the width and height of what will arrive. */
  style?: CSSProperties;
  className?: string;
}

/** A breathing block standing in for content still loading, in its expected place and
 *  size, so the layout doesn't jump when it arrives. */
export function Skeleton({ style, className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`sl-breathe rounded bg-surface-3 ${className ?? ""}`}
      style={style}
    />
  );
}
