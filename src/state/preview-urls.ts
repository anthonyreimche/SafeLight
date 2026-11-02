// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Object URLs of grid previews whose <img> has fired `load`. The grid remounts on
// every module switch, so a preview it already showed must not fade in a second
// time. A URL leaves the set when the catalog store revokes it, so the set holds
// only previews that still exist.
const loaded = new Set<string>();

export const hasPreviewLoaded = (url: string | null): boolean => url !== null && loaded.has(url);

export function markPreviewLoaded(url: string): void {
  loaded.add(url);
}

/** Revoke a preview's object URL and forget that it was shown. */
export function revokePreviewUrl(url: string): void {
  loaded.delete(url);
  URL.revokeObjectURL(url);
}
