// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Paste copied develop settings onto Library photos without opening Develop.
//
// Mirrors what develop-store.commitEdit does for the active photo, but works on
// any catalog photo straight from its persisted EditState: merge the clipboard's
// partial params/bag over the photo's current look, append a history snapshot,
// persist, and announce the change. Grid thumbnails are deliberately NOT
// re-rendered here — that would reintroduce the folder-wide decode pass we
// removed (see feedback-plain-grid-thumbnails); the pasted look surfaces in
// Loupe/Develop, and the broadcast refreshes the histogram.

import type { DevelopParams, EditSnapshot, EditState } from "./types";
import { normalizeParams } from "./types";
import { catalogStorage } from "./storage";
import { normalizeParamBag } from "@/extensions/param-registry";
import { useCatalogStore } from "@/state/catalog-store";
import { broadcast } from "@/state/broadcast";
import { emitEditCommit } from "@/extensions/registry";
import type { DevelopClipboard } from "@/state/develop-clipboard";

const PASTE_LABEL = "Paste Settings";

async function pasteToPhoto(
  photoId: string,
  clip: DevelopClipboard,
  asShot: number,
): Promise<void> {
  const existing = await catalogStorage().getEditState(photoId);

  // Baseline = the photo's current committed look (honoring a prior undo), or its
  // as-shot defaults if it was never edited. A never-edited photo gets a seeded
  // "Original" snapshot so the paste stays undoable back to the untouched state.
  let stack: EditSnapshot[];
  let baseParams: DevelopParams;
  let baseBag: Record<string, unknown>;
  if (existing && existing.stack.length > 0) {
    stack = existing.stack.slice(0, existing.currentIndex + 1);
    const top = stack[stack.length - 1];
    baseParams = normalizeParams(top.params);
    baseBag = normalizeParamBag(top.paramBag);
  } else {
    baseParams = normalizeParams({ temperature: asShot });
    baseBag = {};
    stack = [
      { timestamp: Date.now(), label: "Original", params: baseParams, paramBag: {} },
    ];
  }

  const params = normalizeParams({ ...baseParams, ...clip.params });
  const paramBag = { ...baseBag, ...normalizeParamBag(clip.paramBag) };

  const snapshot: EditSnapshot = {
    timestamp: Date.now(),
    label: PASTE_LABEL,
    params,
    paramBag,
  };
  const newStack = [...stack, snapshot];
  const editState: EditState = {
    photoId,
    stack: newStack,
    currentIndex: newStack.length - 1,
  };
  await catalogStorage().putEditState(editState);

  // Let extensions persist the committed edit elsewhere (e.g. XMP sidecars).
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (photo) await emitEditCommit({ photo, editState });

  // Refresh this photo's Loupe preview / histogram wherever it's shown.
  broadcast({ type: "edit-update", payload: { photoId, params } });
}

/** Apply the clipboard's settings to every given photo. Returns how many photos
 *  were updated. */
export async function pasteSettings(
  ids: string[],
  clip: DevelopClipboard,
): Promise<number> {
  if (ids.length === 0) return 0;
  const photos = useCatalogStore.getState().photos;
  let n = 0;
  for (const id of ids) {
    const photo = photos.find((p) => p.id === id);
    if (!photo) continue;
    await pasteToPhoto(id, clip, photo.exif.colorTemperature ?? 6500);
    n++;
  }
  return n;
}
