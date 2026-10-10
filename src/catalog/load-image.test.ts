// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How a RAW reaches the renderer. The develop-preview cache stores scene-linear
// half floats, so a hit must be tagged as such for the renderer to take the
// same path as a fresh float decode, and it must not wait on the original. On a
// miss the full decode and the embedded-preview extraction run side by side.
// The cache, the decoder and the preview extractor are faked; only the
// hand-offs and their order are under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";
import type { RawFloatImage } from "@/raw/decode";
import type { DecodeVerdict } from "@/raw/accept-decode";
import type { DecodedImage } from "./load-image";

interface CachedEntry {
  data: Uint16Array;
  width: number;
  height: number;
}

const h = vi.hoisted(() => ({
  cached: null as CachedEntry | null,
  cacheReads: 0,
  /** Entries handed to writeCachedPreview, as [key, width, height]. */
  cacheWrites: [] as [string, number, number][],
  permission: true,
  /** How many times an original was read through its file handle. */
  fileReads: 0,
  /** Whether each full decode was asked for as background work, in order. */
  decodes: [] as (boolean | undefined)[],
  decodeResult: (): Promise<RawFloatImage | null> => Promise.resolve(null),
  previewResult: (): Promise<Blob | null> => Promise.resolve(null),
  saved: [] as CatalogPhoto[],
  /** The catalog's photos as the store holds them when a decode finishes. */
  catalog: [] as CatalogPhoto[],
  /** How many times the 8-bit RAW decode (the bitmap path) ran. */
  bitmapDecodes: 0,
  /** What the 8-bit RAW decode returns. */
  bitmapDecodeResult: (): Promise<{ bitmap: ImageBitmap; oriented: boolean } | null> =>
    Promise.resolve(null),
  /** What the netpbm and TIFF decoders return. */
  plainResult: (): Promise<ImageBitmap | null> => Promise.resolve(null),
  /** Which of those two decoders ran, in order. */
  plainDecoders: [] as string[],
  /** Each blob handed to the image decoder, with the orientation it asked for. */
  bitmapRequests: [] as { src: Blob; imageOrientation?: string }[],
  /** The clockwise degrees of every bitmap turned through the canvas. */
  turns: [] as number[],
  /** A ruling to impose on the accept/reject check; null runs the real one. */
  verdict: null as DecodeVerdict | null,
  /** What that check was asked to judge, in order. */
  judged: [] as {
    suspicious: boolean | undefined;
    size: [number, number];
    preview: Blob | null;
  }[],
}));

vi.mock("./permissions", () => ({ verifyPermission: async () => h.permission }));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async () => {
    h.cacheReads++;
    return h.cached;
  },
  writeCachedPreview: async (key: string, _data: Float32Array, w: number, ht: number) => {
    h.cacheWrites.push([key, w, ht]);
  },
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: () => {
    h.bitmapDecodes++;
    return h.bitmapDecodeResult();
  },
  decodeRawToFloat: (_file: Blob, priority?: { background?: boolean }) => {
    h.decodes.push(priority?.background);
    return h.decodeResult();
  },
}));

// Every test runs the real colour check unless it imposes a ruling.
vi.mock("@/raw/accept-decode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/raw/accept-decode")>();
  return {
    ...actual,
    acceptDecode: (
      decode: Parameters<typeof actual.acceptDecode>[0],
      upright: Parameters<typeof actual.acceptDecode>[1],
      preview: Blob | null,
    ) => {
      h.judged.push({
        suspicious: decode.suspicious,
        size: [upright.width, upright.height],
        preview,
      });
      return h.verdict ? Promise.resolve(h.verdict) : actual.acceptDecode(decode, upright, preview);
    },
  };
});

vi.mock("@/modules/library/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/raw-preview")>()),
  extractRawPreview: () => h.previewResult(),
}));

vi.mock("@/modules/library/netpbm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/netpbm")>()),
  decodeNetpbm: () => {
    h.plainDecoders.push("netpbm");
    return h.plainResult();
  },
}));

vi.mock("@/modules/library/tiff-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/tiff-image")>()),
  decodeTiff: () => {
    h.plainDecoders.push("tiff");
    return h.plainResult();
  },
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheMaxEdge: 3072 }),
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

import { loadPhotoBitmap, loadPhotoImage } from "./load-image";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Resolve after every already-queued microtask chain has run to completion. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function bitmapOf(width: number, height: number): ImageBitmap {
  return { width, height, close() {} } as unknown as ImageBitmap;
}

interface TrackedBitmap extends ImageBitmap {
  closed: boolean;
}

