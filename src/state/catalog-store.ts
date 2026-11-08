// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import {
  mergeStoredPhoto,
  type CatalogPhoto,
  type ColorLabel,
  type FlagStatus,
  type LoadedPreview,
  type StoredPhoto,
} from "@/catalog/types";
import { catalogStorage } from "@/catalog/storage";
import { rotateBlob, normalizeRotation } from "@/catalog/orient";
import { mapLimit } from "@/project/fs";
import { broadcast, WINDOW_ID } from "./broadcast";
import { revokePreviewUrl } from "./preview-urls";
import { emitMetadataChange, emitPhotoRemove } from "@/extensions/registry";

/** What a background rebuild of a photo changed (see mergeRebuiltPhoto): an
 *  edited or repaired preview with its size, rotation and the edit it shows, a
 *  re-import's file details, or the RAW metadata an import left pending. */
export type RebuiltChange = Partial<
  Pick<
    CatalogPhoto,
    | "thumbnailBlob"
    | "thumbnailUrl"
    | "previewEdit"
    | "width"
    | "height"
    | "rotation"
    | "exif"
    | "decodeError"
    | "fileSize"
    | "mimeType"
    | "dateCreated"
    | "metadataPending"
  >
>;

/** The fields `after` changes from `before`, compared by identity: what a caller
 *  that built `after` from `before` changed. A field `after` lacks is undefined. */
function changesFrom<T extends object>(before: T, after: T): Partial<T> {
  const changes: Partial<T> = {};
  for (const key in after) if (after[key] !== before[key]) changes[key] = after[key];
  for (const key in before) if (!(key in after)) changes[key] = undefined;
  return changes;
}

// Fields that only say how a photo's preview looks. Nothing that filters, sorts
// or scopes the grid reads them, extension filters and sorts included.
const PREVIEW_FIELDS = new Set<string>(["thumbnailBlob", "thumbnailUrl", "previewEdit"]);

// Previews turned at once: each decodes and re-encodes a bitmap.
const ROTATE_CONCURRENCY = 4;

// Fields the open attaches without saying anything about the photo itself.
const HANDLE_FIELDS = new Set<string>(["directoryHandle", "fileHandle"]);

interface Structure {
  version: number;
  /** How many times each field has changed since the structure began. */
  changes: ReadonlyMap<string, number>;
  total: number;
}

const structures = new WeakMap<CatalogPhoto[], Structure>();
let structureCount = 0;

function structureOf(photos: CatalogPhoto[]): Structure {
  let structure = structures.get(photos);
  if (!structure) {
    structure = { version: ++structureCount, changes: new Map(), total: 0 };
    structures.set(photos, structure);
  }
  return structure;
}

/** The catalogue's structure version: the same number for two photos arrays only
 *  when one came from the other with each photo at the same index, changing
 *  nothing but the fields keepStructure was told of (see fieldChanges). Any other
 *  new array (a store update, or a setState from outside) gets a new number. Lets
 *  the grid's filter + sort skip the preview flushes of a big catalogue's open. */
export function structureVersion(photos: CatalogPhoto[]): number {
  return structureOf(photos).version;
}

/** How often the fields named have changed over the life of `photos`' structure
 *  (every field, when `fields` is null): a count that differs between two arrays of
 *  one structure when something that reads those fields has to read again. Previews
 *  and handles never count. */
export function fieldChanges(photos: CatalogPhoto[], fields: readonly string[] | null): number {
  const { changes, total } = structureOf(photos);
  if (!fields) return total;
  let count = 0;
  for (const field of fields) count += changes.get(field) ?? 0;
  return count;
}

// Each photo's index by id, built on first lookup and shared by every array of
// one structure (each holds the same ids at the same indexes).
const indexes = new WeakMap<CatalogPhoto[], Map<string, number>>();

function indexOf(photos: CatalogPhoto[]): Map<string, number> {
  let index = indexes.get(photos);
  if (!index) {
    index = new Map();
    for (let i = 0; i < photos.length; i++) {
      const id = photos[i].id;
      if (!index.has(id)) index.set(id, i);
    }
    indexes.set(photos, index);
  }
  return index;
}

