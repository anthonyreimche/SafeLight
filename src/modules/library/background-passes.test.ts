// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The passes a project runs once it is open (the missing-preview repair and the
// "Cache all" pre-decode) belong to that project. Once the user leaves it they
// read no more of its files and write nothing: the next project's cache and
// catalog hold other photos. Their decodes, and those of Rebuild previews, are
// background work, so a photo opened meanwhile goes first. The decoders, the
// cache and the catalog are faked; only the hand-offs are under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

interface Request {
  background?: boolean;
  signal?: AbortSignal;
}

const h = vi.hoisted(() => ({
  /** The cache generation: which project's folder the cache is in. */
  generation: 1,
  /** Each original read through its file handle, by name. */
  fileReads: [] as string[],
  /** Each request handed to the full float decode, in order. */
  floatDecodes: [] as (Request | undefined)[],
  /** Each request handed to libraw's metadata-only open, in order. */
  metadataReads: [] as (Request | undefined)[],
  /** Runs while a float decode is under way. */
  whileDecoding: (): void => {},
  /** What the float decode answers instead of an image, if anything. */
  failure: null as Record<string, unknown> | null,
  /** A camera preview too small for the grid: kept only as a stand-in. */
  smallPreview: false,
  /** Runs while an original is read, and while a grid thumbnail is built. */
  whileReading: (): void => {},
  whileThumbnailing: (): void => {},
  /** Each write handed to the cache, as [key, the generation it carried]. */
  cacheWrites: [] as [string, number][],
  /** Each cache entry dropped, by key. */
  cacheDeletes: [] as string[],
  /** Ids of the photos handed to catalogStorage().putPhoto. */
  saved: [] as string[],
  /** Grid thumbnails built, and decoded bitmaps let go of. */
  thumbnails: 0,
  bitmapsClosed: 0,
  /** The catalog's photos as the store holds them. */
  catalog: [] as CatalogPhoto[],
}));

vi.mock("@/catalog/exif", () => ({
  parseExif: async () => ({}),
  parseXmp: async () => ({}),
  parseExifDate: () => undefined,
}));

vi.mock("./raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./raw-preview")>()),
  extractRawPreview: async () => null,
  extractRawPreviewDecoded: async () =>
    h.smallPreview
      ? { blob: new Blob(["jpeg"]), bitmap: await createImageBitmap(new Blob()), width: 160, height: 120 }
      : null,
}));

vi.mock("./netpbm", () => ({ isNetpbmName: () => false, decodeNetpbm: async () => null }));
vi.mock("./tiff-image", () => ({ isTiffName: () => false, decodeTiff: async () => null }));
vi.mock("./import-thumb-task", () => ({
  createThumbnail: async () => {
    h.thumbnails++;
    h.whileThumbnailing();
    return new Blob(["thumb"]);
  },
}));
vi.mock("./import-thumb-pool", () => ({ processThumb: async () => ({ ok: false }) }));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async (_file: Blob, request?: Request) => {
    h.floatDecodes.push(request);
    h.whileDecoding();
    if (h.failure) return h.failure;
    // A decode that has started runs to the end, abandoned or not.
    return { data: new Float32Array(4 * 2 * 4).fill(0.5), width: 4, height: 2, oriented: true };
  },
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async () => ({ use: true, cache: true }),
}));

vi.mock("@/raw/libraw-wasm-adapter", () => ({
  extractRawMetadata: async (_buffer: ArrayBuffer, request?: Request) => {
    h.metadataReads.push(request);
    return undefined;
  },
}));

vi.mock("@/raw/decode-pool", () => ({ decodePoolSize: () => 3, warmDecodePool: async () => {} }));

