// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop's decode takes seconds, and the user may open another project while
// it runs. Its cache write names the photo by path and size, which in the next
// project's folder stands for another photo, so the write goes in tagged with
// the cache generation the load began under and raw-cache.ts drops it once the
// folder has changed (raw-cache.test.ts). Here only the hand-off is under test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { RawFloatImage } from "@/raw/decode";

const h = vi.hoisted(() => ({
  /** The cache generation: which project's folder the cache is in. */
  generation: 1,
  /** Each write handed to the cache, as [key, the generation it carried]. */
  cacheWrites: [] as [string, number][],
  decodeResult: (): Promise<RawFloatImage | null> => Promise.resolve(null),
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => true }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => h.generation,
  readCachedPreview: async () => null,
  writeCachedPreview: async (
    key: string,
    _data: Float32Array,
    _w: number,
    _h: number,
    begunIn: number,
  ) => {
    h.cacheWrites.push([key, begunIn]);
  },
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: () => h.decodeResult(),
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async () => ({ use: true, cache: true }),
}));

vi.mock("@/modules/library/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/raw-preview")>()),
  extractRawPreview: async () => null,
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheMaxEdge: 3072 }),
}));

vi.mock("./storage", () => ({
  catalogStorage: () => ({ putPhoto: async () => {} }),
}));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: [] }) },
}));

import { loadPhotoImage } from "./load-image";

function floatDecode(): RawFloatImage {
  return { data: new Float32Array(4 * 2 * 4).fill(0.18), width: 4, height: 2, oriented: true };
}

function rawPhoto(): CatalogPhoto {
  const name = "DSCF0001.RAF";
  const file = new File([new Uint8Array(8)], name);
  return {
    id: "p1",
    filename: name,
    relPath: name,
    folder: "",
    directoryHandle: null,
    fileHandle: { kind: "file", name, getFile: async () => file } as FileSystemFileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
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

beforeEach(() => {
  h.generation = 1;
  h.cacheWrites = [];
  h.decodeResult = () => Promise.resolve(floatDecode());
});

describe("loadPhotoImage's cache write", () => {
  it("carries the generation the load began under, not the one it finished under", async () => {
    h.decodeResult = () => {
      h.generation = 2; // another project opened while libraw ran
      return Promise.resolve(floatDecode());
    };

    await loadPhotoImage(rawPhoto());

    expect(h.cacheWrites).toEqual([["DSCF0001.RAF:8:0", 1]]);
  });
});
