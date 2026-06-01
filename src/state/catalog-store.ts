import { create } from "zustand";
import type {
  CatalogPhoto,
  Collection,
  ColorLabel,
  FlagStatus,
} from "@/catalog/types";
import { catalogDB } from "@/catalog/db";
import { rotateBlob, normalizeRotation } from "@/catalog/orient";
import { verifyPermission } from "@/catalog/permissions";
import { broadcast } from "./broadcast";

// Recreate a fresh object URL from the persisted thumbnail blob. Used on load
// because blob: URLs from a previous session are no longer valid.
function hydrateThumbnailUrl(photo: CatalogPhoto): CatalogPhoto {
  return {
    ...photo,
    thumbnailUrl: photo.thumbnailBlob
      ? URL.createObjectURL(photo.thumbnailBlob)
      : null,
  };
}

interface CatalogState {
  photos: CatalogPhoto[];
  collections: Collection[];
  selectedIds: Set<string>;
  activePhotoId: string | null;
  loading: boolean;
  fileAccessNonce: number; // bumped after re-granting permission, to reload bitmaps
  needsReconnect: boolean; // stored originals need a permission re-grant
  reconnecting: boolean; // a permission re-grant is in progress

  loadCatalog: () => Promise<void>;
  reconnectFiles: () => Promise<void>;

  addPhotos: (photos: CatalogPhoto[]) => Promise<void>;
  removePhoto: (id: string) => Promise<void>;
  removePhotos: (ids: string[]) => Promise<void>;
  addCollection: (name: string, photoIds: string[]) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  addToCollection: (id: string, photoIds: string[]) => Promise<void>;
  removeFromCollection: (id: string, photoIds: string[]) => Promise<void>;

  setRating: (id: string, rating: number) => Promise<void>;
  setColorLabel: (id: string, label: ColorLabel) => Promise<void>;
  setFlag: (id: string, flag: FlagStatus) => Promise<void>;

  // Batch variants for culling a whole multi-selection in one transaction.
  applyRating: (ids: string[], rating: number) => Promise<void>;
  applyColorLabel: (ids: string[], label: ColorLabel) => Promise<void>;
  applyFlag: (ids: string[], flag: FlagStatus) => Promise<void>;
  rotatePhotos: (ids: string[], deg: number) => Promise<void>;

  select: (id: string) => void;
  selectRange: (id: string, orderedIds?: string[]) => void;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  deselectAll: () => void;
  setActivePhoto: (id: string | null) => void;
}