/** A bitmap that remembers whether it was closed. */
function trackedBitmap(width: number, height: number): TrackedBitmap {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

const embeddedJpeg = new Blob(["jpeg"], { type: "image/jpeg" });

function floatDecode(over: Partial<RawFloatImage> = {}): RawFloatImage {
  return {
    data: new Float32Array(4 * 2 * 4).fill(0.18),
    width: 4,
    height: 2,
    oriented: true,
    ...over,
  };
}

/** A 4x2 decode whose red channel counts its pixels 0..7, row by row. */
function rampDecode(over: Partial<RawFloatImage> = {}): RawFloatImage {
  const data = new Float32Array(4 * 2 * 4);
  for (let px = 0; px < 8; px++) data[px * 4] = px;
  return floatDecode({ data, ...over });
}

const redChannel = (data: Float32Array): number[] =>
  Array.from({ length: data.length / 4 }, (_, px) => data[px * 4]);

function asFloat(
  image: DecodedImage | null,
): Extract<DecodedImage, { kind: "float" }> {
  if (image?.kind !== "float") throw new Error(`expected a float image, got ${image?.kind}`);
  return image;
}

/** Stands in for the OffscreenCanvas rotateBitmap draws on. */
class TurnedCanvas {
  turnedBy = 0;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return {
      translate: () => {},
      rotate: (radians: number) => {
        this.turnedBy = Math.round((radians * 180) / Math.PI);
      },
      drawImage: () => {},
    };
  }
}

/** Fakes the image decoder: `decode` answers every blob; a turned canvas comes
 *  back at its own size, with its turn recorded. */
function stubBitmapDecoder(
  decode: (src: Blob) => ImageBitmap | Promise<ImageBitmap>,
): void {
  vi.stubGlobal("OffscreenCanvas", TurnedCanvas);
  vi.stubGlobal(
    "createImageBitmap",
    async (src: Blob | TurnedCanvas, opts?: ImageBitmapOptions) => {
      if (src instanceof TurnedCanvas) {
        h.turns.push(src.turnedBy);
        return bitmapOf(src.width, src.height);
      }
      if (opts?.resizeWidth) throw new Error("no image decoder");
      h.bitmapRequests.push({ src, imageOrientation: opts?.imageOrientation });
      return decode(src);
    },
  );
}

