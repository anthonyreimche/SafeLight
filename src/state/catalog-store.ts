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
  type StoredPhoto,
} from "@/catalog/types";
import { catalogStorage } from "@/catalog/storage";
import { rotateBlob, normalizeRotation } from "@/catalog/orient";
import { useProjectStore } from "@/project/project-store";
import { broadcast, WINDOW_ID } from "./broadcast";
import type { LoadedPreview } from "./thumbnail-loader";
import { emitMetadataChange, emitPhotoRemove } from "@/extensions/registry";

/** What a background rebuild of a photo changed (see mergeRebuiltPhoto): an
 *  edited or repaired preview with its size, rotation and the edit it shows, or a
 *  re-import's file details. */
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
  /** Add new photo records to the catalog and DURABLY persist them (unlike
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
   *  (previewEdit) with it. */
  mergeThumbnails: (updates: { id: string; blob: LoadedPreview }[]) => void;
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
  /** Take on what another window wrote to the catalog (see state/catalog-sync):
   *  each photo here gets the stored fields of its record in `photos` and keeps
   *  its own handles, preview, URL and the edit that preview shows (previewEdit),
   *  and the photos in `deletedIds` leave the catalog and the selection. Ids this
   *  window doesn't have are ignored. Nothing is stored or broadcast: this
   *  window's storage already holds the records. */
  mergeRemoteRecords: (photos: StoredPhoto[], deletedIds: string[]) => void;
  /** Replace the skeleton catalog with the post-scan list: attach live handles,
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
   *  none are supplied — every photo in the catalog. */
  selectAll: (ids?: string[]) => void;
  deselectAll: () => void;
  setActivePhoto: (id: string | null, options?: { broadcast?: boolean }) => void;
}

