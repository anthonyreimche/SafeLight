// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The previews a first import brings stay in memory only as long as the grid's
// loader keeps them: once it lets one go, the storage's record lets go of it too,
// and the grid reads it back from disk like any preview it let go of.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import type { WorkingDir } from "./working-dir";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({ wd: null as WorkingDir | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));
vi.mock("./working-dir", () => ({
  resolveWorkingDir: async () => {
    if (!h.wd) throw new Error("no working dir configured");
    return h.wd;
  },
}));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ persistPreviews: true, thumbMaxEdge: 768 }),
}));
vi.mock("@/extensions/registry", () => ({
  emitPhotoImport: async () => null,
  emitMetadataChange: async () => {},
  emitPhotoRemove: async () => {},
}));
vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.jpe?g$/i.test(name),
  importPhoto: async (
    fileHandle: FileSystemFileHandle,
    directoryHandle: FileSystemDirectoryHandle | null,
  ): Promise<CatalogPhoto | null> => {
    const file = await fileHandle.getFile();
    const thumbnailBlob = new Blob([`thumb:${file.name}`]);
    return {
      id: `id:${file.name}`,
      filename: file.name,
      relPath: "",
      folder: "",
      directoryHandle,
      fileHandle,
      thumbnailBlob,
      thumbnailUrl: URL.createObjectURL(thumbnailBlob),
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
    };
  },
  buildPreviewBlob: async () => null,
}));

import { ProjectStorage, type OpenedProject } from "./project-storage";
import { storageDeps } from "./storage-deps";
import { onBroadcast } from "@/state/broadcast";
import { useCatalogStore } from "@/state/catalog-store";
import { adoptThumbnails, requestThumbnail, setThumbnailLoader } from "@/state/thumbnail-loader";

const ROOT = "/home/u/photos";
const SL = `${ROOT}/.safelight`;
const FILES = ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"];

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

let fs: MemoryFs;
const opened: ProjectStorage[] = [];
let urlSeq = 0;
const liveUrls = new Set<string>();
let frames: FrameRequestCallback[] = [];

const writes = () => fs.writeCount(`${SL}/catalog.json`);
const catalogText = () => fs.text(`${SL}/catalog.json`);

function mount(): void {
  fs = new MemoryFs(ROOT);
  for (const name of FILES) fs.put(`${ROOT}/${name}`, name);
  h.wd = {
    sl: fsaDirectoryHandle(fs, SL),
    location: "in-folder",
    externalPath: null,
    promotedFromExternal: null,
  };
}

async function open(
  onPhoto?: (photo: CatalogPhoto) => void,
  onSkeletons?: (storage: ProjectStorage) => void,
): Promise<OpenedProject> {
  const project = await ProjectStorage.open(fsaDirectoryHandle(fs, ROOT), storageDeps, onPhoto, onSkeletons);
  opened.push(project.storage);
  await project.storage.flush();
  return project;
}

/** A first import as the app runs it, with a grid loader that keeps `limit` previews. */
async function importWithLoader(limit: number): Promise<OpenedProject> {
  mount();
  let storage: ProjectStorage | null = null;
  return open(
    (photo) => {
      useCatalogStore.getState().appendPhotos([photo]);
      if (photo.thumbnailBlob && storage?.mayForgetPreview(photo.id))
        adoptThumbnails([{ id: photo.id, blob: photo.thumbnailBlob }]);
    },
    (installed) => {
      storage = installed;
      setThumbnailLoader((id, stop) => installed.readPreview(id, { signal: stop }), {
        cacheLimit: limit,
        onEvict: (ids) => installed.forgetPreviews(ids),
      });
    },
  );
}

beforeEach(() => {
  urlSeq = 0;
  liveUrls.clear();
  frames = [];
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const url = `blob:test/${urlSeq++}`;
    liveUrls.add(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => void liveUrls.delete(url));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useCatalogStore.setState({ photos: [], selectedIds: new Set(), activePhotoId: null });
});

afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  setThumbnailLoader(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("forgetPreviews", () => {
  it("lets go of the preview an imported record holds, as no change to the catalogue", async () => {
    mount();
    const { storage, photos } = await open();
    const id = photos[0].id;
    expect(storage.heldPhoto(id)?.thumbnailBlob).not.toBeNull();
    const text = catalogText();
    const before = writes();
    const sent: unknown[] = [];
    const stop = onBroadcast((message) => void sent.push(message));

    storage.forgetPreviews([id]);
    await storage.flush();
    stop();

    expect(storage.heldPhoto(id)).toMatchObject({ thumbnailBlob: null, thumbnailUrl: null });
    expect(sent).toEqual([]);
    expect(writes()).toBe(before);
    expect(catalogText()).toBe(text);
  });

  it("keeps the preview of a record whose preview couldn't be stored", async () => {
    mount();
    const write = fs.write.bind(fs);
    vi.spyOn(fs, "write").mockImplementation(async (path, data) => {
      if (/previews[\\/]id:a\.jpg/.test(path)) throw new Error("EBUSY");
      return write(path, data);
    });
    const { storage } = await open();

    expect(storage.mayForgetPreview("id:a.jpg")).toBe(false);
    expect(storage.mayForgetPreview("id:b.jpg")).toBe(true);
    storage.forgetPreviews(["id:a.jpg"]);
    expect(storage.heldPhoto("id:a.jpg")?.thumbnailBlob).not.toBeNull();
  });
});

describe("a first import larger than the grid's preview cache", () => {
  it("leaves no photo the catalogue shows with a preview URL that was revoked", async () => {
    const project = await importWithLoader(3);

    useCatalogStore.getState().finalizeCatalog(project.photos);

    const shown = useCatalogStore.getState().photos;
    expect(shown.map((p) => p.id)).toEqual(FILES.map((name) => `id:${name}`));
    expect(shown.filter((p) => p.thumbnailUrl !== null && !liveUrls.has(p.thumbnailUrl))).toEqual([]);
    expect(shown.filter((p) => p.thumbnailBlob !== null)).toHaveLength(3);
  });

  it("hands back no record still holding a preview the loader let go of", async () => {
    const project = await importWithLoader(3);

    const holding = (photos: CatalogPhoto[]) => photos.filter((p) => p.thumbnailBlob !== null).map((p) => p.id);
    expect(holding(project.photos)).toEqual(["id:c.jpg", "id:d.jpg", "id:e.jpg"]);
    expect(holding(project.newPhotos)).toEqual(["id:c.jpg", "id:d.jpg", "id:e.jpg"]);
  });

  it("reads a preview it let go of back from disk when its cell is in view", async () => {
    const project = await importWithLoader(3);
    useCatalogStore.getState().finalizeCatalog(project.photos);

    requestThumbnail("id:a.jpg", { visible: true });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    for (const frame of frames.splice(0)) frame(0);

    const first = useCatalogStore.getState().photos[0];
    expect(first.thumbnailUrl).not.toBeNull();
    expect(liveUrls.has(first.thumbnailUrl ?? "")).toBe(true);
    expect(await first.thumbnailBlob?.text()).toBe("thumb:a.jpg");
  });
});
