// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The passes that build grid previews again read nothing from a library source,
// preview or original. Rebuild previews and Re-import forget the previews kept
// for its photos (Re-import also takes their details from the listing again), so
// the grid reads each again from the source when it comes into view, as a fresh
// open does; they end at once and say how many they left to the grid. The repair
// of missing previews leaves a source's photos to the grid too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const h = vi.hoisted(() => ({
  catalog: [] as CatalogPhoto[],
  saved: [] as CatalogPhoto[],
  /** Photos whose kept previews were removed from the disk. */
  forgotten: [] as string[],
  /** Photos whose previews in memory were let go. */
  letGo: [] as string[],
}));

vi.mock("@/state/settings-store", () => ({ getSettings: () => ({ thumbMaxEdge: 512 }) }));
vi.mock("./import-thumb-task", () => ({ createThumbnail: async () => new Blob(["jpeg"]) }));
vi.mock("@/catalog/storage", () => ({
  catalogStorage: () => ({
    putPhoto: async (photo: CatalogPhoto) => {
      h.saved.push(photo);
    },
    dropStoredPreviews: async (ids: string[]) => {
      h.forgotten.push(...ids);
    },
  }),
}));
vi.mock("@/state/catalog-store", () => ({
  photoById: (photos: CatalogPhoto[], id: string) => photos.find((p) => p.id === id),
  useCatalogStore: {
    getState: () => ({
      photos: h.catalog,
      dropThumbnails: (entries: { id: string }[]) => {
        h.letGo.push(...entries.map((e) => e.id));
        return entries.map((e) => e.id);
      },
    }),
  },
}));

import { rebuildThumbnails, reimportPhotos, repairMissingPreviews } from "./import-passes";
import { bindSourceCache, dropLibrarySources, registerLibrarySource, sourceRoot } from "@/project/library-sources";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";

const readOriginal = vi.fn(async () => new Blob(["never"]));
const readPreview = vi.fn(async () => new Blob(["webp"]));

async function sourcePhoto(width: number): Promise<CatalogPhoto> {
  const root = sourceRoot("test.server")!;
  bindSourceCache(root, fsaDirectoryHandle(new MemoryFs("/sl"), "/sl"));
  const dir = await root.getDirectoryHandle("Trip");
  const fileHandle = await dir.getFileHandle("a.jpg");
  return {
    id: "p1",
    filename: "a.jpg",
    relPath: "Trip/a.jpg",
    folder: "Trip",
    directoryHandle: dir,
    fileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width,
    height: width ? 400 : 0,
    fileSize: 0,
    mimeType: "image/jpeg",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
  };
}

beforeEach(() => {
  h.saved = [];
  h.forgotten = [];
  h.letGo = [];
  readOriginal.mockClear();
  readPreview.mockClear();
  vi.stubGlobal("createImageBitmap", async () => ({ width: 600, height: 400, close: () => {} }));
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    list: async () => ({ folders: [{ name: "Trip", items: [{ key: "k", name: "a.jpg" }] }] }),
    readPreview,
    readOriginal,
  });
});

afterEach(() => {
  dropLibrarySources("ext.a");
  vi.unstubAllGlobals();
});

describe("preview passes over a library source's photos", () => {
  it("leave a missing preview to the grid, reading nothing from the source", async () => {
    const photo = await sourcePhoto(0);
    h.catalog = [photo];
    await repairMissingPreviews([photo]);
    expect(readPreview).not.toHaveBeenCalled();
    expect(readOriginal).not.toHaveBeenCalled();
    expect(h.saved).toEqual([]);
  });

  it("leave a rebuilt preview to the grid, reading nothing, and say so", async () => {
    const photo = { ...(await sourcePhoto(6000)), thumbnailBlob: new Blob(["old"]) };
    h.catalog = [photo];
    const progress: [number, number][] = [];
    const result = await rebuildThumbnails([photo], (done, total) => progress.push([done, total]));
    expect(readPreview).not.toHaveBeenCalled();
    expect(readOriginal).not.toHaveBeenCalled();
    expect(h.forgotten).toEqual(["p1"]);
    expect(h.letGo).toEqual(["p1"]);
    expect(h.saved).toEqual([]);
    expect(result).toEqual({ refetched: 1 });
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
});

describe("re-importing a library source's photos", () => {
  it("refreshes them from the listing alone and leaves their previews to the grid", async () => {
    registerLibrarySource("ext.a", {
      id: "test.server",
      name: "Server",
      list: async () => ({
        folders: [
          {
            name: "Trip",
            items: [
              {
                key: "k",
                name: "a.jpg",
                size: 1234,
                mimeType: "image/jpeg",
                exif: { cameraModel: "X100V", dateTimeOriginal: "2024:06:01 08:00:00" },
              },
            ],
          },
        ],
      }),
      readPreview,
      readOriginal,
    });
    const photo = await sourcePhoto(6000);
    h.catalog = [photo];
    const result = await reimportPhotos([photo]);
    expect(readOriginal).not.toHaveBeenCalled();
    expect(readPreview).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: 1, failed: 0, refetched: 1 });
    expect(h.forgotten).toEqual(["p1"]);
    expect(h.saved).toEqual([
      expect.objectContaining({
        id: "p1",
        fileSize: 1234,
        exif: { cameraModel: "X100V", dateTimeOriginal: "2024:06:01 08:00:00" },
        dateCreated: new Date(2024, 5, 1, 8, 0, 0).getTime(),
      }),
    ]);
  });
});
