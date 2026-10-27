// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One photo's unit of cache work, as the cache pass and Develop's completion
// of an old entry run it. The decoder, the colour check and the cache are
// faked; what is decoded, marked and written, and the answer, are under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawFloatImage } from "@/raw/decode";
import type { CatalogPhoto } from "./types";

type Decode = RawFloatImage | { failure: "unsupported" | "transient" };
const decoded = (): RawFloatImage => ({ data: new Float32Array(4).fill(0.5), width: 1, height: 1, oriented: true });

const h = vi.hoisted(() => ({
  decodes: [] as { background?: boolean; signal?: AbortSignal }[],
  /** The name of the file each decode was for, in order. */
  decodedFiles: [] as string[],
  decodeResult: (): Promise<Decode> => Promise.resolve({ data: new Float32Array(4).fill(0.5), width: 1, height: 1, oriented: true }),
  verdict: { use: true, cache: true } as { use: boolean; cache: boolean; match?: { exposure: number; shadows: number } },
  takes: true,
  /** The cache's generation as it stands, and what happens inside a write. */
  generation: 0,
  duringWrite: () => {},
  /** The catalog's photos as the store holds them, and the records stored. */
  catalog: [] as CatalogPhoto[],
  saved: [] as CatalogPhoto[],
  /** Writes, as [key, width, height, generation]. */
  writes: [] as [string, number, number, number][],
  marks: [] as [string, string, number][],
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToFloat: (file: Blob, request?: { background?: boolean; signal?: AbortSignal }) => {
    h.decodes.push(request ?? {});
    h.decodedFiles.push(file instanceof File ? file.name : "");
    return h.decodeResult();
  },
}));

vi.mock("@/raw/accept-decode", () => ({ acceptDecode: async () => h.verdict }));