function photoOf(name: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  const file = new File([new Uint8Array(8)], name);
  const fileHandle = {
    kind: "file",
    name,
    getFile: async () => {
      h.fileReads++;
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

const rawPhoto = (over: Partial<CatalogPhoto> = {}): CatalogPhoto =>
  photoOf("DSCF0001.RAF", over);

/** A handle whose original can't be read. */
function unreadable(name: string): FileSystemFileHandle {
  return {
    kind: "file",
    name,
    getFile: async (): Promise<File> => {
      throw new Error("NotReadableError");
    },
  } as FileSystemFileHandle;
}

const storedThumbnail = new Blob(["thumbnail"], { type: "image/jpeg" });

beforeEach(() => {
  h.cached = null;
  h.cacheReads = 0;
  h.cacheWrites = [];
  h.permission = true;
  h.fileReads = 0;
  h.decodes = [];
  h.decodeResult = () => Promise.resolve(null);
  h.previewResult = () => Promise.resolve(null);
  h.saved = [];
  h.catalog = [];
  h.bitmapDecodes = 0;
  h.bitmapDecodeResult = () => Promise.resolve(null);
  h.plainResult = () => Promise.resolve(null);
  h.plainDecoders = [];
  h.bitmapRequests = [];
  h.turns = [];
  h.verdict = null;
  h.judged = [];
  // The colour check's 64 px sample has no decoder here, so it trusts the
  // decode; any other bitmap decode stands in for the embedded preview.
  stubBitmapDecoder((src) =>
    src === storedThumbnail ? bitmapOf(768, 512) : bitmapOf(6000, 4000),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadPhotoImage with a cached develop preview", () => {
  beforeEach(() => {
    h.cached = { data: new Uint16Array(4 * 2 * 4), width: 4, height: 2 };
  });

  it("hands a cache hit over as a float16 source without decoding", async () => {
    const cached = h.cached;
    const image = await loadPhotoImage(rawPhoto());
    expect(image).toEqual({ kind: "float16", ...cached });
    expect(h.decodes).toHaveLength(0);
  });

  it("falls back to the cached preview as float16 when the full decode fails", async () => {
    const cached = h.cached;
    const image = await loadPhotoImage(rawPhoto(), { minEdge: Infinity });
    expect(h.decodes).toHaveLength(1);
    expect(image).toEqual({ kind: "float16", ...cached });
  });

  // In Electron getFile() reads the whole RAW over IPC; the cache key needs
  // only the catalog record.
  it("serves a cache hit without reading the original", async () => {
    await loadPhotoImage(rawPhoto());
    expect(h.fileReads).toBe(0);
  });

  it("serves a cache hit when the original is offline", async () => {
    const cached = h.cached;
    const image = await loadPhotoImage(rawPhoto({ fileHandle: null }));
    expect(image).toEqual({ kind: "float16", ...cached });
  });

  it("serves a cache hit when access to the original was not re-granted", async () => {
    h.permission = false;
    const cached = h.cached;
    const image = await loadPhotoImage(rawPhoto());
    expect(image).toEqual({ kind: "float16", ...cached });
  });

  it("never looks in the RAW cache for a non-RAW photo", async () => {
    await loadPhotoImage(photoOf("IMG_0001.JPG"));
    expect(h.cacheReads).toBe(0);
  });
});

describe("loadPhotoImage on a cache miss", () => {
  it("starts the full decode while the embedded preview is still being extracted", async () => {
    const preview = deferred<Blob | null>();
    h.previewResult = () => preview.promise;

    const loading = loadPhotoImage(rawPhoto());
    await settle();
    expect(h.decodes).toHaveLength(1);

    preview.resolve(null);
    await loading;
  });

  // Develop paints the preview as a stand-in; arriving after the final image
  // it would replace it.
  it("paints the embedded preview before the load resolves, never after", async () => {
    const paint = deferred<ImageBitmap>();
    h.previewResult = () => Promise.resolve(embeddedJpeg);
    h.decodeResult = () => Promise.resolve(floatDecode());
    vi.stubGlobal(
      "createImageBitmap",
      async (_src: Blob, opts?: ImageBitmapOptions) => {
        if (opts?.resizeWidth) throw new Error("no image decoder");
        return paint.promise;
      },
    );
    const events: string[] = [];

    const loading = loadPhotoImage(rawPhoto(), {
      onPreview: () => events.push("preview"),
    }).then((image) => {
      events.push("resolved");
      return image;
    });
    await settle();
    paint.resolve(bitmapOf(6000, 4000));
    const image = await loading;

    expect(events).toEqual(["preview", "resolved"]);
    expect(image?.kind).toBe("float");
  });

  it("decodes as background work only when the load says so", async () => {
    await loadPhotoImage(rawPhoto(), { background: true });
    await loadPhotoImage(rawPhoto());
    expect(h.decodes).toEqual([true, undefined]);
  });

  it("hands a good decode over as float and writes it to the cache", async () => {
    h.previewResult = () => Promise.resolve(embeddedJpeg);
    h.decodeResult = () => Promise.resolve(floatDecode());

    const image = await loadPhotoImage(rawPhoto());

    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
    expect(h.cacheWrites).toEqual([["DSCF0001.RAF:8:0", 4, 2]]);
  });

  it("keeps the as-shot white balance the decode learned", async () => {
    h.decodeResult = () => Promise.resolve(floatDecode({ colorTemperature: 5200 }));
    const photo = rawPhoto();
    h.catalog = [photo];

    await loadPhotoImage(photo);

    expect(photo.exif.colorTemperature).toBe(5200);
    expect(h.saved).toEqual([photo]);
  });

  it("stores what the decode learned on the photo as the catalog has it by then", async () => {
    // A full decode takes seconds; another window may change the photo meanwhile.
    h.decodeResult = () => Promise.resolve(floatDecode({ colorTemperature: 5200 }));
    const photo = rawPhoto();
    h.catalog = [{ ...photo, rating: 4, exif: { lens: "35mm" } }];

    await loadPhotoImage(photo);

    expect(h.saved).toEqual([
      { ...photo, rating: 4, exif: { lens: "35mm", colorTemperature: 5200 } },
    ]);
  });

  it("stores nothing for a photo that left the catalog while it decoded", async () => {
    h.decodeResult = () => Promise.resolve(floatDecode({ colorTemperature: 5200 }));

    await loadPhotoImage(rawPhoto());

    expect(h.saved).toEqual([]);
  });

  it("falls back to the embedded JPEG when the decode fails and nothing is cached", async () => {
    h.previewResult = () => Promise.resolve(embeddedJpeg);

    const image: DecodedImage | null = await loadPhotoImage(rawPhoto());

    expect(image?.kind).toBe("bitmap");
    expect(h.decodes).toHaveLength(1);
  });
});

describe("loadPhotoImage cache writes after a full decode", () => {
  const key = "DSCF0001.RAF:8:0";

  // A marginal decode (inferred dimensions) is shown, but remembering it would
  // pin the bad frame: the next open must decode again.
  it("shows a suspicious decode but never writes it to the cache", async () => {
    h.decodeResult = () => Promise.resolve(floatDecode({ suspicious: true }));

    const image = await loadPhotoImage(rawPhoto());

    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
    expect(h.cacheWrites).toEqual([]);
  });

  it("upgrades a cache entry written below the decode's long edge", async () => {
    h.cached = { data: new Uint16Array(2 * 1 * 4), width: 2, height: 1 };
    h.decodeResult = () => Promise.resolve(floatDecode());

    const image = await loadPhotoImage(rawPhoto(), { minEdge: Infinity });

    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
    expect(h.cacheWrites).toEqual([[key, 4, 2]]);
  });

  it("does not rewrite a cache entry as long as the decode", async () => {
    h.cached = { data: new Uint16Array(4 * 2 * 4), width: 4, height: 2 };
    h.decodeResult = () => Promise.resolve(floatDecode());

    const image = await loadPhotoImage(rawPhoto(), { minEdge: Infinity });

    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
    expect(h.cacheWrites).toEqual([]);
  });

  it("does not rewrite an entry at the preference cap when the decode is larger", async () => {
    h.cached = { data: new Uint16Array(3072 * 1 * 4), width: 3072, height: 1 };
    h.decodeResult = () =>
      Promise.resolve(
        floatDecode({ data: new Float32Array(4000 * 1 * 4), width: 4000, height: 1 }),
      );

    const image = await loadPhotoImage(rawPhoto(), { minEdge: Infinity });

    expect(image).toMatchObject({ kind: "float", width: 4000, height: 1 });
    expect(h.cacheWrites).toEqual([]);
  });

  it("upgrades an entry below the preference cap with the full decode", async () => {
    h.cached = { data: new Uint16Array(2 * 1 * 4), width: 2, height: 1 };
    h.decodeResult = () =>
      Promise.resolve(
        floatDecode({ data: new Float32Array(4000 * 1 * 4), width: 4000, height: 1 }),
      );

    await loadPhotoImage(rawPhoto(), { minEdge: Infinity });

    expect(h.cacheWrites).toEqual([[key, 4000, 1]]);
  });
});

// The ruling itself (suspicious frames, the 2x colour rule) is pinned in
// accept-decode.test.ts and shared with the background pre-decode; here only
// what this load does with each ruling.
describe("loadPhotoImage acting on the decode check's ruling", () => {
  const key = "DSCF0001.RAF:8:0";

  it("judges the decode as turned upright, against the embedded preview", async () => {
    h.verdict = { use: true, cache: true };
    h.previewResult = () => Promise.resolve(embeddedJpeg);
    h.decodeResult = () => Promise.resolve(floatDecode({ oriented: false, suspicious: true }));

    await loadPhotoImage(rawPhoto({ rotation: 90 }));

    expect(h.judged).toEqual([{ suspicious: true, size: [2, 4], preview: embeddedJpeg }]);
  });

  it("judges without a preview when the camera embedded none", async () => {
    h.verdict = { use: true, cache: true };
    h.decodeResult = () => Promise.resolve(floatDecode());

    await loadPhotoImage(rawPhoto());

    expect(h.judged).toEqual([{ suspicious: undefined, size: [4, 2], preview: null }]);
  });

  it("serves the decode and writes it when the ruling allows both", async () => {
    h.verdict = { use: true, cache: true };
    h.decodeResult = () => Promise.resolve(floatDecode());

    const image = await loadPhotoImage(rawPhoto());

    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
    expect(h.cacheWrites).toEqual([[key, 4, 2]]);
  });

  it("serves the decode without writing it when the ruling allows only that", async () => {
    h.verdict = { use: true, cache: false };
    h.decodeResult = () => Promise.resolve(floatDecode());

    const image = await loadPhotoImage(rawPhoto());

    expect(image).toMatchObject({ kind: "float", width: 4, height: 2 });
    expect(h.cacheWrites).toEqual([]);
  });

  describe("when the colours were rejected", () => {
    beforeEach(() => {
      h.verdict = { use: false, cache: false };
      h.previewResult = () => Promise.resolve(embeddedJpeg);
      h.decodeResult = () => Promise.resolve(floatDecode());
    });

    it("serves the cached develop preview as float16 when one exists", async () => {
      h.cached = { data: new Uint16Array(2 * 1 * 4), width: 2, height: 1 };
      const cached = h.cached;

      const image = await loadPhotoImage(rawPhoto(), { minEdge: Infinity });

      expect(image).toEqual({ kind: "float16", ...cached });
      expect(h.cacheWrites).toEqual([]);
    });

    it("serves the embedded preview as a bitmap when nothing is cached", async () => {
      const image = await loadPhotoImage(rawPhoto());

      expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 6000, height: 4000 } });
      expect(h.bitmapRequests.map((r) => r.src)).toEqual([embeddedJpeg]);
      expect(h.cacheWrites).toEqual([]);
    });

    it("does not run the 8-bit RAW decoder or decode a second time", async () => {
      await loadPhotoImage(rawPhoto());

      expect(h.decodes).toHaveLength(1);
      expect(h.bitmapDecodes).toBe(0);
    });
  });
});

describe("loadPhotoImage minEdge against the cached long edge", () => {
  beforeEach(() => {
    h.cached = { data: new Uint16Array(4 * 2 * 4), width: 4, height: 2 };
  });

  it("serves the cache when its long edge equals minEdge", async () => {
    const cached = h.cached;
    const image = await loadPhotoImage(rawPhoto(), { minEdge: 4 });
    expect(image).toEqual({ kind: "float16", ...cached });
    expect(h.decodes).toHaveLength(0);
  });

  it("serves the fresh decode, not the cache, when minEdge is above the cached edge", async () => {
    h.decodeResult = () =>
      Promise.resolve(
        floatDecode({ data: new Float32Array(8 * 4 * 4).fill(0.18), width: 8, height: 4 }),
      );

    const image = await loadPhotoImage(rawPhoto(), { minEdge: 5 });

    expect(image).toMatchObject({ kind: "float", width: 8, height: 4 });
    expect(h.decodes).toHaveLength(1);
    expect(h.cacheWrites).toEqual([["DSCF0001.RAF:8:0", 8, 4]]);
  });
});

describe("loadPhotoImage turning a full decode upright", () => {
  const turnedQuarter = [4, 0, 5, 1, 6, 2, 7, 3];

  it("leaves a decode alone when the photo is not rotated", async () => {
    h.decodeResult = () => Promise.resolve(rampDecode({ oriented: false }));

    const image = asFloat(await loadPhotoImage(rawPhoto()));

    expect([image.width, image.height]).toEqual([4, 2]);
    expect(redChannel(image.data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  // The decoder kept the sensor's orientation, so the photo's whole rotation
  // (EXIF plus manual turns) is still owed.
  it("turns a decode the decoder did not orient by the photo's whole rotation", async () => {
    h.decodeResult = () => Promise.resolve(rampDecode({ oriented: false }));

    const image = asFloat(await loadPhotoImage(rawPhoto({ rotation: 90 })));

    expect([image.width, image.height]).toEqual([2, 4]);
    expect(redChannel(image.data)).toEqual(turnedQuarter);
    expect(h.cacheWrites).toEqual([["DSCF0001.RAF:8:90", 2, 4]]);
  });

  it("does not turn an oriented decode again for the EXIF orientation", async () => {
    h.decodeResult = () => Promise.resolve(rampDecode({ oriented: true }));

    const image = asFloat(
      await loadPhotoImage(rawPhoto({ rotation: 90, exif: { orientation: 6 } })),
    );

    expect([image.width, image.height]).toEqual([4, 2]);
    expect(redChannel(image.data)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("turns an oriented decode by the manual rotation on top of the EXIF turn", async () => {
    h.decodeResult = () => Promise.resolve(rampDecode({ oriented: true }));

    const image = asFloat(
      await loadPhotoImage(rawPhoto({ rotation: 180, exif: { orientation: 6 } })),
    );

    expect([image.width, image.height]).toEqual([2, 4]);
    expect(redChannel(image.data)).toEqual(turnedQuarter);
  });

  it("turns an oriented decode back when the manual rotation undid the EXIF turn", async () => {
    h.decodeResult = () => Promise.resolve(rampDecode({ oriented: true }));

    const image = asFloat(
      await loadPhotoImage(rawPhoto({ rotation: 0, exif: { orientation: 6 } })),
    );

    expect([image.width, image.height]).toEqual([2, 4]);
    expect(redChannel(image.data)).toEqual([3, 7, 2, 6, 1, 5, 0, 4]);
  });
});

describe("loadPhotoImage keeping what the decode learned", () => {
  it("records the exposure bias a Fujifilm DR mode left in the raw", async () => {
    h.decodeResult = () => Promise.resolve(floatDecode({ rawExposureBias: -1 }));
    const photo = rawPhoto();
    h.catalog = [{ ...photo, exif: { lens: "35mm" } }];

    await loadPhotoImage(photo);

    expect(photo.exif.rawExposureBias).toBe(-1);
    expect(h.saved).toEqual([
      { ...photo, exif: { lens: "35mm", rawExposureBias: -1 } },
    ]);
  });

  it("stores a learned white balance and exposure bias in one write", async () => {
    h.decodeResult = () =>
      Promise.resolve(floatDecode({ colorTemperature: 5200, rawExposureBias: -2 }));
    const photo = rawPhoto();
    h.catalog = [{ ...photo, exif: {} }];

    await loadPhotoImage(photo);

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].exif).toEqual({ colorTemperature: 5200, rawExposureBias: -2 });
  });

  it("writes nothing when the photo already has the decode's exposure bias", async () => {
    h.decodeResult = () => Promise.resolve(floatDecode({ rawExposureBias: -1 }));
    const photo = rawPhoto({ exif: { rawExposureBias: -1 } });
    h.catalog = [photo];

    await loadPhotoImage(photo);

    expect(h.saved).toEqual([]);
  });

  it("replaces an exposure bias that differs from the decode's", async () => {
    h.decodeResult = () => Promise.resolve(floatDecode({ rawExposureBias: -2 }));
    const photo = rawPhoto({ exif: { rawExposureBias: -1 } });
    h.catalog = [{ ...photo, exif: { ...photo.exif } }];

    await loadPhotoImage(photo);

    expect(photo.exif.rawExposureBias).toBe(-2);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].exif.rawExposureBias).toBe(-2);
  });

  it("keeps an as-shot temperature the photo already has", async () => {
    h.decodeResult = () => Promise.resolve(floatDecode({ colorTemperature: 5200 }));
    const photo = rawPhoto({ exif: { colorTemperature: 4000 } });
    h.catalog = [photo];

    await loadPhotoImage(photo);

    expect(photo.exif.colorTemperature).toBe(4000);
    expect(h.saved).toEqual([]);
  });
});

describe("loadPhotoImage when the RAW can't be decoded", () => {
  it("serves the stored thumbnail when the original can't be read", async () => {
    const photo = rawPhoto({
      fileHandle: unreadable("DSCF0001.RAF"),
      thumbnailBlob: storedThumbnail,
    });

    const image = await loadPhotoImage(photo);

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 768, height: 512 } });
    expect(h.decodes).toHaveLength(0);
  });

  it("returns null when the original can't be read and no thumbnail is stored", async () => {
    const photo = rawPhoto({ fileHandle: unreadable("DSCF0001.RAF") });
    expect(await loadPhotoImage(photo)).toBeNull();
  });

  it("hands over to the 8-bit RAW decoder when the decode and preview are empty", async () => {
    h.bitmapDecodeResult = () =>
      Promise.resolve({ bitmap: bitmapOf(5000, 3000), oriented: true });

    const image = await loadPhotoImage(rawPhoto());

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 5000, height: 3000 } });
    expect(h.decodes).toHaveLength(1);
  });

  it("serves the stored thumbnail when the 8-bit decoder has nothing either", async () => {
    const image = await loadPhotoImage(rawPhoto({ thumbnailBlob: storedThumbnail }));
    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 768, height: 512 } });
  });

  it("returns null when nothing can decode the RAW and no thumbnail is stored", async () => {
    expect(await loadPhotoImage(rawPhoto())).toBeNull();
  });

  it("turns the embedded JPEG fallback upright from the EXIF orientation", async () => {
    h.previewResult = () => Promise.resolve(embeddedJpeg);

    const image = await loadPhotoImage(
      rawPhoto({ rotation: 90, exif: { orientation: 6 } }),
    );

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 4000, height: 6000 } });
    expect(h.turns).toEqual([90]);
    expect(h.bitmapRequests[0].src).toBe(embeddedJpeg);
    expect(h.bitmapRequests[0].imageOrientation).toBe("none");
  });

  // The fallback uses the preview already extracted; going on to the bitmap
  // decoder would read the original and run libraw a second time.
  it("serves the embedded JPEG without a second read or decode of the RAW", async () => {
    h.previewResult = () => Promise.resolve(embeddedJpeg);

    await loadPhotoImage(rawPhoto());

    expect(h.fileReads).toBe(1);
    expect(h.bitmapDecodes).toBe(0);
  });

  it("leaves an embedded JPEG fallback the camera already stored upright", async () => {
    h.previewResult = () => Promise.resolve(embeddedJpeg);
    const portrait = trackedBitmap(4000, 6000);
    stubBitmapDecoder(() => portrait);

    const image = await loadPhotoImage(
      rawPhoto({ rotation: 90, exif: { orientation: 6 } }),
    );

    expect(image).toEqual({
      kind: "bitmap",
      bitmap: portrait,
      fallback: { from: "embedded", offline: false, unsupported: false, timedOut: false },
    });
    expect(h.turns).toEqual([]);
    expect(portrait.closed).toBe(false);
  });
});