vi.mock("@/raw/raw-cache", () => ({
  cachedKeys: async () => new Set<string>(),
  deleteCachedPreview: async (key: string) => void h.cacheDeletes.push(key),
  hasDecodeMarker: async () => false,
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => h.generation,
  writeCachedPreview: async (
    key: string,
    _data: Float32Array,
    _w: number,
    _h: number,
    begunIn: number,
  ) => {
    h.cacheWrites.push([key, begunIn]);
  },
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    previewSource: "auto",
    thumbMaxEdge: 768,
    rawCacheEnabled: true,
    rawCachePrefetch: true,
  }),
}));

vi.mock("@/catalog/storage", () => ({
  catalogStorage: () => ({
    putPhoto: async (photo: CatalogPhoto) => {
      h.saved.push(photo.id);
    },
  }),
}));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: h.catalog }) },
}));

import {
  preDecodeRawsForCache,
  rebuildThumbnails,
  reimportPhotos,
  repairMissingPreviews,
} from "./import-photos";
import { rawPhoto } from "./raw-photo.test-support";

/** A RAW in the catalog, read through its file handle. */
function rawRecord(index: number, extra: Partial<CatalogPhoto> = {}): CatalogPhoto {
  const name = `DSC_000${index}.NEF`;
  const onRead = () => {
    h.fileReads.push(name);
    h.whileReading();
  };
  const photo = rawPhoto(name, { onRead, ...extra });
  h.catalog.push(photo);
  return photo;
}

const raws = (count: number, extra: Partial<CatalogPhoto> = {}): CatalogPhoto[] =>
  Array.from({ length: count }, (_, i) => rawRecord(i, extra));

/** Records imported without a preview, which the repair pass retries. */
const unrepaired = (count: number): CatalogPhoto[] => raws(count, { width: 0, height: 0 });

function left(): AbortSignal {
  const project = new AbortController();
  project.abort();
  return project.signal;
}

