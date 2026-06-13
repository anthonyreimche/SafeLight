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
import { buildPhoto } from "@/modules/library/import-photos";
import { mapLimit, readBlob, readJSON, removeEntry, writeBlob, writeJSON } from "./fs";
import { scanProject, type FolderNode, type ScannedFile } from "./scan";

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
  ): Promise<OpenedProject> {
    const sl = await root.getDirectoryHandle(".safelight", { create: true });
    const previews = await sl.getDirectoryHandle("previews", { create: true });
    const rawCacheDir = await sl.getDirectoryHandle("raw", { create: true });
    const storage = new ProjectStorage(sl, previews);

    const [saved, scan] = await Promise.all([
      readJSON<CatalogFile>(sl, "catalog.json"),
      scanProject(root),
    ]);
    const byRel = new Map(
      (saved?.photos ?? []).map((p) => [p.relPath, p] as const),
    );

    const newPhotos: CatalogPhoto[] = [];
    const results = await mapLimit(scan.files, 8, async (f: ScannedFile) => {
      const prev = byRel.get(f.path);
      if (prev) {
        // Known photo: reattach live handles, rehydrate the cached thumbnail.
        const blob = await readBlob(previews, `${prev.id}.jpg`);
        const photo: CatalogPhoto = {
          ...prev,
          folder: folderOf(f.path),
          directoryHandle: f.parent,
          fileHandle: f.handle,
          thumbnailBlob: blob,
          thumbnailUrl: blob ? URL.createObjectURL(blob) : null,
        };
        storage.lastThumb.set(photo.id, blob);
        onPhoto?.(photo);
        return photo;
      }
      // New file: decode, thumbnail, cache the preview on disk.
      try {
        const file = await f.handle.getFile();
        const built = await buildPhoto(file, f.parent, f.handle);
        if (!built) return null;
        const photo: CatalogPhoto = {
          ...built,
          relPath: f.path,
          folder: folderOf(f.path),
        };
        if (photo.thumbnailBlob)
          await writeBlob(previews, `${photo.id}.jpg`, photo.thumbnailBlob);
        storage.lastThumb.set(photo.id, photo.thumbnailBlob);
        newPhotos.push(photo);
        onPhoto?.(photo);
        return photo;
      } catch {
        return null;
      }
    });

    const photos = results.filter((p): p is CatalogPhoto => p !== null);
    for (const p of photos) storage.photos.set(p.id, p);

    // Keep edits only for photos that still exist on disk.
    for (const e of saved?.edits ?? [])
      if (storage.photos.has(e.photoId)) storage.edits.set(e.photoId, e);

    const removedCount = byRel.size - (photos.length - newPhotos.length);
    if (newPhotos.length > 0 || removedCount > 0) storage.scheduleSave();

    return { storage, tree: scan.tree, photos, newPhotos, rawCacheDir };
  }

  // ── CatalogStorage ─────────────────────────────────────────────────────────

  async getAllPhotos(): Promise<CatalogPhoto[]> {
    return [...this.photos.values()];
  }

  async putPhoto(photo: CatalogPhoto): Promise<void> {
    this.photos.set(photo.id, photo);
    // Persist the thumbnail only when it actually changed (e.g. rotation).
    if (photo.thumbnailBlob && this.lastThumb.get(photo.id) !== photo.thumbnailBlob) {
      this.lastThumb.set(photo.id, photo.thumbnailBlob);
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
    this.scheduleSave();
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY);
  }

  private async save(): Promise<void> {
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