describe("loadPhotoImage for a photo that is not a RAW", () => {
  it("decodes a JPEG without applying its own orientation", async () => {
    const image = await loadPhotoImage(photoOf("IMG_0001.JPG"));

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 6000, height: 4000 } });
    const [request] = h.bitmapRequests;
    expect(request.imageOrientation).toBe("none");
    expect(request.src instanceof File && request.src.name).toBe("IMG_0001.JPG");
    expect(h.decodes).toHaveLength(0);
    expect(h.plainDecoders).toEqual([]);
  });

  it("turns a JPEG by the photo's rotation", async () => {
    const image = await loadPhotoImage(photoOf("IMG_0001.JPG", { rotation: 90 }));

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 4000, height: 6000 } });
    expect(h.turns).toEqual([90]);
  });

  it("decodes a TIFF through the TIFF decoder", async () => {
    h.plainResult = () => Promise.resolve(bitmapOf(3000, 2000));

    const image = await loadPhotoImage(photoOf("SCAN.TIF"));

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 3000, height: 2000 } });
    expect(h.plainDecoders).toEqual(["tiff"]);
    expect(h.bitmapRequests).toEqual([]);
    expect(h.decodes).toHaveLength(0);
  });

  it("decodes a netpbm file through the netpbm decoder", async () => {
    h.plainResult = () => Promise.resolve(bitmapOf(640, 480));

    const image = await loadPhotoImage(photoOf("LOGO.PPM"));

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 640, height: 480 } });
    expect(h.plainDecoders).toEqual(["netpbm"]);
    expect(h.bitmapRequests).toEqual([]);
    expect(h.decodes).toHaveLength(0);
  });

  it("serves the stored thumbnail when the TIFF decoder can't read the file", async () => {
    const image = await loadPhotoImage(
      photoOf("SCAN.TIF", { thumbnailBlob: storedThumbnail }),
    );

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 768, height: 512 } });
    expect(h.plainDecoders).toEqual(["tiff"]);
  });

  it("serves the stored thumbnail when the original JPEG won't decode", async () => {
    stubBitmapDecoder((src) => {
      if (src === storedThumbnail) return bitmapOf(768, 512);
      throw new Error("corrupt JPEG");
    });

    const image = await loadPhotoImage(
      photoOf("IMG_0001.JPG", { thumbnailBlob: storedThumbnail }),
    );

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 768, height: 512 } });
  });
});