beforeEach(() => {
  h.generation = 1;
  h.fileReads = [];
  h.floatDecodes = [];
  h.metadataReads = [];
  h.whileDecoding = () => {};
  h.failure = null;
  h.smallPreview = false;
  h.whileReading = () => {};
  h.whileThumbnailing = () => {};
  h.cacheWrites = [];
  h.cacheDeletes = [];
  h.saved = [];
  h.thumbnails = 0;
  h.bitmapsClosed = 0;
  h.catalog = [];
  vi.stubGlobal(
    "ImageData",
    class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    },
  );
  vi.stubGlobal(
    "createImageBitmap",
    async (source: { width: number; height: number }): Promise<ImageBitmap> => ({
      width: source.width,
      height: source.height,
      close: () => void h.bitmapsClosed++,
    }),
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:thumb", revokeObjectURL: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Cache all pre-decode of a project the user has left", () => {
  it("reads and decodes nothing when the project was left before it began", async () => {
    await preDecodeRawsForCache(raws(3), { force: true, signal: left() });

    expect(h.fileReads).toEqual([]);
    expect(h.floatDecodes).toEqual([]);
    expect(h.cacheWrites).toEqual([]);
  });

  it("reads no further file and writes nothing once the project is left", async () => {
    const project = new AbortController();
    h.whileDecoding = () => project.abort();

    await preDecodeRawsForCache(raws(4), { force: true, signal: project.signal });

    expect(h.cacheWrites).toEqual([]);
    expect(h.floatDecodes).toHaveLength(1);
    expect(h.fileReads).not.toContain("DSC_0002.NEF");
    expect(h.fileReads).not.toContain("DSC_0003.NEF");
  });

  it("hands the project's signal to each decode, as background work", async () => {
    const project = new AbortController();

    await preDecodeRawsForCache(raws(1), { force: true, signal: project.signal });

    expect(h.floatDecodes).toEqual([{ background: true, signal: project.signal }]);
  });

  it("writes under the cache generation it began in", async () => {
    h.whileDecoding = () => {
      h.generation = 2; // another project's cache folder was set meanwhile
    };

    await preDecodeRawsForCache(raws(1), { force: true });

    expect(h.cacheWrites).toEqual([["DSC_0000.NEF:64:0", 1]]);
  });
});

describe("the repair of missing previews of a project the user has left", () => {
  it("reads nothing when the project was left before it began", async () => {
    await repairMissingPreviews(unrepaired(2), undefined, left());

    expect(h.fileReads).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it("stores nothing, goes on to no other photo and logs nothing once the project is left", async () => {
    const project = new AbortController();
    h.whileDecoding = () => project.abort();
    const repaired: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await repairMissingPreviews(unrepaired(3), (p) => repaired.push(p.id), project.signal);

    expect(h.saved).toEqual([]);
    expect(repaired).toEqual([]);
    expect(h.fileReads).toEqual(["DSC_0000.NEF"]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("reads no metadata and builds no thumbnail once the project is left during its decode", async () => {
    const project = new AbortController();
    h.whileDecoding = () => project.abort();

    await repairMissingPreviews(unrepaired(1), undefined, project.signal);

    expect(h.metadataReads).toEqual([]);
    expect(h.thumbnails).toBe(0);
    expect(h.bitmapsClosed).toBe(1);
  });

  it("decodes and reads metadata as background work, with the project's signal", async () => {
    const project = new AbortController();

    await repairMissingPreviews(unrepaired(1), undefined, project.signal);

    expect(h.floatDecodes).toEqual([{ background: true, signal: project.signal }]);
    expect(h.metadataReads).toEqual([{ background: true, signal: project.signal }]);
    expect(h.saved).toEqual(["id:DSC_0000.NEF"]);
  });
});

describe("rebuilding every preview", () => {
  it("decodes and reads metadata as background work", async () => {
    await rebuildThumbnails(raws(1));

    expect(h.floatDecodes).toEqual([{ background: true }]);
    expect(h.metadataReads).toEqual([{ background: true }]);
  });

  it("hands the project's signal to its decodes and metadata reads", async () => {
    const project = new AbortController();

    await rebuildThumbnails(raws(1), undefined, undefined, project.signal);

    expect(h.floatDecodes).toEqual([{ background: true, signal: project.signal }]);
    expect(h.metadataReads).toEqual([{ background: true, signal: project.signal }]);
  });

  it("reads nothing when the project was left before it began", async () => {
    await rebuildThumbnails(raws(2), undefined, undefined, left());

    expect(h.fileReads).toEqual([]);
  });

  it("decodes nothing once the project is left while its file is read", async () => {
    const project = new AbortController();
    h.whileReading = () => project.abort();

    await rebuildThumbnails(raws(2), undefined, undefined, project.signal);

    expect(h.fileReads).toEqual(["DSC_0000.NEF"]);
    expect(h.floatDecodes).toEqual([]);
  });

  it("stores nothing once the project is left while a preview is built", async () => {
    const project = new AbortController();
    h.whileThumbnailing = () => project.abort();

    await rebuildThumbnails(raws(2), undefined, undefined, project.signal);

    expect(h.thumbnails).toBe(1);
    expect(h.saved).toEqual([]);
  });

  it("reads no further file and stores nothing once the project is left", async () => {
    const project = new AbortController();
    h.whileDecoding = () => project.abort();
    const rebuilt: string[] = [];

    await rebuildThumbnails(raws(3), undefined, (p) => rebuilt.push(p.id), project.signal);

    expect(h.fileReads).toEqual(["DSC_0000.NEF"]);
    expect(h.metadataReads).toEqual([]);
    expect(h.thumbnails).toBe(0);
    expect(h.bitmapsClosed).toBe(1);
    expect(h.saved).toEqual([]);
    expect(rebuilt).toEqual([]);
  });
});

// "Cache all" decodes a photo; a pass that would store its preview meanwhile is
// passed over by the decoder (decode.ts) and must not store the camera's small
// preview in place of the decode it never ran.
describe("a pass that stores previews and a photo the decoder passed over", () => {
  const passedOver = { failure: "transient", reason: "being decoded already", passedOver: true };

  it("leaves the photo's preview to the next rebuild", async () => {
    h.smallPreview = true;
    h.failure = passedOver;

    await rebuildThumbnails(raws(1));

    expect(h.saved).toEqual([]);
    expect(h.thumbnails).toBe(0);
    expect(h.bitmapsClosed).toBe(1);
  });

  it("leaves a missing preview to the next repair", async () => {
    h.smallPreview = true;
    h.failure = passedOver;

    await repairMissingPreviews(unrepaired(1));

    expect(h.saved).toEqual([]);
    expect(h.bitmapsClosed).toBe(1);
  });

  it("still stores the camera's preview for a RAW the decoder failed on", async () => {
    h.smallPreview = true;
    h.failure = { failure: "unsupported", reason: "imageData returned undefined" };

    await rebuildThumbnails(raws(1));

    expect(h.saved).toEqual(["id:DSC_0000.NEF"]);
  });
});

describe("importing photos again for a project the user has left", () => {
  it("reads nothing and drops no cache entry when the project was left before it began", async () => {
    const result = await reimportPhotos(raws(2), undefined, undefined, left());

    expect(h.fileReads).toEqual([]);
    expect(h.cacheDeletes).toEqual([]);
    expect(result).toEqual({ ok: 0, failed: 0 });
  });

  // The next project's cache may hold an entry under the same key: same path,
  // same size.
  it("drops no further cache entry and stores nothing once the project is left", async () => {
    const project = new AbortController();
    h.whileDecoding = () => project.abort();
    const reimported: string[] = [];

    const result = await reimportPhotos(
      raws(3),
      undefined,
      (p) => reimported.push(p.id),
      project.signal,
    );

    expect(h.cacheDeletes).toEqual(["DSC_0000.NEF:64:0"]);
    expect(h.fileReads).toEqual(["DSC_0000.NEF"]);
    expect(h.saved).toEqual([]);
    expect(reimported).toEqual([]);
    expect(h.thumbnails).toBe(0);
    expect(h.bitmapsClosed).toBe(1);
    expect(result).toEqual({ ok: 0, failed: 0 });
  });

  it("stores no reason for a photo whose decode failed as the project was left", async () => {
    const project = new AbortController();
    h.whileDecoding = () => project.abort();
    h.failure = { failure: "unsupported", reason: "imageData returned undefined" };

    const result = await reimportPhotos(raws(2), undefined, undefined, project.signal);

    expect(h.saved).toEqual([]);
    expect(result).toEqual({ ok: 0, failed: 0 });
  });

  // In Electron the read is the whole RAW: the likeliest moment for a switch.
  it("drops no cache entry once the project is left while the file is read", async () => {
    const project = new AbortController();
    h.whileReading = () => project.abort();

    const result = await reimportPhotos(raws(2), undefined, undefined, project.signal);

    expect(h.cacheDeletes).toEqual([]);
    expect(h.fileReads).toEqual(["DSC_0000.NEF"]);
    expect(result).toEqual({ ok: 0, failed: 0 });
  });

  it("stores nothing once the project is left while a preview is built", async () => {
    const project = new AbortController();
    h.whileThumbnailing = () => project.abort();

    const result = await reimportPhotos(raws(2), undefined, undefined, project.signal);

    expect(h.thumbnails).toBe(1);
    expect(h.saved).toEqual([]);
    expect(result).toEqual({ ok: 0, failed: 0 });
  });

  it("hands the project's signal to its decode and metadata read", async () => {
    const project = new AbortController();

    await reimportPhotos(raws(1), undefined, undefined, project.signal);

    expect(h.floatDecodes).toEqual([{ signal: project.signal }]);
    expect(h.metadataReads).toEqual([{ signal: project.signal }]);
  });
});
