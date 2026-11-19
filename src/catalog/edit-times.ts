// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// When each photo's edit last changed, for the Library's Edited filter and sort.
// Read from the edit history the shown project's storage holds, never stored
// apart from it, so an undo, another window's edit or a `safelight` command
// can't leave it behind.

import { useSyncExternalStore } from "react";
import { catalogStorage, onHeldEditsChanged } from "./storage";
import type { EditState } from "./types";

/** When the step a photo's history stands on was made, or undefined for a photo
 *  never edited or with every step undone. */
export function editTimeOf(state: EditState | undefined): number | undefined {
  if (!state || state.currentIndex <= 0) return undefined;
  return state.stack[state.currentIndex]?.timestamp;
}

/** editTimeOf for a photo of the shown project. */
export function editedAt(photoId: string): number | undefined {
  return editTimeOf(catalogStorage().heldEditState?.(photoId));
}

let version = 0;
const listeners = new Set<() => void>();

onHeldEditsChanged((storage) => {
  if (storage !== catalogStorage()) return;
  version++;
  for (const listener of [...listeners]) listener();
});

/** Changes whenever editedAt may give another answer for some photo. */
export function editTimesVersion(): number {
  return version;
}

/** Hear that editedAt may give another answer. Returns the unsubscribe. */
export function subscribeEditTimes(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** editedAt as a React hook: draws again when this photo's edit time changes. */
export function useEditedAt(photoId: string): number | undefined {
  const read = () => editedAt(photoId);
  return useSyncExternalStore(subscribeEditTimes, read, read);
}
