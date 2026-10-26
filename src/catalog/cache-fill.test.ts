// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One photo's unit of cache work, as the cache pass and Develop's completion
// of an old entry run it. The decoder, the colour check and the cache are
// faked; what is decoded, marked and written, and the answer, are under test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RawFloatImage } from "@/raw/decode";
import type { CatalogPhoto } from "./types";

type Decode = RawFloatImage | { failure: "unsupported" | "transient" };
const decoded = (): RawFloatImage => ({ data: new Float32Array(4).fill(0.5), width: 1, height: 1, oriented: true });

const h = vi.hoisted(() => ({
  decodes: [] as { background?: boolean; signal?: AbortSignal }[],
  decodeResult: (): Promise<Decode> => Promise.resolve({ data: new Float32Array(4).fill(0.5), width: 1, height: 1, oriented: true }),
  verdict: { use: true, cache: true } as { use: boolean; cache: boolean; exposure?: number },
  takes: true,
  /** The catalog's photos as the store holds them, and the records stored. */
  catalog: [] as CatalogPhoto[],
  saved: [] as CatalogPhoto[],
  /** Writes, as [key, width, height, generation]. */
  writes: [] as [string, number, number, number][],
  marks: [] as [string, string, number][],
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToFloat: (_file: Blob, request?: { background?: boolean; signal?: AbortSignal }) => {
    h.decodes.push(request ?? {});
    return h.decodeResult();
  },
}));

vi.mock("@/raw/accept-decode", () => ({ acceptDecode: async () => h.verdict }));

vi.mock("@/modules/library/raw-preview", () => ({ extractRawPreview: async () => null }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  markDecode: async (key: string, marker: string, begunIn: number) => {
    h.marks.push([key, marker, begunIn]);
  },
  writeCachedPreview: async (key: string, _data: Float32Array, w: number, ht: number, begunIn: number) => {
    h.writes.push([key, w, ht, begunIn]);
    return h.takes;
  },
}));

vi.mock("./storage", () => ({
  catalogStorage: () => ({
    putPhoto: async (photo: CatalogPhoto) => {
      h.saved.push(photo);
    },
  }),
}));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: h.catalog }) },
}));

import { completeCachedEntry, fillCacheEntry } from "./cache-fill";
import { rawPhoto } from "@/modules/library/raw-photo.test-support";

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.decodes = [];
  h.decodeResult = () => Promise.resolve(decoded());
  h.verdict = { use: true, cache: true };
  h.takes = true;
  h.writes = [];
  h.marks = [];
  h.catalog = [];
  h.saved = [];
});

// The cache pass decodes most RAWs before they are first opened, so it learns
// the camera match (camera-match.ts) as Develop's open does.
describe("fillCacheEntry and the camera match", () => {
  it("keeps the match the decode's check found on the photo", async () => {
    h.verdict = { use: true, cache: true, exposure: 1.1 };
    const photo = rawPhoto("a.NEF");
    h.catalog = [photo];
    await fillCacheEntry(photo, 1);
    expect(photo.exif.baselineExposure).toBe(1.1);
    expect(h.saved.map((p) => p.exif.baselineExposure)).toEqual([1.1]);
  });

  it("remembers a decode with no usable preview to match", async () => {
    const photo = rawPhoto("a.NEF");
    h.catalog = [photo];
    await fillCacheEntry(photo, 1);
    expect(photo.exif.baselineExposure).toBeNull();
  });

  it("learns from a decode Develop would show but not cache", async () => {
    h.verdict = { use: true, cache: false, exposure: 0.7 };
    const photo = rawPhoto("a.NEF");
    h.catalog = [photo];
    await fillCacheEntry(photo, 1);
    expect(photo.exif.baselineExposure).toBe(0.7);
  });

  it("learns nothing from a decode it rejects, or for a photo that has its match", async () => {
    const rejected = rawPhoto("a.NEF");
    const matched = rawPhoto("b.NEF");
    matched.exif.baselineExposure = 1.3;
    h.catalog = [rejected, matched];
    h.verdict = { use: false, cache: false };
    await fillCacheEntry(rejected, 1);
    h.verdict = { use: true, cache: true, exposure: 0.4 };
    await fillCacheEntry(matched, 1);
    expect(rejected.exif.baselineExposure).toBeUndefined();
    expect(matched.exif.baselineExposure).toBe(1.3);
    expect(h.saved).toEqual([]);
  });
});

