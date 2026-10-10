// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop's part in remembering a RAW the decoder can't use: it marks one whose
// decode failed for good or was rejected, never one that failed in passing or
// was abandoned, and opens a marked one straight from the camera's preview. A
// suspicious decode is still shown; its marker only keeps the background pass
// away. The cache, the decoder and the preview extractor are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { DecodeFailure, RawFloatImage } from "@/raw/decode";

interface CachedEntry {
  data: Uint16Array;
  width: number;
  height: number;
}

const h = vi.hoisted(() => ({
  cached: null as CachedEntry | null,
  generation: 4,
  /** The cache keys that carry an "unsupported" marker. */
  marked: new Set<string>(),
  /** Each marker lookup, as "kind key". */
  lookups: [] as string[],
  /** Each marker stored, as [key, kind, the generation it carried]. */
  marks: [] as [string, string, number][],
  decodes: 0,
  decodeResult: (_signal?: AbortSignal): RawFloatImage | DecodeFailure => ({
    failure: "unsupported",
  }),
  verdict: { use: true, cache: true },
  preview: null as Blob | null,
  /** Each blob handed to the image decoder. */
  imageDecodes: [] as Blob[],
  /** What the cache read waits on before it answers. */
  readGate: Promise.resolve(),
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => true }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => h.generation,
  readCachedPreview: async () => {
    await h.readGate;
    return h.cached;
  },
  writeCachedPreview: async () => {},
  hasDecodeMarker: async (key: string, kind: string) => {
    h.lookups.push(`${kind} ${key}`);
    return kind === "unsupported" && h.marked.has(key);
  },
  markDecode: async (key: string, kind: string, begunIn: number) => {
    h.marks.push([key, kind, begunIn]);
  },
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async (_file: Blob, request?: { signal?: AbortSignal }) => {
    h.decodes++;
    return h.decodeResult(request?.signal);
  },
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async (decode: { suspicious?: boolean }) => ({
    use: h.verdict.use,
    cache: h.verdict.cache && !decode.suspicious,
  }),
}));

vi.mock("@/modules/library/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/raw-preview")>()),
  extractRawPreview: async () => h.preview,
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

const KEY = "DSC00001.ARW:8:0";
const embeddedJpeg = new Blob(["jpeg"], { type: "image/jpeg" });

function floatDecode(extra: Partial<RawFloatImage> = {}): RawFloatImage {
  return {
    data: new Float32Array(4 * 2 * 4).fill(0.18),
    width: 4,
    height: 2,
    oriented: true,
    ...extra,
  };
}

function photo(name = "DSC00001.ARW"): CatalogPhoto {
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
  h.cached = null;
  h.generation = 4;
  h.marked = new Set();
  h.lookups = [];
  h.marks = [];
  h.decodes = 0;
  h.decodeResult = () => ({ failure: "unsupported" });
  h.verdict = { use: true, cache: true };
  h.preview = null;
  h.imageDecodes = [];
  h.readGate = Promise.resolve();
  vi.stubGlobal("createImageBitmap", async (src: Blob): Promise<ImageBitmap> => {
    h.imageDecodes.push(src);
    return { width: 6000, height: 4000, close() {} } as ImageBitmap;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadPhotoImage for a RAW marked unsupported", () => {
  beforeEach(() => {
    h.marked.add(KEY);
    h.preview = embeddedJpeg;
  });

  it("opens the camera's preview without decoding", async () => {
    const image = await loadPhotoImage(photo());

    expect(h.lookups).toEqual([`unsupported ${KEY}`]);
    expect(h.decodes).toBe(0);
    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 6000, height: 4000 } });
    expect(h.imageDecodes).toContain(embeddedJpeg);
  });

  it("prefers a smaller cached preview to the camera's", async () => {
    h.cached = { data: new Uint16Array(2 * 1 * 4), width: 2, height: 1 };

    const image = await loadPhotoImage(photo(), { minEdge: Infinity });

    expect(h.decodes).toBe(0);
    expect(image).toMatchObject({ kind: "float16", width: 2, height: 1 });
  });

  it("stores no second marker", async () => {
    await loadPhotoImage(photo());

    expect(h.marks).toEqual([]);
  });
});

describe("loadPhotoImage looking for a marker", () => {
  // A miss then costs no extra round trip to the cache worker.
  it("asks for the marker while the cache read is still out", async () => {
    let answerRead = (): void => {};
    h.readGate = new Promise<void>((resolve) => {
      answerRead = resolve;
    });

    const opening = loadPhotoImage(photo());
    const askedBeforeTheRead = [...h.lookups];
    answerRead();
    await opening;

    expect(askedBeforeTheRead).toEqual([`unsupported ${KEY}`]);
    expect(h.lookups).toEqual([`unsupported ${KEY}`]);
  });

  it("serves a cache hit whatever the marker says", async () => {
    h.marked.add(KEY);
    h.cached = { data: new Uint16Array(4 * 2 * 4), width: 4, height: 2 };

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({ kind: "float16", width: 4, height: 2 });
    expect(h.decodes).toBe(0);
  });

  it("doesn't look for a photo that isn't RAW", async () => {
    await loadPhotoImage(photo("IMG_0001.jpg"));

    expect(h.lookups).toEqual([]);
  });
});

