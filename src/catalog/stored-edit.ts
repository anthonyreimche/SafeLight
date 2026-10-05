// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Append one snapshot to a photo's stored edit without opening it in Develop;
// Paste Settings and Update processing change Library photos this way.
//
// Mirrors what develop-store.commitEdit does for the open photo, but works on any
// catalog photo straight from its persisted EditState. Grid thumbnails are
// deliberately NOT re-rendered here — that would reintroduce the folder-wide
// decode pass we removed (see feedback-plain-grid-thumbnails); the new look
// surfaces in Develop, and the broadcast refreshes the histogram.

import type { DevelopParams, EditSnapshot, EditState } from "./types";
import { freshParams, normalizeParams } from "./types";
import { catalogStorage } from "./storage";
import { historyCursor } from "./history-cursor";
import { normalizeParamBag } from "@/extensions/param-registry";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { broadcast } from "@/state/broadcast";
import { emitEditCommit } from "@/extensions/registry";

/** The look one snapshot holds. `paramBag` is the extension param bag, keyed by
 *  qualified key like `EditSnapshot.paramBag`. */
export interface StoredLook {
  params: DevelopParams;
  paramBag: Record<string, unknown>;
}

/** Append a snapshot labelled `label` to the photo's stored edit, and make it the
 *  current step. `next` receives the photo's current look and returns the look to
 *  append, or null to change nothing: then nothing is written or announced and the
 *  result is false. A photo that is open in Develop is reloaded from storage, since
 *  Develop's next commit writes back its own in-memory history and would otherwise
 *  drop the appended step. */
export async function appendStoredSnapshot(
  photoId: string,
  asShot: number,
  label: string,
  next: (base: StoredLook) => StoredLook | null,
): Promise<boolean> {
  const existing = await catalogStorage().getEditState(photoId);

  // Baseline = the photo's current committed look (honoring a prior undo), or its
  // as-shot defaults if it was never edited. A never-edited photo gets a seeded
  // "Original" snapshot so the new step stays undoable back to the untouched state.
  let stack: EditSnapshot[];
  let base: StoredLook;
  if (existing && existing.stack.length > 0) {
    // The stored cursor may be unusable; work from the snapshot Develop opens on.
    const cursor = historyCursor(existing.currentIndex, existing.stack.length);
    stack = existing.stack.slice(0, cursor + 1);
    const top = stack[stack.length - 1];
    base = { params: normalizeParams(top.params), paramBag: normalizeParamBag(top.paramBag) };
  } else {
    base = { params: freshParams(asShot), paramBag: {} };
    stack = [
      { timestamp: Date.now(), label: "Original", params: freshParams(asShot), paramBag: {} },
    ];
  }

  const look = next(base);
  if (!look) return false;

  const snapshot: EditSnapshot = {
    timestamp: Date.now(),
    label,
    params: look.params,
    paramBag: look.paramBag,
  };
  const newStack = [...stack, snapshot];
  const editState: EditState = {
    photoId,
    stack: newStack,
    currentIndex: newStack.length - 1,
  };
  await catalogStorage().putEditState(editState);

  const develop = useDevelopStore.getState();
  if (develop.photoId === photoId) await develop.loadEdit(photoId, asShot);

  // Let extensions persist the committed edit elsewhere (e.g. XMP sidecars).
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (photo) await emitEditCommit({ photo, editState });

  // Refresh this photo's histogram wherever it's shown.
  broadcast({ type: "edit-update", payload: { photoId, params: look.params } });
  return true;
}