// Develop shows a fallback as a preview, and never keeps it on the GPU under the
// photo's key unless decoding again can't help: the load says what it fell back on.
describe("loadPhotoImage telling the stored thumbnail from the photo's own pixels", () => {
  const offline = { offline: true, unsupported: false, timedOut: false };

  it.each([
    ["a RAW", "DSCF0001.RAF"],
    ["a JPEG", "IMG_0001.JPG"],
  ])("tags the stored thumbnail of %s whose original can't be read", async (_label, name) => {
    const photo = photoOf(name, { fileHandle: unreadable(name), thumbnailBlob: storedThumbnail });

    const image = await loadPhotoImage(photo);

    expect(image).toMatchObject({ kind: "bitmap", fallback: { from: "stored", ...offline } });
  });

  it("tags the stored thumbnail when access to the original was not re-granted", async () => {
    h.permission = false;

    const image = await loadPhotoImage(photoOf("IMG_0001.JPG", { thumbnailBlob: storedThumbnail }));

    expect(image).toMatchObject({ fallback: { from: "stored", ...offline } });
  });

  it("tags it when the photo has no handle on its original at all", async () => {
    const image = await loadPhotoImage(
      photoOf("IMG_0001.JPG", { fileHandle: null, thumbnailBlob: storedThumbnail }),
    );

    expect(image).toMatchObject({ fallback: { from: "stored", ...offline } });
  });

  // An edited photo's stored preview is rendered with the edit its previewEdit names:
  // Develop must never render that edit over it again.
  it("tags an edited photo's stored preview as edited", async () => {
    const photo = photoOf("IMG_0001.JPG", {
      fileHandle: unreadable("IMG_0001.JPG"),
      thumbnailBlob: storedThumbnail,
      previewEdit: "edit-1",
    });

    const image = await loadPhotoImage(photo);

    expect(image).toMatchObject({ fallback: { from: "stored-edited", ...offline } });
  });

  it("tags nothing on a JPEG decoded from its original", async () => {
    const image = await loadPhotoImage(
      photoOf("IMG_0001.JPG", { thumbnailBlob: storedThumbnail }),
    );

    expect(image).toMatchObject({ kind: "bitmap", bitmap: { width: 6000, height: 4000 } });
    expect(image).not.toHaveProperty("fallback");
  });

  it("tags the stored thumbnail of a RAW nothing could decode, its original read", async () => {
    const image = await loadPhotoImage(rawPhoto({ thumbnailBlob: storedThumbnail }));

    expect(image).toMatchObject({ fallback: { from: "stored", ...offline, offline: false } });
  });
});

