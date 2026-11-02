// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";

// The mask whose coverage the develop view tints over the image (fading in and
// out, use-develop-renderer): the one Masking's panel is pointing at, hovered
// or being edited. View state only; one extension sets it at a time.

export const useMaskCoverageView = create<{ maskId: string | null }>(() => ({ maskId: null }));

/** Tint mask `maskId`'s coverage over the image, or with null none. */
export function showMaskCoverage(maskId: string | null): void {
  if (useMaskCoverageView.getState().maskId !== maskId) useMaskCoverageView.setState({ maskId });
}