export const useCatalogStore = create<CatalogState>((set, get) => {
  // Tell the windows (this one's own listeners included) the catalog changed. The
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
    const updated = get().photos.filter((p) => idSet.has(p.id)).map(mutate);
    if (updated.length === 0) return;
    await catalogStorage().putPhotos(updated);
    await emitMetadataChange({
      photos: updated,
      getEditState: (id) => catalogStorage().getEditState(id).then((e) => e ?? null),
    });
    // Another window's records may have landed during the awaits: change the
    // photos as they are now, not the copies read before them.
    set((s) => ({ photos: s.photos.map((p) => (idSet.has(p.id) ? mutate(p) : p)) }));
    // Metadata leaves every preview as it is: no photo is named. The other
    // windows get the records through catalog-records.
    announce("update");
  };

  // Swap in one photo's record, revoking the preview URL it supersedes. Naming the
  // photo makes other windows reload its preview from disk (see use-window-sync)
  // while this window, which already holds the new blob, ignores its own echo.
  const swapPhoto = (id: string, next: (p: CatalogPhoto) => CatalogPhoto): void => {
    set((s) => ({
      photos: s.photos.map((p) => {
        if (p.id !== id) return p;
        const swapped = next(p);
        if (p.thumbnailUrl && p.thumbnailUrl !== swapped.thumbnailUrl) {
          URL.revokeObjectURL(p.thumbnailUrl);
        }
        return swapped;
      }),
    }));
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
        await useProjectStore.getState().openLast();
      } finally {
        set({ loading: false });
      }
    },

    async reconnectFiles() {
      if (get().reconnecting) return;
      set({ reconnecting: true });
      try {
        const ok = await useProjectStore.getState().reconnectLast();
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
        if (p.thumbnailUrl) URL.revokeObjectURL(p.thumbnailUrl);
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
      if (updates.length === 0) return;
      const byId = new Map(updates.map((u) => [u.id, u.blob] as const));
      set((s) => ({
        photos: s.photos.map((p) => {
          const blob = byId.get(p.id);
          // Skip if no blob for this photo, or it already has a preview (avoids
          // leaking an object URL by overwriting a live one).
          if (!blob || p.thumbnailUrl) return p;
          return withPreview(p, blob);
        }),
      }));
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
        photos: s.photos.map((p) => {
          if (p.id !== id) return p;
          if (p.thumbnailUrl) URL.revokeObjectURL(p.thumbnailUrl);
          return withPreview(p, blob);
        }),
      }));
    },

    mergeRemoteRecords(photos, deletedIds) {
      const byId = new Map(photos.map((p) => [p.id, p] as const));
      const gone = new Set(deletedIds);
      const current = get().photos;
      if (!current.some((p) => byId.has(p.id) || gone.has(p.id))) return;
      // Previews of removed photos would dangle for the life of the window.
      for (const p of current) {
        if (gone.has(p.id) && p.thumbnailUrl) URL.revokeObjectURL(p.thumbnailUrl);
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
        if (!keep.has(p.id) && p.thumbnailUrl) URL.revokeObjectURL(p.thumbnailUrl);
      }
      set((s) => {
        const selectedIds = new Set([...s.selectedIds].filter((id) => keep.has(id)));
        return {
          photos: merged,
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
      // Let extensions react to removal (e.g. delete XMP sidecars).
      for (const id of ids) {
        const photo = get().photos.find((p) => p.id === id);
        if (photo?.directoryHandle && photo?.fileHandle) {
          await emitPhotoRemove({
            photo,
            dir: photo.directoryHandle,
            fileName: photo.fileHandle.name,
          });
        }
      }
      for (const id of ids) {
        if (catalogStorage() !== storage) return;
        await storage.deletePhoto(id);
      }
      if (catalogStorage() !== storage) return;
      // Previews of removed photos would dangle for the life of the window.
      for (const p of get().photos) {
        if (idSet.has(p.id) && p.thumbnailUrl) URL.revokeObjectURL(p.thumbnailUrl);
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
      const idSet = new Set(ids);
      const swap = d === 90 || d === 270;
      const turnBlob = (blob: Blob | null) => (blob ? rotateBlob(blob, d) : Promise.resolve(null));
      const updates = new Map<string, CatalogPhoto>();

      await Promise.all(
        get()
          .photos.filter((p) => idSet.has(p.id))
          .map(async (p) => {
            // The photo may have changed, or left the catalog, while its preview
            // turned: turn it as it is now, and only if it's still here. A preview
            // stored meanwhile (an edit's) is turned in place of the one it began
            // with, and the turn keeps the edit its source shows.
            let from = p;
            let turned = await turnBlob(from.thumbnailBlob);
            let current = get().photos.find((photo) => photo.id === p.id);
            while (current && current.thumbnailBlob !== from.thumbnailBlob) {
              from = current;
              turned = await turnBlob(from.thumbnailBlob);
              current = get().photos.find((photo) => photo.id === p.id);
            }
            if (!current) return;
            const turn = {
              rotation: normalizeRotation((current.rotation ?? 0) + d),
              width: swap ? current.height : current.width,
              height: swap ? current.width : current.height,
              thumbnailBlob: turned ?? current.thumbnailBlob,
              thumbnailUrl: turned ? URL.createObjectURL(turned) : current.thumbnailUrl,
              previewEdit: from.previewEdit,
            };
            // Shown before it is written, onto the photo as it is now: an edit's
            // preview rendered from here on is made at the new rotation, and one
            // stored later replaces this one.
            set((s) => ({
              photos: s.photos.map((photo) => (photo.id === p.id ? { ...photo, ...turn } : photo)),
            }));
            if (current.thumbnailUrl && current.thumbnailUrl !== turn.thumbnailUrl)
              URL.revokeObjectURL(current.thumbnailUrl);
            const updated: CatalogPhoto = { ...current, ...turn };
            await catalogStorage().putPhoto(updated);
            updates.set(p.id, updated);
          }),
      );

      await emitMetadataChange({
        photos: [...updates.values()],
        getEditState: (id) => catalogStorage().getEditState(id).then((e) => e ?? null),
      });
      // putPhoto waited for each turned preview to be stored, so the other windows
      // can reload them now; this one already holds them and ignores its echo.
      for (const id of updates.keys()) announce("update", id);
    },

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
      // back to catalog order when the caller doesn't supply it.
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
