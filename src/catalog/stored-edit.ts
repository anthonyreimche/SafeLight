// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Append one snapshot to a photo's stored edit without opening it in Develop;
// Paste Settings and Update processing change Library photos this way, a whole
// selection at a time with one catalog write.
//
// Mirrors what develop-store.commitEdit does for the open photo, but works on any
// catalog photo straight from its persisted EditState. Grid thumbnails are
// deliberately NOT re-rendered here — that would reintroduce the folder-wide
// decode pass we removed (see feedback-plain-grid-thumbnails); the new look
// surfaces in Develop, and the broadcast refreshes the histogram.

import type { DevelopParams, EditSnapshot, EditState } from "./types";
import { NEUTRAL_TEMPERATURE_K, freshParams, normalizeParams } from "./types";
import { catalogStorage, type CatalogStorage } from "./storage";
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

/** Turns a photo's current look into the look to append, or null to change nothing. */
type NextLook = (base: StoredLook) => StoredLook | null;

/** A photo to append to. `asShot` is its as-shot temperature: it seeds a photo that
 *  was never edited, and Develop reloads the photo with it. */
export interface StoredSnapshotTarget {
  photoId: string;
  asShot: number;
}

/** One photo's edit with its new step appended, waiting to be stored and announced. */
interface AppendedEdit {
  target: StoredSnapshotTarget;
  editState: EditState;
  /** The look the new step holds. */
  params: DevelopParams;
}

/** The targets for the catalog photos among `ids`, in `ids` order. An id that is not
 *  in the catalog is skipped. */
export function storedSnapshotTargets(ids: string[]): StoredSnapshotTarget[] {
  const photos = new Map(useCatalogStore.getState().photos.map((p) => [p.id, p] as const));
  return ids.flatMap((photoId) => {
    const photo = photos.get(photoId);
    if (!photo) return [];
    return [{ photoId, asShot: photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K }];
  });
}

/** `target`'s stored edit with the look `next` returns appended as `label`, or null
 *  when `next` declines. Reads storage and writes nothing. */
async function appendedEdit(
  storage: CatalogStorage,
  target: StoredSnapshotTarget,
  label: string,
  next: NextLook,
): Promise<AppendedEdit | null> {
  const { photoId, asShot } = target;
  const existing = await storage.getEditState(photoId);

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
  if (!look) return null;

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
  return { target, editState, params: look.params };
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
  next: NextLook,
): Promise<boolean> {
  return (await appendStoredSnapshots([{ photoId, asShot }], label, next)) === 1;
}

/** appendStoredSnapshot for many photos, stored with one putEditStates call: a
 *  putEditState per photo rewrites the whole catalog each time. Every photo's new
 *  state is worked out before any is written, so a failure there changes none of
 *  them. They are then stored together, the photo open in Develop is reloaded at
 *  once, and each changed photo is announced in order. An announcement that throws
 *  is logged and does not stop the others. A photo `next` declines is left out, and
 *  one listed twice counts once. Returns how many photos changed. */
export async function appendStoredSnapshots(
  targets: StoredSnapshotTarget[],
  label: string,
  next: NextLook,
): Promise<number> {
  const storage = catalogStorage();

  const appended: AppendedEdit[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.photoId)) continue;
    seen.add(target.photoId);
    const edit = await appendedEdit(storage, target, label, next);
    if (edit) appended.push(edit);
  }
  if (appended.length === 0) return 0;

  const stored = storage.putEditStates(appended.map((edit) => edit.editState));

  // Develop's next commit or undo writes back its own in-memory history, which would
  // erase the new step. The storage holds the new states once the call returns, so
  // reload the open photo now, not after the save, and before the awaited hooks below.
  const develop = useDevelopStore.getState();
  const open = appended.find(({ target }) => target.photoId === develop.photoId);
  await Promise.all([stored, open && develop.loadEdit(open.target.photoId, open.target.asShot)]);

  for (const { target, editState, params } of appended) {
    try {
      // Let extensions persist the committed edit elsewhere (e.g. XMP sidecars).
      const photo = useCatalogStore.getState().photos.find((p) => p.id === target.photoId);
      if (photo) await emitEditCommit({ photo, editState });

      // Refresh this photo's histogram wherever it's shown.
      broadcast({ type: "edit-update", payload: { photoId: target.photoId, params } });
    } catch (error) {
      // The edit is already stored; a failed announcement must not hold back the rest.
      console.warn(`[stored-edit] announcing ${target.photoId} failed:`, error);
    }
  }
  return appended.length;
}