/** The photo with this id in `photos`, as `photos.find` gives it, without a pass
 *  over the catalogue once the array has been looked in. */
export function photoById(photos: CatalogPhoto[], id: string | null): CatalogPhoto | undefined {
  if (id === null) return undefined;
  const i = indexOf(photos).get(id);
  return i === undefined ? undefined : photos[i];
}

/** `to` as the next array of `from`'s structure, with `changed` the fields of its
 *  photos that differ from `from`'s. */
function keepStructure(
  from: CatalogPhoto[],
  to: CatalogPhoto[],
  changed: Iterable<string> = [],
): CatalogPhoto[] {
  const index = indexes.get(from);
  if (index) indexes.set(to, index);
  const base = structureOf(from);
  const tracked = [...changed].filter((f) => !PREVIEW_FIELDS.has(f) && !HANDLE_FIELDS.has(f));
  if (tracked.length === 0) {
    structures.set(to, base);
    return to;
  }
  const changes = new Map(base.changes);
  for (const field of tracked) changes.set(field, (changes.get(field) ?? 0) + 1);
  structures.set(to, { version: base.version, changes, total: base.total + tracked.length });
  return to;
}

/** The fields that differ between two photos arrays that hold the same ids in the
 *  same order, or null when they don't. */
function changedFields(before: CatalogPhoto[], after: CatalogPhoto[]): Set<string> | null {
  if (before.length !== after.length) return null;
  const fields = new Set<string>();
  for (let i = 0; i < before.length; i++) {
    if (before[i].id !== after[i].id) return null;
    if (before[i] !== after[i]) for (const key in changesFrom(before[i], after[i])) fields.add(key);
  }
  return fields;
}

/** Expand a removal set to also include virtual copies of any master in it — a
 *  copy shares its master's file, so removing the master removes its copies too
 *  (matching Lightroom/darktable). Removing a copy on its own only affects it. */
function withVirtualCopies(
  photos: CatalogPhoto[],
  ids: string[],
): string[] {
  const set = new Set(ids);
  for (const p of photos) {
    if (p.copyOf && set.has(p.copyOf)) set.add(p.id);
  }
  return [...set];
}

/** `photo` showing a preview the loader read, with a new object URL for it and the
 *  edit that preview shows, whatever edit the one it replaces showed. */
function withPreview(photo: CatalogPhoto, blob: LoadedPreview): CatalogPhoto {
  return {
    ...photo,
    thumbnailBlob: blob,
    thumbnailUrl: URL.createObjectURL(blob),
    previewEdit: blob.previewEdit,
  };
}

interface CatalogState {
  photos: CatalogPhoto[];
  selectedIds: Set<string>;
  activePhotoId: string | null;
  loading: boolean;
  fileAccessNonce: number; // bumped after re-granting permission, to reload bitmaps
  needsReconnect: boolean; // the last project needs a permission re-grant
  reconnecting: boolean; // a permission re-grant is in progress

