// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The size a library source's RAW listed without one takes from its first
// decode is the frame's full size: a decode made at half size (past libraw's
// memory budget, or when Develop needs no more) stands for the whole frame, and
// a bitmap decode, which may be reduced, teaches nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

const h = vi.hoisted(() => ({
  stored: [] as CatalogPhoto[],
  float: null as unknown,
  bitmap: null as unknown,
}));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async () => null,
  writeCachedPreview: async () => {},
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({ rawCacheMaxEdge: 3072 }) }));
vi.mock("@/raw/decode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/decode")>()),
  decodeRawToFloat: async () => h.float,
  decodeRawToBitmap: async () => h.bitmap,
}));
vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async () => ({ use: true, cache: false, match: undefined }),
  matchCameraPreview: async () => undefined,
}));

import { loadPhotoImage } from "./load-image";
import { setCatalogStorage, type CatalogStorage } from "./storage";
import { useCatalogStore } from "@/state/catalog-store";
import { bindSourceCache, dropLibrarySources, registerLibrarySource, sourceRoot } from "@/project/library-sources";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";

beforeEach(() => {
  h.stored = [];
  h.float = null;
  h.bitmap = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setCatalogStorage({
    putPhoto: async (photo: CatalogPhoto) => {
      h.stored.push(photo);
    },
  } as unknown as CatalogStorage);
});

afterEach(() => {
  setCatalogStorage(null);
  dropLibrarySources("ext.a");
  vi.restoreAllMocks();
});

async function unsizedRaw(): Promise<CatalogPhoto> {
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    list: async () => ({ items: [{ key: "k", name: "a.NEF" }] }),
    readPreview: async () => new Blob(),
    readOriginal: async () => new Blob(["raw bytes"]),
  });
  const root = sourceRoot("test.server")!;
  bindSourceCache(root, fsaDirectoryHandle(new MemoryFs("/sl"), "/sl"));
  const photo: CatalogPhoto = {
    id: "p1",
    filename: "a.NEF",
    relPath: "a.NEF",
    folder: "",
    directoryHandle: root,
    fileHandle: await root.getFileHandle("a.NEF"),
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 512,
    height: 341,
    fileSize: 0,
    mimeType: "",
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

describe("the size a source RAW listed without one takes from its decode", () => {
  it("is the full frame's when the decode was made at half size", async () => {
    h.float = {
      data: new Float32Array(3 * 2 * 4),
      width: 3,
      height: 2,
      oriented: true,
      halfSize: true,
      sourceWidth: 6,
      sourceHeight: 4,
    };
    expect(await loadPhotoImage(await unsizedRaw())).toMatchObject({ kind: "float", width: 3 });
    expect(useCatalogStore.getState().photos[0]).toMatchObject({ width: 6, height: 4 });
  });

  it("is left as it was by a bitmap decode", async () => {
    h.float = { failure: "unsupported", reason: "test" };
    h.bitmap = { bitmap: { width: 3, height: 2, close: () => {} }, oriented: true };
    expect(await loadPhotoImage(await unsizedRaw())).toMatchObject({ kind: "bitmap" });
    expect(useCatalogStore.getState().photos[0]).toMatchObject({ width: 512, height: 341 });
    expect(h.stored).toEqual([]);
  });
});
