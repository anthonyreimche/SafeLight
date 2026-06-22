// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// ProjectStorage: the catalog lives inside the project folder.
//
//   <project>/.safelight/catalog.json   photo records + edit histories
//   <project>/.safelight/previews/      <photoId>.jpg grid thumbnails
//   <project>/.safelight/raw/           decoded-RAW develop cache
//
// Opening a project reconciles catalog.json against a fresh disk scan: new
// files get decoded + thumbnailed, records whose file vanished are dropped,
// and everything else keeps its ratings/edits. Saves are debounced whole-file
// JSON writes (handles and blobs are never serialized).

import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { CatalogStorage } from "@/catalog/storage";
import { buildPhoto, buildPreviewBlob } from "@/modules/library/import-photos";
import { getSettings } from "@/state/settings-store";
import { mapLimit, readBlob, readJSON, removeEntry, writeBlob, writeJSON } from "./fs";
import { scanProject, type FolderNode, type ScannedFile } from "./scan";
import { emitPhotoImport } from "@/extensions/registry";

type StoredPhoto = Omit<
  CatalogPhoto,
  "directoryHandle" | "fileHandle" | "thumbnailBlob" | "thumbnailUrl"
>;

interface CatalogFile {
  version: 1;
  photos: StoredPhoto[];
  edits: EditState[];
}

const SAVE_DELAY = 800;
// Hard cap so a steady stream of writes (e.g. a long import) still flushes
// periodically instead of the debounce sliding forever and persisting nothing.
const MAX_SAVE_DELAY = 2500;

function strip(p: CatalogPhoto): StoredPhoto {
  const {
    directoryHandle: _d,
    fileHandle: _f,
    thumbnailBlob: _b,
    thumbnailUrl: _u,
    ...rest
  } = p;
  return rest;
}

function folderOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

// Sidecar written by folder-ops.exportPhotoData; kept in sync there. Inlined
// (not imported) to avoid a project-storage ↔ folder-ops ↔ project-store cycle.
const SIDECAR_SUFFIX = ".safelight.json";

interface PhotoSidecar {
  safelightSidecar?: number;
  info?: {
    rating?: number;
    colorLabel?: CatalogPhoto["colorLabel"];
    flag?: CatalogPhoto["flag"];
    keywords?: string[];
  };
  maps?: { stack: EditState["stack"]; currentIndex: number } | null;
}

export interface OpenedProject {
  storage: ProjectStorage;
  tree: FolderNode;
  photos: CatalogPhoto[];
  /** Photos discovered on this open (candidates for background pre-decode). */
  newPhotos: CatalogPhoto[];
  rawCacheDir: FileSystemDirectoryHandle;
}

export class ProjectStorage implements CatalogStorage {
  private photos = new Map<string, CatalogPhoto>();
  private edits = new Map<string, EditState>();
  private lastThumb = new Map<string, Blob | null>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;

  private sl: FileSystemDirectoryHandle;
  private previews: FileSystemDirectoryHandle;

  private constructor(
    sl: FileSystemDirectoryHandle,
    previews: FileSystemDirectoryHandle,
  ) {
    this.sl = sl;
    this.previews = previews;
  }