describe("loadPhotoImage marking a RAW after its decode", () => {
  it("marks one the decoder can't use, for the project the load began in", async () => {
    const opening = loadPhotoImage(photo());
    h.generation = 5;
    await opening;

    expect(h.marks).toEqual([[KEY, "unsupported", 4]]);
  });

  it("marks one whose colours were rejected", async () => {
    h.decodeResult = () => floatDecode();
    h.verdict = { use: false, cache: false };

    await loadPhotoImage(photo());

    expect(h.marks).toEqual([[KEY, "unsupported", 4]]);
  });

  it("shows a suspicious decode and marks it for the background pass only", async () => {
    h.decodeResult = () => floatDecode({ suspicious: true });

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
    expect(h.marks).toEqual([[KEY, "suspicious", 4]]);
  });

  it("marks nothing for a decode it accepts", async () => {
    h.decodeResult = () => floatDecode();

    await loadPhotoImage(photo());

    expect(h.marks).toEqual([]);
  });

  it("marks nothing when the decoder was unavailable", async () => {
    h.decodeResult = () => ({ failure: "transient" });

    await loadPhotoImage(photo());

    expect(h.marks).toEqual([]);
  });

  it("marks nothing for an abandoned open, whatever its decode answered", async () => {
    const opened = new AbortController();
    h.decodeResult = () => {
      opened.abort();
      return { failure: "unsupported" };
    };

    await loadPhotoImage(photo(), { signal: opened.signal });

    expect(h.marks).toEqual([]);
  });
});

// Develop keeps a camera preview on the GPU under the photo's key only when decoding the
// RAW again can't help, and says why it shows one: the load tells it what it fell back on.
describe("loadPhotoImage telling what it fell back on", () => {
  beforeEach(() => {
    h.preview = embeddedJpeg;
  });

  it("tags the camera's preview of a RAW marked unsupported", async () => {
    h.marked.add(KEY);

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({
      kind: "bitmap",
      fallback: { from: "embedded", unsupported: true, timedOut: false },
    });
  });

  it("tags it with the decoder's reason when the decoder can't use the RAW", async () => {
    h.decodeResult = () => ({ failure: "unsupported", reason: "Unsupported file format" });

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({
      fallback: {
        from: "embedded",
        unsupported: true,
        timedOut: false,
        reason: "Unsupported file format",
      },
    });
  });

  it("tags it as unsupported when the decode's colours were rejected", async () => {
    h.decodeResult = () => floatDecode();
    h.verdict = { use: false, cache: false };

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({ fallback: { from: "embedded", unsupported: true } });
  });

  it("tags it as timed out, not unsupported, when libraw gave no answer", async () => {
    h.decodeResult = () => ({ failure: "transient", timedOut: true, reason: "no answer in 60 s" });

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({
      fallback: {
        from: "embedded",
        unsupported: false,
        timedOut: true,
        reason: "no answer in 60 s",
      },
    });
  });

  it("tags it as neither when the decode failed for now", async () => {
    h.decodeResult = () => ({ failure: "transient", reason: "couldn't read the file" });

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({
      fallback: { from: "embedded", unsupported: false, timedOut: false },
    });
  });

  // The decoder passes over a background request for a file it is decoding already, or
  // that gave no answer earlier in the session. Served in its place, the camera's preview
  // would stand for the photo where the request keeps it: Develop's neighbour on the GPU,
  // the edited thumbnail's source.
  describe("for a background load the decoder passed over", () => {
    const passedOver = {
      failure: "transient" as const,
      reason: "being decoded already",
      passedOver: true,
    };

    beforeEach(() => {
      h.decodeResult = () => passedOver;
    });

    it("resolves null, without the camera's preview", async () => {
      const image = await loadPhotoImage(photo(), { background: true });

      expect(image).toBeNull();
      expect(h.imageDecodes).not.toContain(embeddedJpeg);
    });

    it("marks nothing", async () => {
      await loadPhotoImage(photo(), { background: true });

      expect(h.marks).toEqual([]);
    });
  });

  it("tags nothing on a full decode", async () => {
    h.decodeResult = () => floatDecode();

    const image = await loadPhotoImage(photo());

    expect(image).toMatchObject({ kind: "float" });
    expect(image).not.toHaveProperty("fallback");
  });
});