describe("loadPhotoBitmap for a RAW the bitmap decoder handles", () => {
  it("keeps an oriented bitmap as it is when the rotation is only the EXIF turn", async () => {
    const decoded = trackedBitmap(6000, 4000);
    h.bitmapDecodeResult = () => Promise.resolve({ bitmap: decoded, oriented: true });

    const bitmap = await loadPhotoBitmap(
      rawPhoto({ rotation: 90, exif: { orientation: 6 } }),
    );

    expect(bitmap).toBe(decoded);
    expect(h.turns).toEqual([]);
    expect(decoded.closed).toBe(false);
  });

  it("turns an oriented bitmap by the manual rotation and closes the original", async () => {
    const decoded = trackedBitmap(6000, 4000);
    h.bitmapDecodeResult = () => Promise.resolve({ bitmap: decoded, oriented: true });

    const bitmap = await loadPhotoBitmap(
      rawPhoto({ rotation: 180, exif: { orientation: 6 } }),
    );

    expect(bitmap).toMatchObject({ width: 4000, height: 6000 });
    expect(h.turns).toEqual([90]);
    expect(decoded.closed).toBe(true);
  });

  it("turns an unoriented bitmap by the photo's whole rotation", async () => {
    const decoded = trackedBitmap(6000, 4000);
    h.bitmapDecodeResult = () => Promise.resolve({ bitmap: decoded, oriented: false });

    const bitmap = await loadPhotoBitmap(
      rawPhoto({ rotation: 90, exif: { orientation: 6 } }),
    );

    expect(bitmap).toMatchObject({ width: 4000, height: 6000 });
    expect(h.turns).toEqual([90]);
    expect(decoded.closed).toBe(true);
  });
});

