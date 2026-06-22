// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pluggable catalog persistence. Safelight is project-based: opening a folder
// installs a ProjectStorage backed by that folder's .safelight/ directory.
// With no project open, the catalog is empty and writes are no-ops.

import type { CatalogPhoto, EditState } from "./types";

export interface CatalogStorage {
  getAllPhotos(): Promise<CatalogPhoto[]>;
  putPhoto(photo: CatalogPhoto): Promise<void>;
  putPhotos(photos: CatalogPhoto[]): Promise<void>;
  deletePhoto(id: string): Promise<void>;
  getEditState(photoId: string): Promise<EditState | undefined>;
  getAllEditStates(): Promise<EditState[]>;
  putEditState(editState: EditState): Promise<void>;
  /** Read an opaque per-photo binary blob (e.g. an extension's warp field),
   *  or null if none was stored. `key` is the caller-namespaced blob key. */
  getPhotoBlob?(photoId: string, key: string): Promise<Uint8Array | null>;
  /** Store (or, with null, delete) an opaque per-photo binary blob. These live
   *  outside catalog.json as individual sidecar files so large payloads don't
   *  bloat the whole-file JSON rewrite on every save. */
  putPhotoBlob?(photoId: string, key: string, data: Uint8Array | null): Promise<void>;
  /** Write any pending (debounced) changes immediately, e.g. on app quit. */
  flush?(): Promise<void>;
}

const empty: CatalogStorage = {
  getAllPhotos: async () => [],
  putPhoto: async () => {},
  putPhotos: async () => {},
  deletePhoto: async () => {},
  getEditState: async () => undefined,
  getAllEditStates: async () => [],
  putEditState: async () => {},
};

let active: CatalogStorage = empty;

export function setCatalogStorage(s: CatalogStorage | null): void {
  active = s ?? empty;
}

export function catalogStorage(): CatalogStorage {
  return active;
}