describe("fillCacheEntry", () => {
  it("decodes as background work with the signal and writes the entry under the photo's key in its generation", async () => {
    const signal = new AbortController().signal;
    expect(await fillCacheEntry(rawPhoto("DSC_0001.NEF"), 7, signal)).toBe("taken");
    expect(h.decodes).toEqual([{ background: true, signal }]);
    expect(h.writes).toEqual([["DSC_0001.NEF:64:0", 1, 1, 7]]);
    expect(h.marks).toEqual([]);
  });

  it("says when the cache refused the write", async () => {
    h.takes = false;
    expect(await fillCacheEntry(rawPhoto("a.NEF"), 1)).toBe("refused");
    expect(h.writes).toHaveLength(1);
  });

  it("marks a decode that would fail again and writes nothing", async () => {
    h.decodeResult = () => Promise.resolve({ failure: "unsupported" });
    expect(await fillCacheEntry(rawPhoto("a.NEF"), 3)).toBe("nothing");
    expect(h.marks).toEqual([["a.NEF:64:0", "unsupported", 3]]);
    expect(h.writes).toEqual([]);
  });

  it("marks nothing for a failure that may not recur", async () => {
    h.decodeResult = () => Promise.resolve({ failure: "transient" });
    expect(await fillCacheEntry(rawPhoto("a.NEF"), 3)).toBe("nothing");
    expect(h.marks).toEqual([]);
  });

  it("marks a rejected decode unsupported and a marginal one suspicious, writing neither", async () => {
    h.verdict = { use: false, cache: false };
    expect(await fillCacheEntry(rawPhoto("a.NEF"), 1)).toBe("nothing");
    h.verdict = { use: true, cache: false };
    expect(await fillCacheEntry(rawPhoto("b.NEF"), 1)).toBe("nothing");
    expect(h.marks).toEqual([["a.NEF:64:0", "unsupported", 1], ["b.NEF:64:0", "suspicious", 1]]);
    expect(h.writes).toEqual([]);
  });

  it("does nothing for a photo without a file", async () => {
    expect(await fillCacheEntry(rawPhoto("a.NEF", { fileHandle: null }), 1)).toBe("nothing");
    expect(h.decodes).toEqual([]);
  });

  it("writes nothing once the project is left during the decode", async () => {
    let finish = (_: Decode) => {};
    h.decodeResult = () => new Promise<Decode>((r) => (finish = r));
    const ctrl = new AbortController();
    const result = fillCacheEntry(rawPhoto("a.NEF"), 1, ctrl.signal);
    await settle();
    ctrl.abort();
    finish(decoded());
    expect(await result).toBe("nothing");
    expect(h.writes).toEqual([]);
  });
});

describe("completeCachedEntry", () => {
  it("returns at once and runs one completion at a time", async () => {
    let finish = (_: Decode) => {};
    h.decodeResult = () => new Promise<Decode>((r) => (finish = r));
    completeCachedEntry(rawPhoto("a.NEF"), 1);
    completeCachedEntry(rawPhoto("b.NEF"), 1);
    await settle();
    expect(h.decodes).toHaveLength(1);
    finish(decoded());
    await settle();
    expect(h.writes).toEqual([["a.NEF:64:0", 1, 1, 1]]);
    completeCachedEntry(rawPhoto("c.NEF"), 1);
    await settle();
    expect(h.decodes).toHaveLength(2);
    // Let the last completion end: the one-at-a-time flag is module state.
    finish(decoded());
    await settle();
  });

  it("lets a failed completion go and takes the next", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.decodeResult = () => Promise.reject(new Error("decoder lost"));
    completeCachedEntry(rawPhoto("a.NEF"), 1);
    await settle();
    h.decodeResult = () => Promise.resolve(decoded());
    completeCachedEntry(rawPhoto("b.NEF"), 1);
    await settle();
    expect(h.writes).toEqual([["b.NEF:64:0", 1, 1, 1]]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
