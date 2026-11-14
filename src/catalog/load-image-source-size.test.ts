// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A library source's photo listed without a size is catalogued at its preview's
// size until its original is first decoded; then the original's own size takes
// its place, in the catalogue and the grid. A size the source listed stays.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

const h = vi.hoisted(() => ({ stored: [] as CatalogPhoto[] }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async () => null,
  writeCachedPreview: async () => {},
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({ rawCacheMaxEdge: 3072 }) }));

import { loadPhotoImage } from "./load-image";
import { setCatalogStorage, type CatalogStorage } from "./storage";
import { useCatalogStore } from "@/state/catalog-store";
import { bindSourceCache, dropLibrarySources, registerLibrarySource, sourceRoot } from "@/project/library-sources";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";

beforeEach(() => {
  h.stored = [];
  vi.stubGlobal("createImageBitmap", async () => ({ width: 4000, height: 3000, close: () => {} }));
  setCatalogStorage({
    putPhoto: async (photo: CatalogPhoto) => {
      h.stored.push(photo);
    },
  } as unknown as CatalogStorage);
});

afterEach(() => {
  setCatalogStorage(null);
  dropLibrarySources("ext.a");
  vi.unstubAllGlobals();
});

async function sourcePhoto(listed: { width?: number; height?: number }): Promise<CatalogPhoto> {
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    list: async () => ({ folders: [{ name: "Trip", items: [{ key: "k", name: "a.jpg", ...listed }] }] }),
    readPreview: async () => new Blob(),
    readOriginal: async () => new Blob(["jpeg bytes"]),
  });
  const root = sourceRoot("test.server")!;
  bindSourceCache(root, fsaDirectoryHandle(new MemoryFs("/sl"), "/sl"));
  const dir = await root.getDirectoryHandle("Trip");
  const photo: CatalogPhoto = {
    id: "p1",
    filename: "a.jpg",
    relPath: "Trip/a.jpg",
    folder: "Trip",
    directoryHandle: dir,
    fileHandle: await dir.getFileHandle("a.jpg"),
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: listed.width ?? 512,
    height: listed.height ?? 384,
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
    sourceKey: "k",
  };
  useCatalogStore.setState({ photos: [photo] });
  return photo;
}

describe("the size of a source photo listed without one", () => {
  it("is its original's once the original is decoded", async () => {
    const photo = await sourcePhoto({});
    expect(await loadPhotoImage(photo)).toMatchObject({ kind: "bitmap" });
    expect(useCatalogStore.getState().photos[0]).toMatchObject({ width: 4000, height: 3000 });
    expect(h.stored).toEqual([expect.objectContaining({ id: "p1", width: 4000, height: 3000 })]);
  });

  it("stays the size the source listed", async () => {
    const photo = await sourcePhoto({ width: 6000, height: 4500 });
    await loadPhotoImage(photo);
    expect(useCatalogStore.getState().photos[0]).toMatchObject({ width: 6000, height: 4500 });
    expect(h.stored).toEqual([]);
  });
});
