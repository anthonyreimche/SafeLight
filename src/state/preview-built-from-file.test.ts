// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A grid preview built from the photo's file shows the photo unedited, so the edit
// its stored preview showed (previewEdit) goes from the catalog store once it loads,
// or Develop would draw it as the edited look. The storage record keeps naming the
// preview on disk. Driven through the project's preview reader, the on-demand
// loader and the catalog store, wired as opening a project wires them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import type { WorkingDir } from "@/project/working-dir";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";

const h = vi.hoisted(() => ({
  persistPreviews: true,
  wd: null as WorkingDir | null,
}));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));

vi.mock("@/project/working-dir", () => ({
  resolveWorkingDir: async () => {
    if (!h.wd) throw new Error("no working dir configured");
    return h.wd;
  },
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ persistPreviews: h.persistPreviews, thumbMaxEdge: 768 }),
}));

vi.mock("@/extensions/registry", () => ({
  emitPhotoImport: async () => null,
  emitMetadataChange: async () => {},
  emitPhotoRemove: async () => {},
}));

vi.mock("@/project/project-store", () => ({
  useProjectStore: { getState: () => ({}) },
}));

vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.jpe?g$/i.test(name),
  buildPhoto: async (
    file: File,
    directoryHandle: FileSystemDirectoryHandle | null,
    fileHandle: FileSystemFileHandle | null,
  ): Promise<CatalogPhoto> => ({
    id: `id:${file.name}`,
    filename: file.name,
    relPath: "",
    folder: "",
    directoryHandle,
    fileHandle,
    thumbnailBlob: new Blob([`stored:${file.name}`]),
    thumbnailUrl: null,
    width: 4000,
    height: 3000,
    fileSize: file.size,
    mimeType: "image/jpeg",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 1,
    dateImported: 2,
    exif: {},
  }),
  buildPreviewBlob: async (photo: CatalogPhoto) =>
    photo.fileHandle ? new Blob([`built:${photo.filename}`]) : null,
}));

import { ProjectStorage } from "@/project/project-storage";
import { useCatalogStore } from "./catalog-store";
import { reloadThumbnail, requestThumbnail, setThumbnailLoader } from "./thumbnail-loader";

class FakeChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const ROOT = "/photos";
const ID = "id:a.jpg";

let frames: FrameRequestCallback[] = [];
const opened: ProjectStorage[] = [];

beforeEach(() => {
  h.persistPreviews = true;
  frames = [];
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  useCatalogStore.setState({ photos: [] });
});

afterEach(() => {
  setThumbnailLoader(null);
  for (const storage of opened.splice(0)) storage.close();
  vi.unstubAllGlobals();
});

/** Mount a project holding a.jpg whose catalog was saved with its preview showing
 *  the edit "edit-1", as a session that edited it leaves it. */
async function savedWithEditedPreview(): Promise<FileSystemDirectoryHandle> {
  const fs = new MemoryFs(ROOT);
  fs.put(`${ROOT}/a.jpg`, "A");
  h.wd = {
    sl: fsaDirectoryHandle(fs, `${ROOT}/.safelight`),
    location: "in-folder",
    externalPath: null,
    promotedFromExternal: null,
  };
  const root = fsaDirectoryHandle(fs, ROOT);
  const first = await ProjectStorage.open(root);
  await first.storage.putPhoto({
    ...first.photos[0],
    thumbnailBlob: new Blob(["stored:a.jpg"]),
    previewEdit: "edit-1",
  });
  await first.storage.flush();
  first.storage.close();
  return root;
}

/** Open the project again and install its preview reader and photos, as opening a
 *  project does. */
async function reopen(root: FileSystemDirectoryHandle): Promise<ProjectStorage> {
  const { storage, photos } = await ProjectStorage.open(root);
  opened.push(storage);
  setThumbnailLoader((id) => storage.readPreview(id));
  useCatalogStore.setState({ photos });
  return storage;
}

/** Let the requested reads land, then run the frame that hands them to the store. */
async function previewsLoad(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

const inStore = () => useCatalogStore.getState().photos[0];
const inStorage = async (storage: ProjectStorage) => (await storage.getAllPhotos())[0];

describe("a photo whose stored preview showed its edit", () => {
  it("loads without that edit when previews aren't stored and its preview is built from the file", async () => {
    const root = await savedWithEditedPreview();
    h.persistPreviews = false;
    const storage = await reopen(root);
    expect(inStore().previewEdit).toBe("edit-1");

    requestThumbnail(ID, { visible: true });
    await previewsLoad();

    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("built:a.jpg");
    expect(inStore().previewEdit).toBeUndefined();
    // The record names the preview still on disk.
    expect((await inStorage(storage)).previewEdit).toBe("edit-1");
  });

  it("keeps that edit when its preview is read from disk", async () => {
    const root = await savedWithEditedPreview();
    const storage = await reopen(root);

    requestThumbnail(ID, { visible: true });
    await previewsLoad();

    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("stored:a.jpg");
    expect(inStore().previewEdit).toBe("edit-1");
    expect((await inStorage(storage)).previewEdit).toBe("edit-1");
  });

  it("reloads without that edit when another window's change rebuilds its preview from the file", async () => {
    const root = await savedWithEditedPreview();
    h.persistPreviews = false;
    const storage = await reopen(root);

    await reloadThumbnail(ID);

    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("built:a.jpg");
    expect(inStore().previewEdit).toBeUndefined();
    // The record names the preview still on disk.
    expect((await inStorage(storage)).previewEdit).toBe("edit-1");
  });

  it("reloads with that edit when another window's change is read from disk", async () => {
    const root = await savedWithEditedPreview();
    await reopen(root);

    await reloadThumbnail(ID);

    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("stored:a.jpg");
    expect(inStore().previewEdit).toBe("edit-1");
  });
});
