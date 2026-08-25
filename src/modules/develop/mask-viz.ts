// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

/** Index of the mask the coverage overlay should visualize, or -1 for none.
 *  Hover wins over selection; the selected mask shows only while its editor is
 *  on the Coverage tab (the Adjust tab deliberately hides the tint). Both ids
 *  are resolved against the current mask list: a stale id — deleted under the
 *  pointer, or orphaned by undo — falls through instead of blanking the
 *  overlay for a live selection. */
export function resolveVizMaskIndex(
  masks: readonly { id: string }[],
  hoveredMaskId: string | null,
  selectedMaskId: string | null,
  maskTab: "coverage" | "adjust",
): number {
  if (hoveredMaskId) {
    const idx = masks.findIndex((m) => m.id === hoveredMaskId);
    if (idx >= 0) return idx;
  }
  if (selectedMaskId && maskTab === "coverage") {
    return masks.findIndex((m) => m.id === selectedMaskId);
  }
  return -1;
}
