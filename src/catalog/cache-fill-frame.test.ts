// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the cache pass asks of a decode so the pixel work happens off the main
// thread, and so the decode stops at half size when the cache needs no more.
// The decoder, the colour check and the cache are faked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawFloatImage } from "@/raw/decode";
import type { DecodeRequest } from "@/raw/decode-pool";
import type { EncodedEntry } from "@/raw/cache-encode";
import { encodeCacheEntry } from "@/raw/cache-encode";

const h = vi.hoisted(() => ({
  requests: [] as (DecodeRequest | undefined)[],
  decode: null as RawFloatImage | null,
  writes: [] as { data: Float32Array; width: number; height: number; entry: EncodedEntry | undefined }[],
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToFloat: async (_file: Blob, request?: DecodeRequest) => {
    h.requests.push(request);
    return h.decode;
  },
}));

vi.mock("@/raw/accept-decode", () => ({ acceptDecode: async () => ({ use: true, cache: true }) }));
vi.mock("@/raw/raw-preview", () => ({ extractRawPreview: async () => null }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  markDecode: async () => {},
  writeCachedPreview: async (
    _key: string,
    data: Float32Array,
    width: number,
    height: number,
    _begunIn: number,
    entry?: EncodedEntry,
  ) => {
    h.writes.push({ data, width, height, entry });
    return true;
  },
}));

vi.mock("@/state/settings-store", () => ({ getSettings: () => ({ rawCacheMaxEdge: 2048 }) }));
vi.mock("./storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));
vi.mock("@/state/catalog-store", () => ({ useCatalogStore: { getState: () => ({ photos: [] }) } }));

import { fillCacheEntry } from "./cache-fill";
import { rawPhoto } from "@/raw/raw-photo.test-support";

const frame = (over: Partial<RawFloatImage> = {}): RawFloatImage => ({
  data: Float32Array.from({ length: 4 * 2 * 4 }, (_, i) => i),
  width: 4,
  height: 2,
  oriented: true,
  ...over,
});

beforeEach(() => {
  h.requests = [];
  h.decode = frame();
  h.writes = [];
});

describe("fillCacheEntry's decode request", () => {
  it("decodes at full size, so the entry's centre sample stays native, and builds the entry at the cache's edge", async () => {
    await fillCacheEntry(rawPhoto("a.NEF"), 1);

    expect(h.requests[0]).toMatchObject({ background: true, cacheEdge: 2048 });
    expect(h.requests[0]?.targetEdge).toBeUndefined();
  });

  it("asks for the manual turns the photo carries beyond its EXIF orientation", async () => {
    const photo = rawPhoto("a.NEF");
    photo.rotation = 270;
    photo.exif.orientation = 6;

    await fillCacheEntry(photo, 1);

    expect(h.requests[0]?.turn).toBe(180);
  });
});

describe("fillCacheEntry with a frame the decode turned and cached", () => {
  it("writes the entry the decode built, leaving the frame where it is", async () => {
    const entry = encodeCacheEntry(new Float32Array(2 * 4 * 4), 2, 4, 2048);
    const turned = frame({ width: 2, height: 4, turned: 90, entry });
    h.decode = turned;
    const photo = rawPhoto("a.NEF");
    photo.rotation = 90;

    expect(await fillCacheEntry(photo, 1)).toBe("taken");

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ width: 2, height: 4, entry });
    expect(h.writes[0].data).toBe(turned.data);
  });
});
