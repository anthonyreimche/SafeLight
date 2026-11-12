// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which RAW cache entry a load and a cache fill read and write: a folder photo's
// by its path, a library source's photo's by its source key, so a source photo
// that takes a removed one's path and size never opens with the other's decode.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

const h = vi.hoisted(() => ({ reads: [] as string[], written: [] as string[] }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async (key: string) => {
    h.reads.push(key);
    return null;
  },
  writeCachedPreview: async (key: string) => {
    h.written.push(key);
  },
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({ rawCacheMaxEdge: 3072 }) }));

import { loadPhotoImage } from "./load-image";

beforeEach(() => {
  h.reads = [];
  h.written = [];
});

const photo = (extra: Partial<CatalogPhoto>): CatalogPhoto => ({
  id: "p1",
  filename: "a.NEF",
  relPath: "Trip/a.NEF",
  folder: "Trip",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 6000,
  height: 4000,
  fileSize: 4,
  mimeType: "",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 0,
  dateImported: 0,
  exif: {},
  ...extra,
});

describe("the RAW cache entry a load reads", () => {
  it("is a folder photo's path, size and turn", async () => {
    await loadPhotoImage(photo({}));
    expect(h.reads).toEqual(["Trip/a.NEF:4:0"]);
  });

  it("is a source photo's key, whatever path it holds", async () => {
    await loadPhotoImage(photo({ sourceKey: "asset-b" }));
    expect(h.reads).toEqual(["/source/asset-b:4:0"]);
  });
});