export const useCatalogStore = create<CatalogState>((set, get) => {
  // Apply a field change to many photos at once: one IndexedDB write, one state
  // update, one broadcast. The single-photo setters delegate here as well.
  const commit = async (
    ids: string[],
    mutate: (p: CatalogPhoto) => CatalogPhoto,
  ): Promise<void> => {
    const idSet = new Set(ids);
    const updated = get().photos.filter((p) => idSet.has(p.id)).map(mutate);
    if (updated.length === 0) return;
    await catalogDB.putPhotos(updated);
    const byId = new Map(updated.map((p) => [p.id, p] as const));
    set((s) => ({ photos: s.photos.map((p) => byId.get(p.id) ?? p) }));
    broadcast({
      type: "catalog-change",
      payload: { action: "update", id: ids.length === 1 ? ids[0] : undefined },
    });
  };

  return {
    photos: [],
    collections: [],
    selectedIds: new Set(),
    activePhotoId: null,
    loading: false,
    fileAccessNonce: 0,
    needsReconnect: false,
    reconnecting: false,

    async loadCatalog() {
      set({ loading: true });
      const [stored, collections] = await Promise.all([
        catalogDB.getAllPhotos(),
        catalogDB.getAllCollections(),
      ]);
      // Object URLs don't survive across sessions, so the persisted thumbnailUrl
      // is dangling. Recreate it from the stored blob.
      const photos = stored.map(hydrateThumbnailUrl);
      set({ photos, collections, loading: false });

      // Handles persist but their read permission resets per session. If a
      // file-backed photo isn't currently readable, prompt for a reconnect so
      // Develop/Loupe/Export can use the originals instead of the thumbnail.
      const backed = photos.find((p) => p.directoryHandle || p.fileHandle);
      const handle = backed?.directoryHandle ?? backed?.fileHandle;
      if (handle && !(await verifyPermission(handle))) {
        set({ needsReconnect: true });
      }
    },

    async reconnectFiles() {
      // Re-request read access to the stored originals. Must run within a user
      // gesture; one grant per directory typically covers all of its photos.
      if (get().reconnecting) return;
      set({ reconnecting: true });
      try {
        let anyGranted = false;
        for (const p of get().photos) {
          const handle = p.directoryHandle ?? p.fileHandle;
          if (!handle) continue;
          if (await verifyPermission(handle)) {
            anyGranted = true;
          } else if (await verifyPermission(handle, true)) {
            anyGranted = true;
          }
        }
        set((s) => ({
          needsReconnect: !anyGranted,
          fileAccessNonce: s.fileAccessNonce + 1,
        }));
      } finally {
        set({ reconnecting: false });
      }
    },

    async addPhotos(newPhotos) {
      await catalogDB.putPhotos(newPhotos);
      set((s) => ({ photos: [...s.photos, ...newPhotos] }));
      broadcast({ type: "catalog-change", payload: { action: "add" } });
    },

    async removePhoto(id) {
      await catalogDB.deletePhoto(id);
      set((s) => ({
        photos: s.photos.filter((p) => p.id !== id),
        selectedIds: (() => {
          const next = new Set(s.selectedIds);
          next.delete(id);
          return next;
        })(),
        activePhotoId: s.activePhotoId === id ? null : s.activePhotoId,
      }));
      broadcast({ type: "catalog-change", payload: { action: "remove", id } });
    },

    async removePhotos(ids) {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      for (const id of ids) await catalogDB.deletePhoto(id);

      // Drop the removed photos from any collections that held them.
      const prev = get().collections;
      const collections = prev.map((c) => {
        const photoIds = c.photoIds.filter((pid) => !idSet.has(pid));
        return photoIds.length === c.photoIds.length ? c : { ...c, photoIds };
      });
      await Promise.all(
        collections
          .filter((c, i) => c !== prev[i])
          .map((c) => catalogDB.putCollection(c)),
      );

      set((s) => {
        const selectedIds = new Set(s.selectedIds);
        for (const id of ids) selectedIds.delete(id);
        return {
          photos: s.photos.filter((p) => !idSet.has(p.id)),
          collections,
          selectedIds,
          activePhotoId:
            s.activePhotoId && idSet.has(s.activePhotoId)
              ? null
              : s.activePhotoId,
        };
      });
      broadcast({ type: "catalog-change", payload: { action: "remove" } });
    },

    async addCollection(name, photoIds) {
      const collection: Collection = {
        id: crypto.randomUUID(),
        name,
        type: "regular",
        photoIds: [...photoIds],
        dateCreated: Date.now(),
      };
      await catalogDB.putCollection(collection);
      set((s) => ({ collections: [...s.collections, collection] }));
      broadcast({ type: "catalog-change", payload: { action: "collection" } });
    },

    async deleteCollection(id) {
      await catalogDB.deleteCollection(id);
      set((s) => ({
        collections: s.collections.filter((c) => c.id !== id),
      }));
      broadcast({ type: "catalog-change", payload: { action: "collection" } });
    },

    async addToCollection(id, photoIds) {
      const coll = get().collections.find((c) => c.id === id);
      if (!coll) return;
      const updated: Collection = {
        ...coll,
        photoIds: Array.from(new Set([...coll.photoIds, ...photoIds])),
      };
      await catalogDB.putCollection(updated);
      set((s) => ({
        collections: s.collections.map((c) => (c.id === id ? updated : c)),
      }));
      broadcast({ type: "catalog-change", payload: { action: "collection" } });
    },

    async removeFromCollection(id, photoIds) {
      const coll = get().collections.find((c) => c.id === id);
      if (!coll) return;
      const idSet = new Set(photoIds);
      const updated: Collection = {
        ...coll,
        photoIds: coll.photoIds.filter((pid) => !idSet.has(pid)),
      };
      await catalogDB.putCollection(updated);
      set((s) => ({
        collections: s.collections.map((c) => (c.id === id ? updated : c)),
      }));
      broadcast({ type: "catalog-change", payload: { action: "collection" } });
    },

    async rotatePhotos(ids, deg) {
      const d = normalizeRotation(deg);
      if (d === 0 || ids.length === 0) return;
      const idSet = new Set(ids);
      const swap = d === 90 || d === 270;
      const updates = new Map<string, CatalogPhoto>();

      await Promise.all(
        get()
          .photos.filter((p) => idSet.has(p.id))
          .map(async (p) => {
            const thumbnailBlob = p.thumbnailBlob
              ? await rotateBlob(p.thumbnailBlob, d)
              : p.thumbnailBlob;
            const thumbnailUrl = thumbnailBlob
              ? URL.createObjectURL(thumbnailBlob)
              : p.thumbnailUrl;
            const updated: CatalogPhoto = {
              ...p,
              rotation: normalizeRotation((p.rotation ?? 0) + d),
              thumbnailBlob,
              thumbnailUrl,
              width: swap ? p.height : p.width,
              height: swap ? p.width : p.height,
            };
            await catalogDB.putPhoto(updated);
            if (p.thumbnailUrl && p.thumbnailUrl !== thumbnailUrl) {
              URL.revokeObjectURL(p.thumbnailUrl);
            }
            updates.set(p.id, updated);
          }),
      );

      set((s) => ({ photos: s.photos.map((p) => updates.get(p.id) ?? p) }));
      broadcast({ type: "catalog-change", payload: { action: "rotate" } });
    },

    setRating: (id, rating) => commit([id], (p) => ({ ...p, rating })),
    setColorLabel: (id, colorLabel) =>
      commit([id], (p) => ({ ...p, colorLabel })),
    setFlag: (id, flag) => commit([id], (p) => ({ ...p, flag })),

    applyRating: (ids, rating) => commit(ids, (p) => ({ ...p, rating })),
    applyColorLabel: (ids, label) =>
      commit(ids, (p) => ({ ...p, colorLabel: label })),
    applyFlag: (ids, flag) => commit(ids, (p) => ({ ...p, flag })),

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

    selectAll() {
      set((s) => ({
        selectedIds: new Set(s.photos.map((p) => p.id)),
      }));
    },

    deselectAll() {
      set({ selectedIds: new Set(), activePhotoId: null });
    },

    setActivePhoto(id) {
      if (get().activePhotoId === id) return; // avoids cross-window echo loops
      set({ activePhotoId: id });
      if (id) {
        broadcast({ type: "selection-change", payload: { activePhotoId: id } });
      }
    },
  };
});