  loadCatalog: () => Promise<void>;
  reconnectFiles: () => Promise<void>;
  /** Swap in a freshly opened project's photos (called by the project store). */
  replaceCatalog: (photos: CatalogPhoto[]) => void;
  /** Append photos during a progressive open (no URL revocation, no state reset). */
  appendPhotos: (photos: CatalogPhoto[]) => void;
  /** Add new photo records to the catalogue and DURABLY persist them (unlike
   *  appendPhotos, which is open-time + in-memory only), optionally inserting
   *  each right after a given photo. Used by extensions to add records the core
   *  scan didn't produce — e.g. virtual copies. */
  addPhotos: (
    photos: CatalogPhoto[],
    opts?: { afterId?: string },
  ) => Promise<void>;
  /** Finalize a progressive open: set authoritative list without revoking URLs
   *  (photos are the same object references already shown during the open). */
  finalizeCatalog: (photos: CatalogPhoto[]) => void;
  /** Attach freshly-read grid previews to existing photos (the open-time block
   *  loader). One batched update per block; photos that already have a preview
   *  are left untouched. A photo that takes a preview takes the edit it shows
   *  (previewEdit) with it. Returns the ids that took one. */
  mergeThumbnails: (updates: { id: string; blob: LoadedPreview }[]) => string[];
  /** Replace one photo record in place (same id) with `photo` as given. Revokes
   *  the old object URL. Persistence is the caller's job. */
  updatePhoto: (photo: CatalogPhoto) => void;
  /** Take what a background rebuild changed on a photo (an edited or repaired
   *  preview, or a re-import's file details) onto the photo as the store holds it
   *  now: only the fields in `change`, so whatever else changed while the rebuild
   *  was written, here or in another window, stays. A new preview comes with the
   *  edit `change` names for it (previewEdit), or none. Revokes a preview URL it
   *  replaces. Persistence is the caller's job (it already wrote via putPhoto). */
  mergeRebuiltPhoto: (id: string, change: RebuiltChange) => void;
  /** Replace one photo's preview blob in place (revoking the old URL), e.g. after
   *  another window edited it and we reloaded its <id>.jpg from disk. The photo
   *  takes the edit the preview shows (previewEdit) with it. */
  replaceThumbnail: (id: string, blob: LoadedPreview) => void;
  /** Let go of previews the loader read, revoking their URLs: the photos fall back
   *  to the skeleton and read theirs again when their cell is in view. A photo whose
   *  preview is no longer the blob named (an edit or another read replaced it) keeps
   *  it. Returns the ids that were let go. */
  dropThumbnails: (entries: { id: string; blob: LoadedPreview }[]) => string[];
  /** Take on what another window wrote to the catalogue (see state/catalog-sync):
   *  each photo here gets the stored fields of its record in `photos` and keeps
   *  its own handles, preview, URL and the edit that preview shows (previewEdit),
   *  and the photos in `deletedIds` leave the catalogue and the selection. Ids this
   *  window doesn't have are ignored. Nothing is stored or broadcast: this
   *  window's storage already holds the records. */
  mergeRemoteRecords: (photos: StoredPhoto[], deletedIds: string[]) => void;
  /** Replace the skeleton catalogue with the post-scan list: attach live handles,
   *  add newly-found photos, drop vanished ones — while keeping any previews that
   *  already loaded during the skeleton phase, with the edit each shows. */
  reconcileCatalog: (photos: CatalogPhoto[]) => void;

  removePhoto: (id: string) => Promise<void>;
  removePhotos: (ids: string[]) => Promise<void>;
  /** Persist already-built photo records and show them: photos moved or renamed on
   *  disk, or metadata an extension changed. Build each from the photo as the store
   *  holds it right before the call, since every field that differs is taken as
   *  changed. A record another window sends during the write keeps the rest. */
  relocatePhotos: (updated: CatalogPhoto[]) => Promise<void>;
  /** Set a virtual copy's display name (the distinguisher folded into its
   *  shown/exported name). Display-only — it never touches the file on disk. */
  setCopyName: (id: string, copyName: string) => Promise<void>;

  /** Put the photos in one new stack, `opts.cover` (one of them) as its cover, or
   *  the first of `ids` when none is named. A
   *  photo that was in another stack leaves it. Nothing happens for fewer than two
   *  photos in the catalogue. Catalogue metadata like a rating: no undo entry. */
  setStack: (ids: string[], opts?: { cover?: string }) => Promise<void>;
  /** Take the photos out of their stacks. */
  clearStack: (ids: string[]) => Promise<void>;

  setRating: (id: string, rating: number) => Promise<void>;
  setColorLabel: (id: string, label: ColorLabel) => Promise<void>;
  setFlag: (id: string, flag: FlagStatus) => Promise<void>;

  // Batch variants for culling a whole multi-selection in one transaction.
  applyRating: (ids: string[], rating: number) => Promise<void>;
  applyColorLabel: (ids: string[], label: ColorLabel) => Promise<void>;
  applyFlag: (ids: string[], flag: FlagStatus) => Promise<void>;
  rotatePhotos: (ids: string[], deg: number) => Promise<void>;