  static async open(
    root: FileSystemDirectoryHandle,
    onPhoto?: (photo: CatalogPhoto) => void,
    onSkeletons?: (
      storage: ProjectStorage,
      rawCacheDir: FileSystemDirectoryHandle,
      skeletons: CatalogPhoto[],
    ) => void,
    // Progress of decoding newly-discovered files (the slow part of opening).
    // Fires once with done=0 when the new-file count is known, then per file.
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<OpenedProject> {
    const sl = await root.getDirectoryHandle(".safelight", { create: true });
    const previews = await sl.getDirectoryHandle("previews", { create: true });
    const rawCacheDir = await sl.getDirectoryHandle("raw", { create: true });
    const storage = new ProjectStorage(sl, previews);

    // Read the saved catalog first (one quick read) and paint the grid from it
    // immediately as skeleton records — no live handles, no previews — so the UI
    // appears at once. The directory scan below then runs without blocking the
    // first paint, attaching handles and finding new/removed files.
    const saved = await readJSON<CatalogFile>(sl, "catalog.json");

    // Seed saved edit histories up front so incremental saves during a long
    // (resumable) import keep develop edits; orphans are pruned after the walk.
    for (const e of saved?.edits ?? []) storage.edits.set(e.photoId, e);

    const savedPhotos = saved?.photos ?? [];
    if (savedPhotos.length > 0 && onSkeletons) {
      const skeletons = savedPhotos.map(
        (s): CatalogPhoto => ({
          ...s,
          directoryHandle: null,
          fileHandle: null,
          thumbnailBlob: null,
          thumbnailUrl: null,
        }),
      );
      for (const sk of skeletons) storage.photos.set(sk.id, sk);
      onSkeletons(storage, rawCacheDir, skeletons);
    }

    const scan = await scanProject(root);
    const byRel = new Map(savedPhotos.map((p) => [p.relPath, p] as const));

    // New files (not in the saved catalog) are the ones that get decoded —
    // the slow part of opening. Report progress against that count.
    const newTotal = scan.files.reduce((n, f) => n + (byRel.has(f.path) ? 0 : 1), 0);
    let newDone = 0;
    onProgress?.(0, newTotal);

    const newPhotos: CatalogPhoto[] = [];
    const results = await mapLimit(scan.files, 8, async (f: ScannedFile) => {
      const prev = byRel.get(f.path);
      if (prev) {
        // Known photo: reattach live handles only. The cached preview is loaded
        // later, on demand (visible cells first), so the open never blocks on
        // hundreds of serial preview reads.
        const photo: CatalogPhoto = {
          ...prev,
          folder: folderOf(f.path),
          directoryHandle: f.parent,
          fileHandle: f.handle,
          thumbnailBlob: null,
          thumbnailUrl: null,
        };
        storage.photos.set(photo.id, photo);
        return photo;
      }
      // New file: decode, thumbnail, cache the preview on disk.
      if (signal?.aborted) {
        onProgress?.(++newDone, newTotal);
        return null;
      }
      try {
        const file = await f.handle.getFile();
        const built = await buildPhoto(file, f.parent, f.handle);
        if (!built) return null;
        let photo: CatalogPhoto = {
          ...built,
          relPath: f.path,
          folder: folderOf(f.path),
        };
        // Adopt a sidecar (ratings/labels + develop maps) that travelled with
        // the file from another project, so the data follows the photo.
        try {
          const sc = await readJSON<PhotoSidecar>(
            f.parent,
            `${f.handle.name}${SIDECAR_SUFFIX}`,
          );
          if (sc && sc.safelightSidecar === 1) {
            const info = sc.info ?? {};
            if (typeof info.rating === "number") photo.rating = info.rating;
            if (info.colorLabel) photo.colorLabel = info.colorLabel;
            if (info.flag) photo.flag = info.flag;
            if (Array.isArray(info.keywords)) photo.keywords = info.keywords;
            if (sc.maps && Array.isArray(sc.maps.stack)) {
              storage.edits.set(photo.id, {
                photoId: photo.id,
                stack: sc.maps.stack,
                currentIndex:
                  typeof sc.maps.currentIndex === "number"
                    ? sc.maps.currentIndex
                    : sc.maps.stack.length - 1,
              });
            }
          }
        } catch {
          /* no/!invalid sidecar — ignore */
        }

        // Let extensions contribute metadata read from sidecars. Their values
        // take precedence over the SafeLight sidecar.
        try {
          const ov = await emitPhotoImport({
            photo,
            dir: f.parent,
            fileName: f.handle.name,
          });
          if (ov) photo = { ...photo, ...ov };
        } catch {
          /* extension import failed — ignore */
        }
        if (photo.thumbnailBlob && getSettings().persistPreviews)
          await writeBlob(previews, `${photo.id}.jpg`, photo.thumbnailBlob);
        storage.lastThumb.set(photo.id, photo.thumbnailBlob);
        storage.photos.set(photo.id, photo);
        newPhotos.push(photo);
        onPhoto?.(photo);
        // Persist progress as we go: an interrupted import resumes from the last
        // saved photo instead of re-decoding the whole folder next launch.
        storage.scheduleSave();
        onProgress?.(++newDone, newTotal);
        return photo;
      } catch (err) {
        console.warn(`[import] skipped ${f.path}:`, err);
        onProgress?.(++newDone, newTotal);
        return null;
      }
    });

    const photos = results.filter((p): p is CatalogPhoto => p !== null);
    // Rebuild the photo map from the scan result so any skeletons seeded above
    // for files that have since vanished from disk are dropped.
    storage.photos.clear();
    for (const p of photos) storage.photos.set(p.id, p);

    // Drop edit histories whose photo no longer exists on disk.
    for (const id of [...storage.edits.keys()])
      if (!storage.photos.has(id)) storage.edits.delete(id);

    const removedCount = byRel.size - (photos.length - newPhotos.length);
    if (newPhotos.length > 0 || removedCount > 0) storage.scheduleSave();

    return { storage, tree: scan.tree, photos, newPhotos, rawCacheDir };
  }

  // ── CatalogStorage ─────────────────────────────────────────────────────────

  async getAllPhotos(): Promise<CatalogPhoto[]> {
    return [...this.photos.values()];
  }

  /** Read a photo's grid preview for the block thumbnail loader. Normally reads
   *  the cached <id>.jpg from disk (and caches the blob so a later putPhoto won't
   *  needlessly rewrite it). When "Store previews on disk" is off — or the disk
   *  copy is missing — it rebuilds the preview from the source file on demand. */
  async readPreview(id: string): Promise<Blob | null> {
    if (getSettings().persistPreviews) {
      const blob = await readBlob(this.previews, `${id}.jpg`);
      if (blob) {
        this.lastThumb.set(id, blob);
        return blob;
      }
    }
    const photo = this.photos.get(id);
    if (photo) {
      const blob = await buildPreviewBlob(photo);
      if (blob) {
        this.lastThumb.set(id, blob);
        return blob;
      }
    }
    return null;
  }

  async putPhoto(photo: CatalogPhoto): Promise<void> {
    this.photos.set(photo.id, photo);
    // Persist the thumbnail only when it actually changed (e.g. rotation), and
    // only when previews are kept on disk.
    if (photo.thumbnailBlob && this.lastThumb.get(photo.id) !== photo.thumbnailBlob) {
      this.lastThumb.set(photo.id, photo.thumbnailBlob);
      if (getSettings().persistPreviews)
        await writeBlob(this.previews, `${photo.id}.jpg`, photo.thumbnailBlob);
    }
    this.scheduleSave();
  }

  async putPhotos(photos: CatalogPhoto[]): Promise<void> {
    for (const p of photos) await this.putPhoto(p);
  }

  async deletePhoto(id: string): Promise<void> {
    this.photos.delete(id);
    this.edits.delete(id);
    this.lastThumb.delete(id);
    await removeEntry(this.previews, `${id}.jpg`);
    this.scheduleSave();
  }

  async getEditState(photoId: string): Promise<EditState | undefined> {
    return this.edits.get(photoId);
  }

  async getAllEditStates(): Promise<EditState[]> {
    return [...this.edits.values()];
  }

  async putEditState(editState: EditState): Promise<void> {
    this.edits.set(editState.photoId, editState);
    // Persist edits immediately rather than on the debounce: develop commits are
    // discrete, user-paced actions, and the beforeunload flush can be cut short
    // on app quit — so a debounced edit made just before closing was being lost.
    await this.save();
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private scheduleSave(): void {
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // Normal 800ms debounce, but never wait longer than MAX_SAVE_DELAY since the
    // first un-saved change — so a continuous import durably persists progress.
    const delay = Math.min(SAVE_DELAY, Math.max(0, MAX_SAVE_DELAY - (now - this.firstDirtyAt)));
    this.saveTimer = setTimeout(() => void this.save(), delay);
  }

  /** Write any pending changes immediately (e.g. on app quit). */
  async flush(): Promise<void> {
    await this.save();
  }

  private async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.firstDirtyAt = 0;
    try {
      const data: CatalogFile = {
        version: 1,
        photos: [...this.photos.values()].map(strip),
        edits: [...this.edits.values()],
      };
      await writeJSON(this.sl, "catalog.json", data);
    } catch (e) {
      console.error("[project] catalog save failed:", e);
    }
  }
}