describe("loadPhotoBitmap falling back to the embedded preview", () => {
  beforeEach(() => {
    h.previewResult = () => Promise.resolve(embeddedJpeg);
  });

  it("turns a sensor-native preview upright from the EXIF orientation", async () => {
    const bitmap = await loadPhotoBitmap(
      rawPhoto({ rotation: 90, exif: { orientation: 6 } }),
    );

    expect(bitmap).toMatchObject({ width: 4000, height: 6000 });
    expect(h.turns).toEqual([90]);
    expect(h.bitmapRequests).toHaveLength(1);
    expect(h.bitmapRequests[0].src).toBe(embeddedJpeg);
    expect(h.bitmapRequests[0].imageOrientation).toBe("none");
  });

  it("leaves a preview the camera already stored upright", async () => {
    const portrait = trackedBitmap(4000, 6000);
    stubBitmapDecoder(() => portrait);

    const bitmap = await loadPhotoBitmap(
      rawPhoto({ rotation: 90, exif: { orientation: 6 } }),
    );

    expect(bitmap).toBe(portrait);
    expect(h.turns).toEqual([]);
    expect(portrait.closed).toBe(false);
  });

  it("still applies the manual rotation to a preview that is already upright", async () => {
    stubBitmapDecoder(() => bitmapOf(4000, 6000));

    const bitmap = await loadPhotoBitmap(
      rawPhoto({ rotation: 180, exif: { orientation: 6 } }),
    );

    expect(bitmap).toMatchObject({ width: 6000, height: 4000 });
    expect(h.turns).toEqual([90]);
  });
});

