// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Fixtures for the specs of code that edits a stored edit without opening
// Develop (stored-edit, update-processing): a catalog photo, snapshots in the
// two shapes a stack can hold, and an in-memory catalog storage.

import { setCatalogStorage, type CatalogStorage } from "./storage";
import {
  CURRENT_PROCESS_VERSION,
  normalizeParams,
  withoutProcessVersion,
  type CatalogPhoto,
  type DevelopParams,
  type EditSnapshot,
  type EditState,
} from "./types";

export function photo(id: string): CatalogPhoto {
  return {
    id,
    filename: `${id}.NEF`,
    relPath: `${id}.NEF`,
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1024,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
  };
}

/** A snapshot as a current build writes it: params normalised, at the current
 *  process version unless `params` names another. */
export function snapshot(
  label: string,
  params: Partial<DevelopParams>,
  paramBag: Record<string, unknown> = {},
): EditSnapshot {
  return {
    timestamp: 1_700_000_000_000,
    label,
    params: normalizeParams({ processVersion: CURRENT_PROCESS_VERSION, ...params }),
    paramBag,
  };
}

/** A snapshot as a build from before process versions wrote it: no version field
 *  and no bag. The on-disk shape is looser than DevelopParams, hence the cast. */
export function legacySnapshot(label: string, params: Partial<DevelopParams>): EditSnapshot {
  return {
    timestamp: 1_700_000_000_000,
    label,
    params: withoutProcessVersion(normalizeParams(params)) as DevelopParams,
  };
}

export interface MemoryEdits {
  /** Every edit state handed to putEditState, oldest first. */
  written: EditState[];
}

/** Install a catalog storage that holds `seed` in memory. */
export function installMemoryStorage(...seed: EditState[]): MemoryEdits {
  const written: EditState[] = [];
  const states = new Map<string, EditState>(seed.map((s) => [s.photoId, s]));
  const storage: CatalogStorage = {
    getAllPhotos: async () => [],
    putPhoto: async () => {},
    putPhotos: async () => {},
    deletePhoto: async () => {},
    getEditState: async (id) => states.get(id),
    getAllEditStates: async () => [...states.values()],
    putEditState: async (editState) => {
      states.set(editState.photoId, editState);
      written.push(editState);
    },
  };
  setCatalogStorage(storage);
  return { written };
}
