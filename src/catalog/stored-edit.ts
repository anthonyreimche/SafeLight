// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Append one snapshot to a photo's stored edit without opening it in Develop;
// Paste Settings and Update processing change Library photos this way, a whole
// selection at a time with one catalogue write.
//
// Mirrors what develop-store.commitEdit does for the open photo, but works on any
// catalogue photo straight from its persisted EditState. Each changed photo's grid
// preview is queued to be drawn again in the background, two at a time
// (refreshStoredThumbnails), and the broadcast refreshes the histogram.

import type { EditState } from "./types";
import { NEUTRAL_TEMPERATURE_K } from "./types";
import { catalogStorage, type CatalogStorage } from "./storage";
import { appendStep, currentLook } from "./edit-steps";
import { writeInTurn } from "./edit-writes";
import { useCatalogStore } from "@/state/catalog-store";
import { useDevelopStore } from "@/state/develop-store";
import { broadcast } from "@/state/broadcast";
import { emitEditCommit } from "@/extensions/registry";
import { normalizeParamBag } from "@/extensions/param-registry";
import { refreshStoredThumbnails } from "@/state/edited-thumbnail";
import type { StoredLook } from "./stored-edit-look";

export type { StoredLook } from "./stored-edit-look";

/** Turns a photo's current look into the look to append, or null to change nothing.
 *  `target` is the photo it is for. */
type NextLook = (base: StoredLook, target: StoredSnapshotTarget) => StoredLook | null;

/** A photo to append to. `asShot` is its as-shot temperature: it seeds a photo that
 *  was never edited, and Develop reloads the photo with it. */
export interface StoredSnapshotTarget {
  photoId: string;
  asShot: number;
}

/** How an appended step is made. `source` is the extension the step is made
 *  for, which stamps it in local history. */
export interface AppendOptions {
  source?: string;
}

/** One photo's edit with its new step appended, waiting to be stored and announced. */
interface AppendedEdit {
  target: StoredSnapshotTarget;
  look: StoredLook;
  editState: EditState;
}

/** The targets for the catalogue photos among `ids`, in `ids` order. An id that is not
 *  in the catalogue is skipped. */
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
  source?: string,
): Promise<AppendedEdit | null> {
  const existing = await storage.getEditState(target.photoId);
  const look = next(currentLook(existing, target.asShot), target);
  if (!look) return null;
  return { target, look, editState: appendStep(existing, target, label, look, Date.now(), source) };
}

/** Append a snapshot labelled `label` to the photo's stored edit, and make it the
 *  current step. `next` receives the photo's current look and returns the look to
 *  append, or null to change nothing: then nothing is written or announced and the
 *  result is false. A photo that is open in Develop is reloaded from storage, so it
 *  shows the appended step. */
export async function appendStoredSnapshot(
  photoId: string,
  asShot: number,
  label: string,
  next: NextLook,
): Promise<boolean> {
  return (await appendStoredSnapshots([{ photoId, asShot }], label, next)) === 1;
}

/** appendStoredSnapshot for many photos, stored with one putEditStates call: a
 *  putEditState per photo rewrites the whole catalogue each time. Every photo's new
 *  state is worked out before any is written, so a failure there changes none of
 *  them. They are then stored together, the photo open in Develop is reloaded at
 *  once, and each changed photo is announced in order. An announcement that throws
 *  is logged and does not stop the others, and every changed photo's grid preview
 *  is then queued to be drawn again. A photo `next` declines is left out, and one
 *  listed twice counts once. Returns how many photos changed. */
export async function appendStoredSnapshots(
  targets: StoredSnapshotTarget[],
  label: string,
  next: NextLook,
  options: AppendOptions = {},
): Promise<number> {
  const storage = catalogStorage();

  const { appended, stored } = await writeInTurn(
    targets.map((target) => target.photoId),
    async () => {
      const appended: AppendedEdit[] = [];
      const seen = new Set<string>();
      for (const target of targets) {
        if (seen.has(target.photoId)) continue;
        seen.add(target.photoId);
        const edit = await appendedEdit(storage, target, label, next, options.source);
        if (edit) appended.push(edit);
      }
      const stored =
        appended.length > 0 ? storage.putEditStates(appended.map((edit) => edit.editState)) : undefined;
      return { appended, stored };
    },
  );
  if (!stored) return 0;

  // Develop shows the new step on the open photo. The storage holds the new states
  // once the call returns, so reload it now, not after the save, and before the
  // awaited hooks below.
  const develop = useDevelopStore.getState();
  const open = appended.find(({ target }) => target.photoId === develop.photoId);
  await Promise.all([stored, open && develop.loadEdit(open.target.photoId, open.target.asShot)]);

  for (const { target, editState } of appended) {
    try {
      // Let extensions persist the committed edit elsewhere (e.g. XMP sidecars).
      const photo = useCatalogStore.getState().photos.find((p) => p.id === target.photoId);
      if (photo) await emitEditCommit({ photo, editState });

      // Refresh this photo's histogram wherever it's shown.
      broadcast({ type: "edit-update", payload: { photoId: target.photoId } });
    } catch (error) {
      // The edit is already stored; a failed announcement must not hold back the rest.
      console.warn(`[stored-edit] announcing ${target.photoId} failed:`, error);
    }
  }
  refreshStoredThumbnails(appended.map(({ target }) => target.photoId));
  return appended.length;
}

/** Commit `patch` over the bag of catalogue photo `photoId`, which needn't be
 *  open, as one history step labelled `label` made for extension `source`: its
 *  keys replace the photo's own, computed values included. The step is stored
 *  with the edit-commit hooks run, the Library told, and the grid preview drawn
 *  from the new look. Resolves false, writing nothing, when the photo already
 *  holds every value. */
export async function applyBagPatch(
  photoId: string,
  patch: Record<string, unknown>,
  label: string,
  source: string,
): Promise<boolean> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch))
    throw new Error("applyBagPatch: the patch must be an object of bag keys");
  const [target] = storedSnapshotTargets([photoId]);
  if (!target) throw new Error(`applyBagPatch: photo ${photoId} is not in the catalogue`);
  const values = normalizeParamBag(patch);
  const changed = await appendStoredSnapshots(
    [target],
    label,
    (base) =>
      Object.entries(values).every(([key, value]) => JSON.stringify(base.paramBag[key]) === JSON.stringify(value))
        ? null
        : { params: base.params, paramBag: { ...base.paramBag, ...values } },
    { source },
  );
  return changed === 1;
}