describe("loadPhotoBitmap falling back to the stored thumbnail", () => {
  const withThumbnail = (over: Partial<CatalogPhoto> = {}): CatalogPhoto =>
    rawPhoto({ thumbnailBlob: storedThumbnail, rotation: 90, ...over });

  // The stored thumbnail is baked upright, so the photo's rotation must not
  // turn it a second time.
  it("serves the thumbnail as it is when the photo has no file handle", async () => {
    const bitmap = await loadPhotoBitmap(withThumbnail({ fileHandle: null }));

    expect(bitmap).toMatchObject({ width: 768, height: 512 });
    expect(h.turns).toEqual([]);
    expect(h.bitmapRequests).toHaveLength(1);
    expect(h.bitmapRequests[0].src).toBe(storedThumbnail);
    expect(h.bitmapRequests[0].imageOrientation).toBe("none");
  });

  it("serves the thumbnail when access to the original was not re-granted", async () => {
    h.permission = false;

    const bitmap = await loadPhotoBitmap(withThumbnail());

    expect(bitmap).toMatchObject({ width: 768, height: 512 });
    expect(h.fileReads).toBe(0);
  });

  it("serves the thumbnail when the original can't be read", async () => {
    const bitmap = await loadPhotoBitmap(
      withThumbnail({ fileHandle: unreadable("DSCF0001.RAF") }),
    );

    expect(bitmap).toMatchObject({ width: 768, height: 512 });
  });

  it("serves the thumbnail when neither the RAW decoder nor the preview yields pixels", async () => {
    const bitmap = await loadPhotoBitmap(withThumbnail());

    expect(bitmap).toMatchObject({ width: 768, height: 512 });
    expect(h.turns).toEqual([]);
  });

  it("returns null when the stored thumbnail won't decode", async () => {
    stubBitmapDecoder(() => {
      throw new Error("corrupt thumbnail");
    });

    expect(await loadPhotoBitmap(withThumbnail({ fileHandle: null }))).toBeNull();
  });

  it("returns null when there is no original and no thumbnail", async () => {
    expect(await loadPhotoBitmap(rawPhoto({ fileHandle: null }))).toBeNull();
  });
});
