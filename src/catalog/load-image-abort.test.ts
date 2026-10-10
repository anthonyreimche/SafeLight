// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A load the user abandoned (they moved on to another photo) has nothing to
// show: it stops before reading the original, never falls back to a lesser
// image, and writes nothing. A decode that had already started still runs to
// the end and fills the cache. The cache, the decoders and the preview
// extractor are faked; only the hand-offs are under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { RawFloatImage } from "@/raw/decode";

interface CachedEntry {
  data: Uint16Array;
  width: number;
  height: number;
}

interface Request {
  background?: boolean;
  signal?: AbortSignal;
}

const h = vi.hoisted(() => ({
  cached: null as CachedEntry | null,
  /** Entries handed to writeCachedPreview, as [key, width, height]. */
  cacheWrites: [] as [string, number, number][],
  /** How many times an original was read through its file handle. */
  fileReads: 0,
  /** Runs while the original is being read. */
  whileReading: (): void => {},
  /** Each request handed to the full float decode, in order. */
  decodes: [] as (Request | undefined)[],
  decodeResult: (): Promise<RawFloatImage | null> => Promise.resolve(null),
  /** How many times the embedded preview was extracted. */
  previewReads: 0,
  preview: null as Blob | null,
  /** How many times the 8-bit RAW decoder ran. */
  bitmapDecodes: 0,
  /** How many blobs were handed to the image decoder. */
  imageDecodes: 0,
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => true }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async () => h.cached,
  writeCachedPreview: async (key: string, _data: Float32Array, w: number, ht: number) => {
    h.cacheWrites.push([key, w, ht]);
  },
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => {
    h.bitmapDecodes++;
    return null;
  },
  decodeRawToFloat: (_file: Blob, request?: Request) => {
    h.decodes.push(request);
    return h.decodeResult();
  },
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async () => ({ use: true, cache: true }),
}));

vi.mock("@/modules/library/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/raw-preview")>()),
  extractRawPreview: async () => {
    h.previewReads++;
    return h.preview;
  },
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

const embeddedJpeg = new Blob(["jpeg"], { type: "image/jpeg" });
const storedThumbnail = new Blob(["thumbnail"], { type: "image/jpeg" });

function floatDecode(): RawFloatImage {
  return {
    data: new Float32Array(4 * 2 * 4).fill(0.18),
    width: 4,
    height: 2,
    oriented: true,
  };
}

function rawPhoto(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  const name = "DSCF0001.RAF";
  const file = new File([new Uint8Array(8)], name);
  const fileHandle = {
    kind: "file",
    name,
    getFile: async () => {
      h.fileReads++;
      h.whileReading();
      return file;
    },
  } as FileSystemFileHandle;
  return {
    id: "p1",
    filename: name,
    relPath: name,
    folder: "",
    directoryHandle: null,
    fileHandle,
    thumbnailBlob: storedThumbnail,
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
    ...over,
  };
}

function abandoned(): AbortSignal {
  const gone = new AbortController();
  gone.abort();
  return gone.signal;
}

beforeEach(() => {
  h.cached = null;
  h.cacheWrites = [];
  h.fileReads = 0;
  h.whileReading = () => {};
  h.decodes = [];
  h.decodeResult = () => Promise.resolve(null);
  h.previewReads = 0;
  h.preview = null;
  h.bitmapDecodes = 0;
  h.imageDecodes = 0;
  vi.stubGlobal("createImageBitmap", async (): Promise<ImageBitmap> => {
    h.imageDecodes++;
    return { width: 6000, height: 4000, close() {} };
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadPhotoImage for a load the user abandoned", () => {
  it("reads nothing and shows nothing when it was abandoned before it began", async () => {
    const image = await loadPhotoImage(rawPhoto(), { signal: abandoned() });

    expect(image).toBeNull();
    expect(h.fileReads).toBe(0);
    expect(h.decodes).toEqual([]);
    expect(h.imageDecodes).toBe(0);
  });

  it("shows nothing for an abandoned load of a photo whose original is offline", async () => {
    const image = await loadPhotoImage(rawPhoto({ fileHandle: null }), { signal: abandoned() });

    expect(image).toBeNull();
    expect(h.imageDecodes).toBe(0);
  });

  it("stops once the original is read when it was abandoned meanwhile", async () => {
    const opened = new AbortController();
    h.whileReading = () => opened.abort();
    h.preview = embeddedJpeg;

    const image = await loadPhotoImage(rawPhoto(), { signal: opened.signal });

    expect(image).toBeNull();
    expect(h.previewReads).toBe(0);
    expect(h.decodes).toEqual([]);
    expect(h.imageDecodes).toBe(0);
  });

  it("hands its signal to the full decode along with its priority", async () => {
    const opened = new AbortController();

    await loadPhotoImage(rawPhoto(), { background: true, signal: opened.signal });

    expect(h.decodes).toEqual([{ background: true, signal: opened.signal }]);
  });

  it("falls back to neither the embedded preview nor the thumbnail when its decode was dropped", async () => {
    const opened = new AbortController();
    h.preview = embeddedJpeg;
    h.decodeResult = () => {
      opened.abort();
      return Promise.resolve(null);
    };

    const image = await loadPhotoImage(rawPhoto(), { signal: opened.signal });

    expect(image).toBeNull();
    expect(h.bitmapDecodes).toBe(0);
  });

  it("decodes nothing more when its RAW path throws after it was abandoned", async () => {
    // The 8-bit fallback runs a full libraw decode of its own, outside the pool.
    const opened = new AbortController();
    h.decodeResult = () => {
      opened.abort();
      return Promise.reject(new Error("worker gone"));
    };

    const image = await loadPhotoImage(rawPhoto(), { signal: opened.signal });

    expect(image).toBeNull();
    expect(h.bitmapDecodes).toBe(0);
    expect(h.imageDecodes).toBe(0);
  });

  it("does not fall back to a smaller cached preview when its decode was dropped", async () => {
    const opened = new AbortController();
    h.cached = { data: new Uint16Array(4 * 2 * 4), width: 4, height: 2 };
    h.decodeResult = () => {
      opened.abort();
      return Promise.resolve(null);
    };

    const image = await loadPhotoImage(rawPhoto(), {
      minEdge: Infinity,
      signal: opened.signal,
    });

    expect(image).toBeNull();
  });

  it("finishes a decode that had started and still writes it to the cache", async () => {
    const opened = new AbortController();
    h.decodeResult = () => {
      opened.abort();
      return Promise.resolve(floatDecode());
    };

    await loadPhotoImage(rawPhoto(), { signal: opened.signal });

    expect(h.cacheWrites).toEqual([["DSCF0001.RAF:8:0", 4, 2]]);
  });
});
