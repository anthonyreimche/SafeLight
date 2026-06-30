// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { create } from "zustand";
import type { CatalogPhoto, ColorLabel, FlagStatus } from "@/catalog/types";
import { catalogStorage } from "@/catalog/storage";
import { rotateBlob, normalizeRotation } from "@/catalog/orient";
import { useProjectStore } from "@/project/project-store";
import { broadcast, WINDOW_ID } from "./broadcast";
import { emitMetadataChange, emitPhotoRemove } from "@/extensions/registry";

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
   *  are left untouched. */
  mergeThumbnails: (updates: { id: string; blob: Blob }[]) => void;
  /** Replace one photo record in place (same id) after its preview was rebuilt
   *  in the background. Revokes the old object URL. Persistence is the caller's
   *  job (the repair pass already wrote it via putPhoto). */
  updatePhoto: (photo: CatalogPhoto) => void;
  /** Replace one photo's preview blob in place (revoking the old URL), e.g. after
   *  another window edited it and we reloaded its <id>.jpg from disk. */
  replaceThumbnail: (id: string, blob: Blob) => void;
  /** Replace the skeleton catalog with the post-scan list: attach live handles,
   *  add newly-found photos, drop vanished ones — while keeping any previews that
   *  already loaded during the skeleton phase. */
  reconcileCatalog: (photos: CatalogPhoto[]) => void;

  removePhoto: (id: string) => Promise<void>;
  removePhotos: (ids: string[]) => Promise<void>;
  /** Persist already-built photo records whose location changed (moved on disk).
   *  Caller supplies updated relPath/folder/handles; thumbnails are unchanged. */
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
      broadcast({ type: "catalog-change", payload: { action: "add" } });
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
          return {
            ...p,
            thumbnailBlob: blob,
            thumbnailUrl: URL.createObjectURL(blob),
          };
        }),
      }));
    },

    updatePhoto(photo) {
      set((s) => ({
        photos: s.photos.map((p) => {
          if (p.id !== photo.id) return p;
          if (p.thumbnailUrl && p.thumbnailUrl !== photo.thumbnailUrl) {
            URL.revokeObjectURL(p.thumbnailUrl);
          }
          return photo;
        }),
      }));
      // Stamp the origin so other windows reload this photo's preview from disk
      // (see use-window-sync) while this window — which already holds the new
      // blob — ignores its own echo.
      broadcast({ type: "catalog-change", payload: { action: "update", id: photo.id, origin: WINDOW_ID } });
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
          return { ...p, thumbnailBlob: blob, thumbnailUrl: URL.createObjectURL(blob) };
        }),
      }));
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
      broadcast({ type: "catalog-change", payload: { action: "add" } });
    },

    async removePhoto(id) {
      // Removing a master takes its virtual copies with it; fall through to the
      // batch path so each is torn down (and announced) properly.
      const expanded = withVirtualCopies(get().photos, [id]);
      if (expanded.length > 1) {
        await get().removePhotos(expanded);
        return;
      }
      const photo = get().photos.find((p) => p.id === id);
      if (photo?.directoryHandle && photo?.fileHandle) {
        await emitPhotoRemove({
          photo,
          dir: photo.directoryHandle,
          fileName: photo.fileHandle.name,
        });
      }
      await catalogStorage().deletePhoto(id);
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
      // Removing a master also removes its virtual copies.
      ids = withVirtualCopies(get().photos, ids);
      const idSet = new Set(ids);
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
        await catalogStorage().deletePhoto(id);
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

    async setCopyName(id, copyName) {
      const photo = get().photos.find((p) => p.id === id);
      if (!photo) return;
      const clean = copyName.trim();
      const updated: CatalogPhoto = { ...photo, copyName: clean || undefined };
      await catalogStorage().putPhotos([updated]);
      set((s) => ({ photos: s.photos.map((p) => (p.id === id ? updated : p)) }));
      broadcast({ type: "catalog-change", payload: { action: "update", id } });
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
