import type { DevelopParams } from "./types";
import { normalizeParams } from "./types";
import { catalogDB } from "./db";

// The saved develop params for a photo — the current point in its edit history,
// or normalized defaults if it was never edited. Shared by Loupe preview
// rendering and Export so both show exactly what Develop persisted.
export async function loadSavedParams(photoId: string): Promise<DevelopParams> {
  const edit = await catalogDB.getEditState(photoId);
  if (edit && edit.stack.length > 0) {
    return normalizeParams(edit.stack[edit.currentIndex].params);
  }
  return normalizeParams(undefined);
}
