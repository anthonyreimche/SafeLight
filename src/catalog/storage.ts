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
