// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a RAW load asks of its decode so the pixel work happens off the main
// thread (the frame turned upright, the cache entry built) and so the decode
// can stop at half size when the caller renders from no more. The decoder, the
// cache and the colour check are faked; the requests and the hand-offs are under test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { RawFloatImage } from "@/raw/decode";
import type { DecodeRequest } from "@/raw/decode-pool";
import type { CachedPreview, EncodedEntry } from "@/raw/cache-encode";
import { encodeCacheEntry } from "@/raw/cache-encode";

const h = vi.hoisted(() => ({
  settings: { rawCacheEnabled: true, rawCacheMaxEdge: 3072, developMaxEdge: 4096 } as Record<string, unknown>,
  cached: null as CachedPreview | null,
  /** What each full decode was asked for. */
  requests: [] as (DecodeRequest | undefined)[],
  decode: null as RawFloatImage | null,
  /** The writeCachedPreview calls: key, the data handed over, and the entry. */
  writes: [] as { key: string; data: Float32Array; entry: EncodedEntry | undefined }[],
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => true }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async () => h.cached,
  writeCachedPreview: async (key: string, data: Float32Array, _w: number, _h: number, _g: number, entry?: EncodedEntry) => {
    h.writes.push({ key, data, entry });
    return true;
  },
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));

vi.mock("./cache-fill", () => ({ completeCachedEntry: () => {} }));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async (_file: Blob, request?: DecodeRequest) => {
    h.requests.push(request);
    return h.decode;
  },
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async () => ({ use: true, cache: true }),
  matchCameraPreview: async () => undefined,
}));

vi.mock("@/raw/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/raw-preview")>()),
  extractRawPreview: async () => null,
}));

vi.mock("@/state/settings-store", () => ({ getSettings: () => h.settings }));

import { loadPhotoImage } from "./load-image";

function rawPhoto(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  const file = new File([new Uint8Array(8)], "DSCF0001.RAF");
  const fileHandle = { kind: "file", name: "DSCF0001.RAF", getFile: async () => file } as FileSystemFileHandle;
  return {
    id: "p1",
    filename: "DSCF0001.RAF",
    relPath: "DSCF0001.RAF",
    folder: "",
    directoryHandle: null,
    fileHandle,
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
    ...over,
  };
}

const frame = (over: Partial<RawFloatImage> = {}): RawFloatImage => ({
  data: Float32Array.from({ length: 4 * 2 * 4 }, (_, i) => i),
  width: 4,
  height: 2,
  oriented: true,
  ...over,
});

beforeEach(() => {
  h.settings = { rawCacheEnabled: true, rawCacheMaxEdge: 3072, developMaxEdge: 4096 };
  h.cached = null;
  h.requests = [];
  h.decode = frame();
  h.writes = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadPhotoImage's decode request", () => {
  it("asks for the cache entry at the cache's edge, built with the decode", async () => {
    await loadPhotoImage(rawPhoto());

    expect(h.requests[0]).toMatchObject({ cacheEdge: 3072 });
  });

  it("asks for no cache entry when the cache is off", async () => {
    h.settings = { ...h.settings, rawCacheEnabled: false };

    await loadPhotoImage(rawPhoto());

    expect(h.requests[0]?.cacheEdge).toBeUndefined();
  });

  it("asks for no cache entry when the photo's cached one already reaches the cache's edge", async () => {
    h.cached = { data: new Uint16Array(4), width: 3072, height: 2048, full: { width: 6000, height: 4000 }, sample: null };

    await loadPhotoImage(rawPhoto(), { minEdge: 6000 });

    expect(h.requests[0]?.cacheEdge).toBeUndefined();
  });

  it("asks for the manual turns the photo carries beyond its EXIF orientation", async () => {
    // 270 clockwise in all, 90 of it EXIF (orientation 6).
    await loadPhotoImage(rawPhoto({ rotation: 270, exif: { orientation: 6 } }));

    expect(h.requests[0]?.turn).toBe(180);
  });

  it("decodes a Develop open (it asks for the sample) at full size, so the centre sample stays native", async () => {
    await loadPhotoImage(rawPhoto(), { sample: true });

    expect(h.requests[0]?.targetEdge).toBeUndefined();
  });

  it("takes a target edge the caller gives", async () => {
    await loadPhotoImage(rawPhoto(), { sample: true, targetEdge: 1000 });

    expect(h.requests[0]?.targetEdge).toBe(1000);
  });

  it("decodes at full size for a load that gives no target and asks for no sample", async () => {
    await loadPhotoImage(rawPhoto());
    await loadPhotoImage(rawPhoto(), { minEdge: 2000 });

    expect(h.requests.map((r) => r?.targetEdge)).toEqual([undefined, undefined]);
  });
});

describe("loadPhotoImage with a frame the decode turned and cached", () => {
  it("hands over the turned frame as it is, and writes the cache entry the decode built", async () => {
    const entry = encodeCacheEntry(new Float32Array(2 * 4 * 4), 2, 4, 3072);
    const turned = frame({ width: 2, height: 4, turned: 90, entry });
    h.decode = turned;

    const image = await loadPhotoImage(rawPhoto({ rotation: 90 }));

    expect(image).toMatchObject({ kind: "float", width: 2, height: 4 });
    expect(image?.kind === "float" && image.data === turned.data).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].data).toBe(turned.data);
    expect(h.writes[0].entry).toBe(entry);
  });

  it("turns on this thread only what the decode has not turned", async () => {
    // 90 asked for, nothing done: the in-house fallback decode.
    h.decode = frame({ oriented: true });

    const image = await loadPhotoImage(rawPhoto({ rotation: 90 }));

    expect(image).toMatchObject({ kind: "float", width: 2, height: 4 });
  });
});
