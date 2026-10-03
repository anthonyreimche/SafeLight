// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How a RAW reaches the renderer when the develop-preview cache holds it. The
// cache stores scene-linear half floats, so a hit must be tagged as such for
// the renderer to take the same path as a fresh float decode. The cache and
// the decoder are faked; only the hand-off shape is under test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

interface CachedEntry {
  data: Uint16Array;
  width: number;
  height: number;
}

const h = vi.hoisted(() => ({
  cached: null as CachedEntry | null,
  fullDecodes: 0,
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => true }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  readCachedPreview: async () => h.cached,
  writeCachedPreview: async () => {},
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async () => {
    h.fullDecodes++;
    return null;
  },
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

import { loadPhotoImage } from "./load-image";

function rawPhoto(): CatalogPhoto {
  const file = new File([new Uint8Array(8)], "DSCF0001.RAF");
  const fileHandle = {
    kind: "file",
    name: file.name,
    getFile: async () => file,
  } as FileSystemFileHandle;
  return {
    id: "p1",
    filename: file.name,
    relPath: file.name,
    folder: "",
    directoryHandle: null,
    fileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
    mimeType: "image/x-fuji-raf",
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

describe("loadPhotoImage with a cached develop preview", () => {
  beforeEach(() => {
    h.cached = { data: new Uint16Array(4 * 2 * 4), width: 4, height: 2 };
    h.fullDecodes = 0;
  });

  it("hands a cache hit over as a float16 source without decoding", async () => {
    const cached = h.cached;
    const image = await loadPhotoImage(rawPhoto());
    expect(image).toEqual({ kind: "float16", ...cached });
    expect(h.fullDecodes).toBe(0);
  });

  it("falls back to the cached preview as float16 when the full decode fails", async () => {
    const cached = h.cached;
    const image = await loadPhotoImage(rawPhoto(), { minEdge: Infinity });
    expect(h.fullDecodes).toBe(1);
    expect(image).toEqual({ kind: "float16", ...cached });
  });
});