  addKeyword: (id: string, keyword: string) => Promise<void>;
  removeKeyword: (id: string, keyword: string) => Promise<void>;
  /** Add keywords to many photos at once. */
  addKeywords: (ids: string[], keywords: string[]) => Promise<void>;
  /** Remove keywords from many photos at once. */
  removeKeywords: (ids: string[], keywords: string[]) => Promise<void>;

  select: (id: string) => void;
  selectRange: (id: string, orderedIds?: string[]) => void;
  toggleSelect: (id: string) => void;
  /** Select the given ids (the photos the grid currently shows), or — when
   *  none are supplied — every photo in the catalogue. */
  selectAll: (ids?: string[]) => void;
  deselectAll: () => void;
  setActivePhoto: (id: string | null, options?: { broadcast?: boolean }) => void;
}

/** How loadCatalog and reconnectFiles reach the last project. project-store sets
 *  it as it loads: it imports this store, so this store doesn't import it. */
export interface LastProjectOpener {
  openLast(): Promise<void>;
  reconnectLast(): Promise<boolean>;
}

let lastProject: LastProjectOpener | null = null;

export function setLastProjectOpener(opener: LastProjectOpener): void {
  lastProject = opener;
}

export const useCatalogStore = create<CatalogState>((set, get) => {
  // Tell the windows (this one's own listeners included) the catalogue changed. The
  // stamp lets a window tell its own echo from another's change. Name a photo
  // (`id`) only when its preview was rewritten: the others reload it.
  const announce = (action: string, id?: string): void =>
    broadcast({ type: "catalog-change", payload: { action, id, origin: WINDOW_ID } });

  // Apply a field change to many photos at once: one storage write, one state
  // update, one broadcast. The single-photo setters delegate here as well.
  const commit = async (
    ids: string[],
    mutate: (p: CatalogPhoto) => CatalogPhoto,
  ): Promise<void> => {
    const idSet = new Set(ids);
    const photos = get().photos;
    if (!photos.some((p) => idSet.has(p.id))) return;
    // Shown before anything is awaited, so a change made while extensions hear of
    // this one is made on top of it, and the records stored are the ones shown.
    const updated: CatalogPhoto[] = [];
    const shown = photos.map((p) => {
      if (!idSet.has(p.id)) return p;
      const next = mutate(p);
      updated.push(next);
      return next;
    });
    set({ photos: keepStructure(photos, shown, changedFields(photos, shown) ?? []) });
    await catalogStorage().putPhotos(updated);
    await emitMetadataChange({
      photos: updated,
      getEditState: (id) => catalogStorage().getEditState(id).then((e) => e ?? null),
    });
    // Metadata leaves every preview as it is: no photo is named. The other
    // windows get the records through catalog-records.
    announce("update");
  };

  // Swap in one photo's record, revoking the preview URL it supersedes. Naming the
  // photo makes other windows reload its preview from disk (see use-window-sync)
  // while this window, which already holds the new blob, ignores its own echo.
  const swapPhoto = (id: string, next: (p: CatalogPhoto) => CatalogPhoto): void => {
    set((s) => {
      const i = indexOf(s.photos).get(id);
      if (i === undefined) return s;
      const p = s.photos[i];
      const swapped = next(p);
      if (p.thumbnailUrl && p.thumbnailUrl !== swapped.thumbnailUrl) {
        revokePreviewUrl(p.thumbnailUrl);
      }
      const photos = s.photos.slice();
      photos[i] = swapped;
      return { photos: keepStructure(s.photos, photos, Object.keys(changesFrom(p, swapped))) };
    });
    announce("update", id);
  };

  return {
    photos: [],
    selectedIds: new Set(),
    activePhotoId: null,
    loading: false,
    fileAccessNonce: 0,
    needsReconnect: false,
    reconnecting: false,

    // Startup: reopen the last project (silently if permission survived,
    // otherwise the reconnect button re-grants on a user gesture).
    async loadCatalog() {
      set({ loading: true });
      try {
        await lastProject?.openLast();
      } finally {
        set({ loading: false });
      }
    },

    async reconnectFiles() {
      if (get().reconnecting) return;
      set({ reconnecting: true });
      try {
        const ok = (await lastProject?.reconnectLast()) ?? false;
        set((s) => ({
          needsReconnect: !ok,
          fileAccessNonce: s.fileAccessNonce + 1,
        }));
      } finally {
        set({ reconnecting: false });
      }
    },

    replaceCatalog(photos) {
      // Old object URLs would dangle once their photos are replaced.
      for (const p of get().photos) {
        if (p.thumbnailUrl) revokePreviewUrl(p.thumbnailUrl);
      }
      set({
        photos,
        selectedIds: new Set(),
        activePhotoId: null,
        needsReconnect: false,
      });
      announce("add");
    },

    appendPhotos(photos) {
      set((s) => ({ photos: [...s.photos, ...photos] }));
    },

    async addPhotos(photos, opts) {
      if (photos.length === 0) return;
      // Persist first so the records survive a reload, then show them.
      await catalogStorage().putPhotos(photos);
      set((s) => {
        const afterId = opts?.afterId;
        if (afterId) {
          const idx = s.photos.findIndex((p) => p.id === afterId);
          if (idx >= 0) {
            const next = s.photos.slice();
            next.splice(idx + 1, 0, ...photos);
            return { photos: next };
          }
        }
        return { photos: [...s.photos, ...photos] };
      });
      announce("add");
    },

    mergeThumbnails(updates) {
      if (updates.length === 0) return [];
      const byId = new Map(updates.map((u) => [u.id, u.blob] as const));
      const taken: string[] = [];
      set((s) => ({
        photos: keepStructure(
          s.photos,
          s.photos.map((p) => {
            const blob = byId.get(p.id);
            // Skip if no blob for this photo, or it already has a preview (avoids
            // leaking an object URL by overwriting a live one).
            if (!blob || p.thumbnailUrl) return p;
            taken.push(p.id);
            return withPreview(p, blob);
          }),
        ),
      }));
      return taken;
    },

    updatePhoto(photo) {
      swapPhoto(photo.id, () => photo);
    },

    mergeRebuiltPhoto(id, change) {
      // A new preview shows the edit its change names, or none.
      const preview = change.thumbnailBlob ? { previewEdit: change.previewEdit } : {};
      swapPhoto(id, (p) => ({ ...p, ...change, ...preview }));
    },

    // Swap in a freshly-read preview blob for one photo, revoking the superseded
    // object URL. Unlike mergeThumbnails (initial load — skips photos that already
    // have a preview), this replaces an existing one. Used when another window
    // edited a photo and we must reload its <id>.jpg from disk. No broadcast: this
    // is a reaction to one, and re-broadcasting would loop.
    replaceThumbnail(id, blob) {
      set((s) => ({
        photos: keepStructure(
          s.photos,
          s.photos.map((p) => {
            if (p.id !== id) return p;
            if (p.thumbnailUrl) revokePreviewUrl(p.thumbnailUrl);
            return withPreview(p, blob);
          }),
        ),
      }));
    },

    dropThumbnails(entries) {
      const byId = new Map(entries.map((e) => [e.id, e.blob] as const));
      const dropped: string[] = [];
      const current = get().photos;
      const photos = current.map((p) => {
        if (!p.thumbnailBlob || byId.get(p.id) !== p.thumbnailBlob) return p;
        if (p.thumbnailUrl) revokePreviewUrl(p.thumbnailUrl);
        dropped.push(p.id);
        return { ...p, thumbnailBlob: null, thumbnailUrl: null };
      });
      if (dropped.length > 0) set({ photos: keepStructure(current, photos) });
      return dropped;
    },

    mergeRemoteRecords(photos, deletedIds) {
      const byId = new Map(photos.map((p) => [p.id, p] as const));
      const gone = new Set(deletedIds);
      const current = get().photos;
      if (!current.some((p) => byId.has(p.id) || gone.has(p.id))) return;
      // Previews of removed photos would dangle for the life of the window.
      for (const p of current) {
        if (gone.has(p.id) && p.thumbnailUrl) revokePreviewUrl(p.thumbnailUrl);
      }
      set((s) => {
        const merged = s.photos.flatMap((p) => {
          if (gone.has(p.id)) return [];
          const stored = byId.get(p.id);
          // The record's previewEdit names the preview on disk, not the one kept here.
          return [stored ? { ...mergeStoredPhoto(p, stored), previewEdit: p.previewEdit } : p];
        });
        if (gone.size === 0) return { photos: merged };
        return {
          photos: merged,
          selectedIds: new Set([...s.selectedIds].filter((id) => !gone.has(id))),
          activePhotoId:
            s.activePhotoId && gone.has(s.activePhotoId) ? null : s.activePhotoId,
        };
      });
    },

    finalizeCatalog(photos) {
      // Same photo objects as those already appended — don't revoke their URLs.
      set({
        photos,
        selectedIds: new Set(),
        activePhotoId: null,
        needsReconnect: false,
      });
      announce("add");
    },

    reconcileCatalog(photos) {
      const prevById = new Map(get().photos.map((p) => [p.id, p] as const));
      const merged = photos.map((p) => {
        // Carry over a preview that loaded during the skeleton phase.
        const old = prevById.get(p.id);
        if (old?.thumbnailUrl && !p.thumbnailUrl) {
          return {
            ...p,
            thumbnailBlob: old.thumbnailBlob,
            thumbnailUrl: old.thumbnailUrl,
            previewEdit: old.previewEdit,
          };
        }
        return p;
      });
      // Revoke previews of photos that vanished on the rescan.
      const keep = new Set(photos.map((p) => p.id));
      for (const p of get().photos) {
        if (!keep.has(p.id) && p.thumbnailUrl) revokePreviewUrl(p.thumbnailUrl);
      }
      set((s) => {
        const selectedIds = new Set([...s.selectedIds].filter((id) => keep.has(id)));
        // A rescan that finds the same photos in the same order mostly attaches
        // handles: what reads only fields it left alone needn't derive again.
        const changed = changedFields(s.photos, merged);
        return {
          photos: changed ? keepStructure(s.photos, merged, changed) : merged,
          selectedIds,
          activePhotoId:
            s.activePhotoId && keep.has(s.activePhotoId) ? s.activePhotoId : null,
        };
      });
      announce("add");
    },

    async removePhoto(id) {
      // Removing a master takes its virtual copies with it. Always the batch
      // path — one teardown sequence (hooks, storage, broadcast) to maintain.
      await get().removePhotos(withVirtualCopies(get().photos, [id]));
    },

    async removePhotos(ids) {
      if (ids.length === 0) return;
      // Removing a master also removes its virtual copies.
      ids = withVirtualCopies(get().photos, ids);
      const idSet = new Set(ids);
      // The project the photos belong to: once another is open, none is removed.
      const storage = catalogStorage();
      const byId = new Map(get().photos.map((p) => [p.id, p] as const));
      // Let extensions react to removal (e.g. delete XMP sidecars).
      for (const id of ids) {
        const photo = byId.get(id);
        if (photo?.directoryHandle && photo?.fileHandle) {
          await emitPhotoRemove({
            photo,
            dir: photo.directoryHandle,
            fileName: photo.fileHandle.name,
          });
        }
      }
      if (catalogStorage() !== storage) return;
      // Storage drops the records at once; the grid follows then, not once their
      // previews and blobs are gone, or edits made meanwhile land on no record.
      const cleanup = storage.deletePhotos(ids);
      if (catalogStorage() !== storage) return cleanup;
      // Previews of removed photos would dangle for the life of the window.
      for (const p of get().photos) {
        if (idSet.has(p.id) && p.thumbnailUrl) revokePreviewUrl(p.thumbnailUrl);
      }
      set((s) => {
        const selectedIds = new Set(s.selectedIds);
        for (const id of ids) selectedIds.delete(id);
        return {
          photos: s.photos.filter((p) => !idSet.has(p.id)),
          selectedIds,
          activePhotoId:
            s.activePhotoId && idSet.has(s.activePhotoId)
              ? null
              : s.activePhotoId,
        };
      });
      announce("remove", ids.length === 1 ? ids[0] : undefined);
      await cleanup;
    },

    async relocatePhotos(updated) {
      if (updated.length === 0) return;
      const byId = new Map(updated.map((p) => [p.id, p] as const));
      const was = new Map(
        get().photos.filter((p) => byId.has(p.id)).map((p) => [p.id, p] as const),
      );
      await catalogStorage().putPhotos(updated);
      // A photo another window's record changed during the write takes only what
      // the caller changed.
      set((s) => ({
        photos: s.photos.map((p) => {
          const to = byId.get(p.id);
          if (!to) return p;
          const from = was.get(p.id);
          return !from || p === from ? to : { ...p, ...changesFrom(from, to) };
        }),
      }));
      announce("update");
    },

    async setCopyName(id, copyName) {
      const photo = get().photos.find((p) => p.id === id);
      if (!photo) return;
      const named = (p: CatalogPhoto): CatalogPhoto => ({
        ...p,
        copyName: copyName.trim() || undefined,
      });
      await catalogStorage().putPhotos([named(photo)]);
      set((s) => ({ photos: s.photos.map((p) => (p.id === id ? named(p) : p)) }));
      announce("update");
    },

    async rotatePhotos(ids, deg) {
      const d = normalizeRotation(deg);
      if (d === 0 || ids.length === 0) return;
      const swap = d === 90 || d === 270;
      const turnBlob = (blob: Blob | null) => (blob ? rotateBlob(blob, d) : Promise.resolve(null));
      const updates = new Map<string, CatalogPhoto>();

      // The photos may change, or leave the catalogue, while their previews turn:
      // each is turned as it is now, and only if it's still here. A preview stored
      // meanwhile (an edit's) is turned again in place of the one it began with,
      // and the turn keeps the edit its source shows.
      let pending = new Set(ids);
      while (pending.size > 0) {
        const sources = get().photos.filter((p) => pending.has(p.id));
        const turned = new Map(
          await mapLimit(
            sources,
            ROTATE_CONCURRENCY,
            async (from) => [from.id, { from, blob: await turnBlob(from.thumbnailBlob) }] as const,
          ),
        );
        pending = new Set();
        const round: CatalogPhoto[] = [];
        const photos = get().photos.map((current) => {
          const t = turned.get(current.id);
          if (!t) return current;
          if (current.thumbnailBlob !== t.from.thumbnailBlob) {
            pending.add(current.id);
            return current;
          }
          const turn = {
            rotation: normalizeRotation((current.rotation ?? 0) + d),
            width: swap ? current.height : current.width,
            height: swap ? current.width : current.height,
            thumbnailBlob: t.blob ?? current.thumbnailBlob,
            thumbnailUrl: t.blob ? URL.createObjectURL(t.blob) : current.thumbnailUrl,
            previewEdit: t.from.previewEdit,
          };
          if (current.thumbnailUrl && current.thumbnailUrl !== turn.thumbnailUrl)
            revokePreviewUrl(current.thumbnailUrl);
          const updated: CatalogPhoto = { ...current, ...turn };
          round.push(updated);
          updates.set(updated.id, updated);
          return updated;
        });
        if (round.length === 0) continue;
        // Shown before it is written: an edit's preview rendered from here on is
        // made at the new rotation, and one stored later replaces this one.
        set({ photos });
        await catalogStorage().putPhotos(round);
      }

      await emitMetadataChange({
        photos: [...updates.values()],
        getEditState: (id) => catalogStorage().getEditState(id).then((e) => e ?? null),
      });
      // putPhotos waited for each turned preview to be stored, so the other windows
      // can reload them now; this one already holds them and ignores its echo.
      for (const id of updates.keys()) announce("update", id);
    },

    async setStack(ids, opts) {
      const members = [...new Set(ids)].filter((id) => get().photos.some((p) => p.id === id));
      if (members.length < 2) return;
      const stackId = crypto.randomUUID();
      const cover = opts?.cover !== undefined && members.includes(opts.cover) ? opts.cover : members[0];
      await commit(members, (p) => {
        const { stackCover: _cover, ...rest } = p;
        return cover === p.id ? { ...rest, stackId, stackCover: true } : { ...rest, stackId };
      });
    },
    clearStack: (ids) =>
      commit(ids, (p) => {
        if (p.stackId === undefined && p.stackCover === undefined) return p;
        const { stackId: _id, stackCover: _cover, ...rest } = p;
        return rest;
      }),

    setRating: (id, rating) => commit([id], (p) => ({ ...p, rating })),
    setColorLabel: (id, colorLabel) =>
      commit([id], (p) => ({ ...p, colorLabel })),
    setFlag: (id, flag) => commit([id], (p) => ({ ...p, flag })),

    applyRating: (ids, rating) => commit(ids, (p) => ({ ...p, rating })),
    applyColorLabel: (ids, label) =>
      commit(ids, (p) => ({ ...p, colorLabel: label })),
    applyFlag: (ids, flag) => commit(ids, (p) => ({ ...p, flag })),

    addKeyword: (id, keyword) =>
      commit([id], (p) => ({
        ...p,
        keywords: p.keywords.includes(keyword) ? p.keywords : [...p.keywords, keyword],
      })),
    removeKeyword: (id, keyword) =>
      commit([id], (p) => ({
        ...p,
        keywords: p.keywords.filter((k) => k !== keyword),
      })),
    addKeywords: (ids, keywords) =>
      commit(ids, (p) => {
        const existing = new Set(p.keywords);
        const toAdd = keywords.filter((k) => !existing.has(k));
        return toAdd.length > 0 ? { ...p, keywords: [...p.keywords, ...toAdd] } : p;
      }),
    removeKeywords: (ids, keywords) => {
      const remove = new Set(keywords);
      return commit(ids, (p) => ({
        ...p,
        keywords: p.keywords.filter((k) => !remove.has(k)),
      }));
    },

    select(id) {
      set({ selectedIds: new Set([id]), activePhotoId: id });
      broadcast({ type: "selection-change", payload: { activePhotoId: id } });
    },

    selectRange(id, orderedIds) {
      const { photos, activePhotoId, selectedIds } = get();
      if (!activePhotoId) {
        set({ selectedIds: new Set([id]), activePhotoId: id });
        return;
      }
      // Range over the order the user actually sees (filtered + sorted), falling
      // back to catalogue order when the caller doesn't supply it.
      const order = orderedIds ?? photos.map((p) => p.id);
      const startIdx = order.indexOf(activePhotoId);
      const endIdx = order.indexOf(id);
      if (startIdx === -1 || endIdx === -1) return;
      const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      const next = new Set(selectedIds);
      for (const rid of order.slice(lo, hi + 1)) next.add(rid);
      set({ selectedIds: next });
    },

    toggleSelect(id) {
      const { selectedIds, activePhotoId } = get();
      const next = new Set(selectedIds);
      let active: string | null;
      if (next.has(id)) {
        // Deselect. Don't leave the active highlight on a removed photo: move it
        // to another still-selected photo, or clear it.
        next.delete(id);
        active =
          activePhotoId === id
            ? next.size > 0
              ? [...next][next.size - 1]
              : null
            : activePhotoId;
      } else {
        next.add(id);
        active = id;
      }
      set({ selectedIds: next, activePhotoId: active });
      if (active) {
        broadcast({
          type: "selection-change",
          payload: { activePhotoId: active },
        });
      }
    },

    selectAll(ids) {
      set((s) => ({
        selectedIds: new Set(ids ?? s.photos.map((p) => p.id)),
      }));
    },

    deselectAll() {
      set({ selectedIds: new Set(), activePhotoId: null });
    },

    setActivePhoto(id, options) {
      if (get().activePhotoId === id) return; // avoids cross-window echo loops
      set({ activePhotoId: id });
      // A change received FROM another window must not be re-broadcast: the
      // original broadcast already reached every window directly, and echoing it
      // lets two windows ping-pong between interleaved ids forever (rapid clicks
      // arriving across the async channel never match the same-value guard above).
      if (id && options?.broadcast !== false) {
        broadcast({ type: "selection-change", payload: { activePhotoId: id } });
      }
    },
  };
});
