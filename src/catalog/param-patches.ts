// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A Library photo's settings, read and changed without opening it in Develop
// (#218): what api.catalog.getLook and applyParamPatches answer. A batch tool
// measures each photo from its stored look, then commits every photo's own
// patch in one catalogue write, a step on each photo in the extension's name.

import { catalogStorage } from "./storage";
import { currentLook } from "./edit-steps";
import { appendStoredSnapshots, storedSnapshotTargets, type StoredLook } from "./stored-edit";
import { freshParams, type DevelopParams } from "./types";

/** New values for some of one photo's settings. */
export interface ParamPatch {
  photoId: string;
  params: Partial<DevelopParams>;
}

const PATCHABLE: ReadonlyMap<string, unknown> = new Map(
  Object.entries(freshParams()).filter(([key]) => key !== "processVersion"),
);

const kindOf = (value: unknown): string => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

/** The photo's look under its stored cursor: its settings and extension bag, or
 *  the as-shot defaults for a photo never edited. Changes the open photo has
 *  not committed yet aren't in it. */
export async function storedLook(photoId: string): Promise<StoredLook> {
  const [target] = storedSnapshotTargets([photoId]);
  if (!target) throw new Error(`getLook: photo ${photoId} is not in the catalogue`);
  return currentLook(await catalogStorage().getEditState(photoId), target.asShot);
}

/** Why `params` can't be committed, or null. A key must be one of the settings,
 *  other than the process version, and its value of the setting's kind. */
function patchError(params: unknown): string | null {
  if (kindOf(params) !== "object") return "params must be an object of settings";
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (!PATCHABLE.has(key)) return `${key} is not a setting a patch can change`;
    const want = kindOf(PATCHABLE.get(key));
    if (kindOf(value) !== want) return `${key} must be ${want === "object" ? "an object" : `a ${want}`}`;
    if (typeof value === "number" && !Number.isFinite(value)) return `${key} must be a finite number`;
  }
  return null;
}

/** Commit each photo's patch over its stored settings as one step labelled
 *  `label`, made for extension `source`, every photo in one catalogue write.
 *  Two patches for one photo merge in order. A photo that already holds every
 *  value is left out. Every patch is checked first, so a bad one, or a photo the
 *  catalogue doesn't hold, rejects the call with nothing written. Resolves to
 *  how many photos changed. */
export async function applyParamPatches(patches: ParamPatch[], label: string, source: string): Promise<number> {
  if (!Array.isArray(patches)) throw new Error("applyParamPatches: patches must be a list of { photoId, params }");
  if (typeof label !== "string") throw new Error("applyParamPatches: label must be a string");
  const merged = new Map<string, Partial<DevelopParams>>();
  for (const patch of patches) {
    const error = patchError(patch?.params);
    if (error) throw new Error(`applyParamPatches: ${error} (photo ${String(patch?.photoId)})`);
    merged.set(patch.photoId, { ...merged.get(patch.photoId), ...patch.params });
  }
  const targets = storedSnapshotTargets([...merged.keys()]);
  if (targets.length !== merged.size) {
    const held = new Set(targets.map((t) => t.photoId));
    const missing = [...merged.keys()].find((id) => !held.has(id));
    throw new Error(`applyParamPatches: photo ${missing} is not in the catalogue`);
  }
  return appendStoredSnapshots(
    targets,
    label,
    (base, target) => {
      const patch = merged.get(target.photoId) ?? {};
      const same = Object.entries(patch).every(
        ([key, value]) => JSON.stringify(base.params[key as keyof DevelopParams]) === JSON.stringify(value),
      );
      return same ? null : { params: { ...base.params, ...patch }, paramBag: base.paramBag };
    },
    { source },
  );
}