vi.mock("@/modules/library/raw-preview", () => ({ extractRawPreview: async () => null }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => h.generation,
  markDecode: async (key: string, marker: string, begunIn: number) => {
    h.marks.push([key, marker, begunIn]);
  },
  writeCachedPreview: async (key: string, _data: Float32Array, w: number, ht: number, begunIn: number) => {
    h.writes.push([key, w, ht, begunIn]);
    h.duringWrite();
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
import { onCacheEntryFilled, type FilledEntry } from "./cache-events";
import { cutSourceSample } from "@/rendering/source-sample";

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.decodes = [];
  h.decodedFiles = [];
  h.decodeResult = () => Promise.resolve(decoded());
  h.verdict = { use: true, cache: true };
  h.takes = true;
  h.generation = 0;
  h.duringWrite = () => {};
  h.writes = [];
  h.marks = [];
  h.catalog = [];
  h.saved = [];
});

// The cache pass decodes most RAWs before they are first opened, so it learns
// the camera match (camera-match.ts) as Develop's open does.
describe("fillCacheEntry and the camera match", () => {
  it("keeps the match the decode's check found on the photo", async () => {
    h.verdict = { use: true, cache: true, match: { exposure: 1.1, shadows: 55 } };
    const photo = rawPhoto("a.NEF");
    h.catalog = [photo];
    await fillCacheEntry(photo, 1);
    expect(photo.exif).toMatchObject({ baselineExposure: 1.1, baselineShadows: 55 });
    expect(h.saved.map((p) => [p.exif.baselineExposure, p.exif.baselineShadows])).toEqual([[1.1, 55]]);
  });

  it("matches again a photo matched before the shadows lift was learned", async () => {
    h.verdict = { use: true, cache: true, match: { exposure: 1.1, shadows: 55 } };
    const photo = rawPhoto("a.NEF");
    photo.exif.baselineExposure = 1.5;
    h.catalog = [photo];
    await fillCacheEntry(photo, 1);
    expect(photo.exif).toMatchObject({ baselineExposure: 1.1, baselineShadows: 55 });
  });

  it("remembers a decode with no usable preview to match", async () => {
    const photo = rawPhoto("a.NEF");
    h.catalog = [photo];
    await fillCacheEntry(photo, 1);
    expect(photo.exif).toMatchObject({ baselineExposure: null, baselineShadows: null });
  });

  it("learns from a decode Develop would show but not cache", async () => {
    h.verdict = { use: true, cache: false, match: { exposure: 0.7, shadows: 0 } };
    const photo = rawPhoto("a.NEF");
    h.catalog = [photo];
    await fillCacheEntry(photo, 1);
    expect(photo.exif.baselineExposure).toBe(0.7);
  });

  it("learns nothing from a decode it rejects, or for a photo that has its match", async () => {
    const rejected = rawPhoto("a.NEF");
    const matched = rawPhoto("b.NEF");
    matched.exif.baselineExposure = 1.3;
    matched.exif.baselineShadows = 20;
    h.catalog = [rejected, matched];
    h.verdict = { use: false, cache: false };
    await fillCacheEntry(rejected, 1);
    h.verdict = { use: true, cache: true, match: { exposure: 0.4, shadows: 0 } };
    await fillCacheEntry(matched, 1);
    expect(rejected.exif.baselineExposure).toBeUndefined();
    expect(matched.exif).toMatchObject({ baselineExposure: 1.3, baselineShadows: 20 });
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
  // The photo the user went to last is completed next; one asked for between
  // gives way to it.
  it("returns at once, runs one completion at a time and keeps only the newest request waiting", async () => {
    const pending: ((d: Decode) => void)[] = [];
    h.decodeResult = () => new Promise<Decode>((r) => pending.push(r));
    const written = () => h.writes.map(([key]) => key);
    try {
      completeCachedEntry(rawPhoto("a.NEF"), 1);
      completeCachedEntry(rawPhoto("b.NEF"), 1);
      completeCachedEntry(rawPhoto("c.NEF"), 1);
      await settle();
      expect(h.decodedFiles).toEqual(["a.NEF"]);

      pending.shift()?.(decoded());
      await settle();
      expect(written()).toEqual(["a.NEF:64:0"]);
      expect(h.decodedFiles).toEqual(["a.NEF", "c.NEF"]);

      pending.shift()?.(decoded());
      await settle();
      expect(written()).toEqual(["a.NEF:64:0", "c.NEF:64:0"]);
      expect(h.decodedFiles).toEqual(["a.NEF", "c.NEF"]);
    } finally {
      // The running flag and the waiting request are module state, so every
      // decode still pending is let finish before the next test.
      while (pending.length > 0) {
        pending.shift()?.(decoded());
        await settle();
      }
    }
  });

  /** Request the completions in `steps` one by one while the decodes are held,
   *  then let every decode finish; the files decoded, in order. */
  async function decodedFor(steps: [string, number][]): Promise<string[]> {
    const pending: ((d: Decode) => void)[] = [];
    h.decodeResult = () => new Promise<Decode>((r) => pending.push(r));
    for (const [name, generation] of steps) completeCachedEntry(rawPhoto(name), generation);
    await settle();
    while (pending.length > 0) {
      pending.shift()?.(decoded());
      await settle();
    }
    return h.decodedFiles;
  }

  // Shown again while its own rewrite runs (back from the Library, or from the
  // next photo), a photo asks again; a second decode would write the same entry
  // and push the photo waiting out of its place.
  it("ignores a request for the photo it is completing, and the photo waiting keeps its place", async () => {
    expect(await decodedFor([["a.NEF", 1], ["b.NEF", 1], ["a.NEF", 1]])).toEqual(["a.NEF", "b.NEF"]);
  });

  it("completes the photo waiting once, however often it is asked for", async () => {
    expect(await decodedFor([["a.NEF", 1], ["b.NEF", 1], ["b.NEF", 1]])).toEqual(["a.NEF", "b.NEF"]);
  });

  // The same name in another project is another photo's entry.
  it("completes the same photo again when it is asked for in another project", async () => {
    expect(await decodedFor([["a.NEF", 1], ["a.NEF", 2]])).toEqual(["a.NEF", "a.NEF"]);
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

// A Develop view still holding the photo from the entry as it was takes the
// decoded size and the sample as soon as the rewrite lands (cache-events.ts).
describe("the entry announced after a fill", () => {
  /** A 2 × 1 frame, so its size and its sample are told apart from a 1 × 1 one. */
  const frame = (): RawFloatImage => ({
    data: new Float32Array(8).map((_, i) => i / 8),
    width: 2,
    height: 1,
    oriented: true,
  });
  type Heard = Omit<FilledEntry, "cutSample"> & { sample: ReturnType<FilledEntry["cutSample"]> };
  let heard: Heard[] = [];
  let off = () => {};

  beforeEach(() => {
    heard = [];
    off = onCacheEntryFilled(({ cutSample, ...rest }) => heard.push({ ...rest, sample: cutSample() }));
    h.decodeResult = () => Promise.resolve(frame());
  });

  afterEach(() => off());

  it("announces a taken write with the photo, the frame's size and its centre sample", async () => {
    const photo = rawPhoto("DSC_0001.NEF");

    expect(await fillCacheEntry(photo, 0)).toBe("taken");

    expect(heard).toEqual([
      { photo, fullWidth: 2, fullHeight: 1, sample: cutSourceSample(frame().data, 2, 1) },
    ]);
  });

  it("announces nothing for a write the cache refused", async () => {
    h.takes = false;
    expect(await fillCacheEntry(rawPhoto("a.NEF"), 0)).toBe("refused");
    expect(heard).toEqual([]);
  });

  it("announces nothing for a failed, a rejected or a marginal decode", async () => {
    h.decodeResult = () => Promise.resolve({ failure: "unsupported" });
    await fillCacheEntry(rawPhoto("a.NEF"), 0);
    h.decodeResult = () => Promise.resolve(frame());
    h.verdict = { use: false, cache: false };
    await fillCacheEntry(rawPhoto("b.NEF"), 0);
    h.verdict = { use: true, cache: false };
    await fillCacheEntry(rawPhoto("c.NEF"), 0);

    expect(heard).toEqual([]);
  });

  it("announces nothing once the work is abandoned", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await fillCacheEntry(rawPhoto("a.NEF"), 0, ctrl.signal)).toBe("nothing");
    expect(heard).toEqual([]);
  });

  // The write is dropped once the project changes, and still answers true.
  it("announces nothing for a write during which the project changed", async () => {
    h.duringWrite = () => {
      h.generation = 1;
    };
    await fillCacheEntry(rawPhoto("a.NEF"), 0);
    expect(heard).toEqual([]);
  });

  it("announces a completion behind an open the same way", async () => {
    const photo = rawPhoto("DSC_0002.NEF");
    completeCachedEntry(photo, 0);
    await settle();
    expect(heard.map((e) => [e.photo, e.fullWidth, e.fullHeight])).toEqual([[photo, 2, 1]]);
  });
});
