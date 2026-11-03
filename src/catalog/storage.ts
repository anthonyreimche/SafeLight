// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pluggable catalog persistence. Safelight is project-based: opening a folder
// installs a ProjectStorage backed by that folder's .safelight/ directory.
// With no project open, the catalog is empty and writes are no-ops.

import type { CatalogPhoto, EditState } from "./types";

export interface CatalogStorage {
  putPhoto(photo: CatalogPhoto): Promise<void>;
  /** Store the records, then their previews that changed. A preview that can't be
   *  written doesn't reject: the records are stored either way, and the next put
   *  that carries the preview writes it again. */
  putPhotos(photos: CatalogPhoto[]): Promise<void>;
  /** Remove several photos at once: one save and one message to the other windows,
   *  where a deletePhoto per photo would send and save each. */
  deletePhotos(ids: readonly string[]): Promise<void>;
  getEditState(photoId: string): Promise<EditState | undefined>;
  /** getEditState returns the new state once this call returns, before its save
   *  settles: a caller may reload Develop then (extension host, stored-edit). */
  putEditState(editState: EditState): Promise<void>;
  /** Store every given edit state, then persist once. A bulk action uses this
   *  instead of one putEditState per photo, each of which rewrites the whole
   *  catalog. An empty list writes nothing. As with putEditState, the states are
   *  held once the call returns, before the save settles. */
  putEditStates(editStates: EditState[]): Promise<void>;
  /** The record this copy holds for a photo it shows, as it stands now, or
   *  undefined when it holds none. A write that changes only part of a record
   *  builds on this, not on a copy taken earlier. */
  heldPhoto?(photoId: string): CatalogPhoto | undefined;
  /** Read a photo's grid preview (JPEG), or null when it has none and none can be
   *  built. By default the storage keeps what it read, to tell later whether a put
   *  carries a new preview; `hold: false` is for a caller that reads many previews
   *  and keeps none, such as a scan of the whole catalog. */
  readPreview?(photoId: string, options?: { hold?: boolean }): Promise<Blob | null>;
  /** Read an opaque per-photo binary blob (e.g. an extension's warp field),
   *  or null if none was stored. `key` is the caller-namespaced blob key. */
  getPhotoBlob?(photoId: string, key: string): Promise<Uint8Array | null>;
  /** Store (or, with null, delete) an opaque per-photo binary blob. These live
   *  outside catalog.json as individual sidecar files so large payloads don't
   *  bloat the whole-file JSON rewrite on every save. */
  putPhotoBlob?(photoId: string, key: string, data: Uint8Array | null): Promise<void>;
  /** Write any pending (debounced) changes now. With `unloading` (the window is
   *  closing), the write starts at once even beside one still running, since a
   *  closing page won't run a write queued behind it. */
  flush?(options?: { unloading?: boolean }): Promise<void>;
  /** The window has left this catalog: nothing the storage takes on is reported
   *  any more, and it stops following the other windows once it has nothing left
   *  to write. Writes made through it still persist. Closing it again does nothing.
   *  setCatalogStorage closes the storage it replaces. */
  close?(): void;
}

const empty: CatalogStorage = {
  putPhoto: async () => {},
  putPhotos: async () => {},
  deletePhotos: async () => {},
  getEditState: async () => undefined,
  putEditState: async () => {},
  putEditStates: async () => {},
};

let active: CatalogStorage = empty;

export function setCatalogStorage(s: CatalogStorage | null): void {
  const next = s ?? empty;
  if (next !== active) active.close?.();
  active = next;
}

export function catalogStorage(): CatalogStorage {
  return active;
}
