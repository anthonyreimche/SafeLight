// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Background loads (Develop's neighbour prefetch, Cache all) never fetch a
// library source's original: it comes over the network, and only a photo the
// person opens is worth that.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

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
import { fillCacheEntry } from "./cache-fill";
import { bindSourceCache, dropLibrarySources, registerLibrarySource, sourceRoot } from "@/project/library-sources";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";

const readOriginal = vi.fn(async () => new Blob(["orig"]));

beforeEach(() => {
  readOriginal.mockClear();
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    list: async () => ({ folders: [{ name: "Trip", items: [{ key: "k", name: "a.NEF" }] }] }),
    readPreview: async () => new Blob(),
    readOriginal,
  });
});

afterEach(() => dropLibrarySources("ext.a"));

async function photo(): Promise<CatalogPhoto> {
  const root = sourceRoot("test.server")!;
  bindSourceCache(root, fsaDirectoryHandle(new MemoryFs("/sl"), "/sl"));
  const dir = await root.getDirectoryHandle("Trip");
  return {
    id: "p1",
    filename: "a.NEF",
    relPath: "Trip/a.NEF",
    folder: "Trip",
    directoryHandle: dir,
    fileHandle: await dir.getFileHandle("a.NEF"),
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
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
  };
}

describe("a background load of a library source's photo", () => {
  it("gives up without fetching an original that isn't kept", async () => {
    await expect(loadPhotoImage(await photo(), { background: true })).resolves.toBeNull();
    expect(readOriginal).not.toHaveBeenCalled();
  });

  it("fills no RAW cache entry from an original that isn't kept", async () => {
    await expect(fillCacheEntry(await photo(), 0)).resolves.toBe("nothing");
    expect(readOriginal).not.toHaveBeenCalled();
  });
});
