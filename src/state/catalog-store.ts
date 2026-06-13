import { create } from "zustand";
import type { CatalogPhoto, ColorLabel, FlagStatus } from "@/catalog/types";
import { catalogStorage } from "@/catalog/storage";
import { rotateBlob, normalizeRotation } from "@/catalog/orient";
import { useProjectStore } from "@/project/project-store";
import { broadcast } from "./broadcast";
import { useEditedThumbs } from "./edited-thumbnails";

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
  /** Finalize a progressive open: set authoritative list without revoking URLs
   *  (photos are the same object references already shown during the open). */
  finalizeCatalog: (photos: CatalogPhoto[]) => void;

  removePhoto: (id: string) => Promise<void>;
  removePhotos: (ids: string[]) => Promise<void>;
  /** Persist already-built photo records whose location changed (moved on disk).
   *  Caller supplies updated relPath/folder/handles; thumbnails are unchanged. */
  relocatePhotos: (updated: CatalogPhoto[]) => Promise<void>;

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
    const byId = new Map(updated.map((p) => [p.id, p] as const));
    set((s) => ({ photos: s.photos.map((p) => byId.get(p.id) ?? p) }));
    broadcast({
      type: "catalog-change",
      payload: { action: "update", id: ids.length === 1 ? ids[0] : undefined },
    });
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
      broadcast({ type: "catalog-change", payload: { action: "add" } });
    },

    appendPhotos(photos) {
      set((s) => ({ photos: [...s.photos, ...photos] }));
    },

    finalizeCatalog(photos) {
      // Same photo objects as those already appended — don't revoke their URLs.
      set({
        photos,
        selectedIds: new Set(),
        activePhotoId: null,
        needsReconnect: false,
      });
      broadcast({ type: "catalog-change", payload: { action: "add" } });
    },

    async removePhoto(id) {
      await catalogStorage().deletePhoto(id);
      useEditedThumbs.getState().drop(id);
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
      for (const id of ids) {
        await catalogStorage().deletePhoto(id);
        useEditedThumbs.getState().drop(id);
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
      broadcast({ type: "catalog-change", payload: { action: "remove" } });
    },

    async relocatePhotos(updated) {
      if (updated.length === 0) return;
      await catalogStorage().putPhotos(updated);
      const byId = new Map(updated.map((p) => [p.id, p] as const));
      set((s) => ({ photos: s.photos.map((p) => byId.get(p.id) ?? p) }));
      broadcast({ type: "catalog-change", payload: { action: "update" } });
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
            await catalogStorage().putPhoto(updated);
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
