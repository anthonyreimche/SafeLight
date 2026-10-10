// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, ExifData } from "@/catalog/types";
import type { RawMetadata } from "@/raw/libraw-wasm-adapter";
import type { RebuiltChange } from "@/state/catalog-store";

interface XmpFields {
  rating?: number;
  colorLabel?: string;
  keywords?: string[];
  title?: string;
}

const h = vi.hoisted(() => ({
  exif: {} as ExifData,
  xmp: {} as XmpFields,
  /** Date parseExifDate resolves dateTimeOriginal to, or undefined for "unset". */
  exifDate: undefined as number | undefined,
  previewSource: "auto" as "auto" | "embedded" | "rendered",
  thumbMaxEdge: 768,
  /** What the camera's embedded JPEG extractor finds, if anything. */
  embedded: null as Blob | null,
  /** Pixel dimensions createImageBitmap reports for a decoded blob. */
  blobSize: { width: 4000, height: 3000 },
  rawBitmap: null as { width: number; height: number; oriented: boolean } | null,
  rawFloat: null as {
    width: number;
    height: number;
    oriented?: boolean;
    colorTemperature?: number;
    suspicious?: boolean;
  } | null,
  /** What the shared accept/reject check rules on a full decode. */
  verdict: { use: true, cache: true } as { use: boolean; cache: boolean },
  /** What that check was asked to judge, in order. */
  judged: [] as {
    suspicious: boolean | undefined;
    size: [number, number];
    preview: Blob | null;
  }[],
  /** How many times the embedded preview was extracted. */
  previewReads: 0,
  /** Entries handed to writeCachedPreview, as [key, width, height]. */
  cacheWrites: [] as [string, number, number][],
  /** How the full float decode fails when it gives no image. */
  floatFailure: "unsupported" as "unsupported" | "transient",
  /** What libraw's metadata-only open yields for a RAW; undefined = can't read it. */
  rawMeta: undefined as RawMetadata | undefined,
  /** How many times that metadata-only open ran. */
  libRawReads: 0,
  /** Whether each full float decode was asked for as background work. */
  floatDecodes: [] as (boolean | undefined)[],
  /** The project signal each full float decode was handed. */
  floatSignals: [] as (AbortSignal | undefined)[],
  /** Photos handed to catalogStorage().putPhoto. */
  saved: [] as CatalogPhoto[],
  /** The catalog's photos as the store holds them when a decode finishes. */
  catalog: [] as CatalogPhoto[],
}));

vi.mock("@/catalog/exif", () => ({
  parseExif: async (): Promise<ExifData> => ({ ...h.exif }),
  parseXmp: async (): Promise<XmpFields> => ({ ...h.xmp }),
  parseExifDate: (raw: string | undefined) => (raw ? h.exifDate : undefined),
}));

vi.mock("./raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./raw-preview")>()),
  extractRawPreview: async () => {
    h.previewReads++;
    return h.embedded;
  },
  // Mirrors the real contract: an undecodable embedded JPEG (blobSize 0) means
  // no candidate survives; a targetLongEdge decodes the bitmap downscaled while
  // width/height report the true frame size.
  extractRawPreviewDecoded: async (
    _f: File,
    opts?: { targetLongEdge?: number },
  ) => {
    if (!h.embedded || h.blobSize.width === 0) return null;
    const { width, height } = h.blobSize;
    const long = Math.max(width, height);
    const scale = opts?.targetLongEdge && long > opts.targetLongEdge ? opts.targetLongEdge / long : 1;
    return {
      blob: h.embedded,
      bitmap: bitmapOf(Math.round(width * scale), Math.round(height * scale)),
      width,
      height,
    };
  },
}));

vi.mock("./netpbm", () => ({
  isNetpbmName: (name: string) => /\.(ppm|pgm|pbm|pnm)$/i.test(name),
  decodeNetpbm: async () => null,
}));

vi.mock("./tiff-image", () => ({
  isTiffName: (name: string) => /\.tiff?$/i.test(name),
  decodeTiff: async () => null,
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () =>
    h.rawBitmap
      ? { bitmap: bitmapOf(h.rawBitmap.width, h.rawBitmap.height), oriented: h.rawBitmap.oriented }
      : null,
  decodeRawToFloat: async (
    _file: Blob,
    priority?: { background?: boolean; signal?: AbortSignal },
  ) => {
    h.floatDecodes.push(priority?.background);
    h.floatSignals.push(priority?.signal);
    return h.rawFloat
      ? {
          data: new Float32Array(h.rawFloat.width * h.rawFloat.height * 4).fill(0.5),
          width: h.rawFloat.width,
          height: h.rawFloat.height,
          oriented: h.rawFloat.oriented ?? false,
          colorTemperature: h.rawFloat.colorTemperature,
          suspicious: h.rawFloat.suspicious,
        }
      : { failure: h.floatFailure, reason: "unsupported model" };
  },
}));

// The colour check needs an image decoder and WebGL; accept-decode.test.ts
// pins what makes a decode acceptable, so here the ruling is a given.
vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async (
    decode: { suspicious?: boolean },
    upright: { width: number; height: number },
    preview: Blob | null,
  ) => {
    h.judged.push({
      suspicious: decode.suspicious,
      size: [upright.width, upright.height],
      preview,
    });
    return h.verdict;
  },
}));

vi.mock("@/raw/libraw-wasm-adapter", () => ({
  extractRawMetadata: async () => {
    h.libRawReads++;
    return h.rawMeta;
  },
}));

vi.mock("@/raw/decode-pool", () => ({ decodePoolSize: () => 2, warmDecodePool: async () => {} }));

vi.mock("@/raw/raw-cache", () => ({
  cachedKeys: async () => new Set<string>(),
  deleteCachedPreview: async () => {},
  hasDecodeMarker: async () => false,
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  writeCachedPreview: async (key: string, _data: Float32Array, w: number, ht: number) => {
    h.cacheWrites.push([key, w, ht]);
  },
  markDecode: async () => {},
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    previewSource: h.previewSource,
    thumbMaxEdge: h.thumbMaxEdge,
    rawCacheEnabled: true,
  }),
}));

vi.mock("@/catalog/storage", () => ({
  catalogStorage: () => ({
    putPhoto: async (photo: CatalogPhoto) => {
      h.saved.push(photo);
    },
  }),
}));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: h.catalog }) },
}));

import {
  buildPhoto,
  buildPreviewBlob,
  isSupportedName,
  preDecodeRawsForCache,
  rebuildThumbnails,
  reimportPhotos,
  repairMissingPreviews,
} from "./import-photos";

// ── canvas/bitmap stand-ins ──────────────────────────────────────────────────
// The decode chain is pure pixel plumbing here; what matters is the geometry it
// hands on, so a bitmap is its dimensions and a "JPEG" is the size it was drawn
// at. That makes the baked-in rotation observable from the thumbnail alone.

function bitmapOf(width: number, height: number): ImageBitmap {
  return { width, height, close() {} } as unknown as ImageBitmap;
}

function installCanvasStubs(): void {
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
    getContext() {
      return { translate() {}, rotate() {}, drawImage() {} };
    }
    async convertToBlob({ type }: { type: string }) {
      return new Blob([`jpeg:${this.width}x${this.height}`], { type });
    }
  }
  class FakeImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("ImageData", FakeImageData);
  // The module only ever mints/releases object URLs; nothing here parses one.
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => `blob:${blob.size}`,
    revokeObjectURL: () => {},
  });
  vi.stubGlobal("createImageBitmap", async (source: unknown): Promise<ImageBitmap> => {
    if (source instanceof FakeOffscreenCanvas || source instanceof FakeImageData)
      return bitmapOf(source.width, source.height);
    if (source instanceof Blob) {
      if (h.blobSize.width === 0) throw new Error("undecodable");
      return bitmapOf(h.blobSize.width, h.blobSize.height);
    }
    throw new Error("unexpected bitmap source");
  });
}

const file = (name: string, type = "", lastModified = 1_600_000_000_000): File =>
  new File([new Uint8Array(64)], name, { type, lastModified });

const thumbText = async (photo: CatalogPhoto) => photo.thumbnailBlob!.text();

const TEMPLATE: Omit<CatalogPhoto, "id" | "filename" | "relPath" | "folder"> = {
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 0,
  height: 0,
  fileSize: 64,
  mimeType: "image/jpeg",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 1,
  dateImported: 2,
  exif: {},
};

/** A catalog record whose fileHandle serves `name` — the shape the repair and
 *  rebuild passes walk. It is in the catalog (h.catalog) until a test says
 *  otherwise. */
function record(name: string, extra: Partial<CatalogPhoto> = {}): CatalogPhoto {
  const photo: CatalogPhoto = {
    ...TEMPLATE,
    id: `id:${name}`,
    filename: name,
    relPath: name,
    folder: "",
    fileHandle: {
      name,
      async getFile() {
        return file(name);
      },
    } as unknown as FileSystemFileHandle,
    ...extra,
  };
  h.catalog.push(photo);
  return photo;
}

/** The record the catalog holds for `photo` changes, as it would while a decode
 *  runs: a rating here, or one taken on from another window. */
function changeInCatalog(photo: CatalogPhoto, change: Partial<CatalogPhoto>): void {
  h.catalog = h.catalog.map((p) => (p.id === photo.id ? { ...p, ...change } : p));
}

beforeEach(() => {
  h.catalog = [];
  h.exif = {};
  h.xmp = {};
  h.exifDate = undefined;
  h.previewSource = "auto";
  h.thumbMaxEdge = 768;
  h.embedded = null;
  h.blobSize = { width: 4000, height: 3000 };
  h.rawBitmap = null;
  h.rawFloat = null;
  h.verdict = { use: true, cache: true };
  h.judged = [];
  h.previewReads = 0;
  h.cacheWrites = [];
  h.rawMeta = undefined;
  h.libRawReads = 0;
  h.floatDecodes = [];
  h.floatSignals = [];
  h.floatFailure = "unsupported";
  h.saved = [];
  installCanvasStubs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isSupportedName", () => {
  it.each([
    "IMG_0001.jpg",
    "IMG_0001.JPEG",
    "shot.png",
    "shot.WEBP",
    "shot.avif",
    "scan.tif",
    "scan.TIFF",
    "render.ppm",
    "render.pnm",
    "DSC_0001.NEF",
    "IMG.cr3",
    "IMG.dng",
    "IMG.x3f",
    "sensor.raw",
  ])("accepts %s", (name) => {
    expect(isSupportedName(name)).toBe(true);
  });

  it.each([
    "notes.txt",
    "clip.mp4",
    "archive.zip",
    "IMG_0001.jpg.bak",
    "catalog.json",
    "Makefile",
    "IMG_0001",
  ])("rejects %s", (name) => {
    expect(isSupportedName(name)).toBe(false);
  });
});

describe("buildPhoto", () => {
  it("returns null for a file no decoder claims", async () => {
    await expect(buildPhoto(file("notes.txt", "text/plain"), null, null)).resolves.toBeNull();
  });

  it("builds an upright thumbnail and records the source dimensions", async () => {
    const photo = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;

    expect(photo).toMatchObject({
      filename: "a.jpg",
      mimeType: "image/jpeg",
      width: 4000,
      height: 3000,
      rotation: 0,
      fileSize: 64,
    });
    expect(await thumbText(photo)).toBe("jpeg:768x576"); // long edge = thumbMaxEdge
    expect(photo.thumbnailUrl).toMatch(/^blob:/);
    expect(photo.decodeError).toBeUndefined();
  });

  it("bakes EXIF orientation into the thumbnail and reports upright dimensions", async () => {
    h.exif = { orientation: 6 }; // 90° CW

    const photo = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;

    expect(photo).toMatchObject({ width: 3000, height: 4000, rotation: 90 });
    expect(await thumbText(photo)).toBe("jpeg:576x768");
  });

  it("keeps the canonical EXIF rotation even when the decoder pre-oriented the pixels", async () => {
    // load-image subtracts this EXIF portion, so storing 0 here would make the
    // develop view over-rotate relative to the grid thumbnail.
    h.exif = { orientation: 6 };
    h.rawBitmap = { width: 3000, height: 4000, oriented: true };

    const photo = (await buildPhoto(file("a.NEF"), null, null))!;

    expect(photo.rotation).toBe(90);
    expect(photo).toMatchObject({ width: 3000, height: 4000 });
    expect(await thumbText(photo)).toBe("jpeg:576x768"); // nothing baked on top
  });

  it("records a supported file that won't decode, marked for a later retry", async () => {
    // Dropping it would re-scan the file as "new" on every open and lose its id
    // along with any rating or edit attached to it.
    h.blobSize = { width: 0, height: 0 };
    h.exif = { orientation: 3 };

    const photo = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;

    expect(photo).toMatchObject({ width: 0, height: 0, rotation: 180, filename: "a.jpg" });
    expect(photo.thumbnailBlob).toBeNull();
    expect(photo.decodeError).toBe("No decoder could read this file.");
  });

  it("names the format in the failure reason so the grid can explain itself", async () => {
    h.blobSize = { width: 0, height: 0 };

    const raw = (await buildPhoto(file("a.NEF"), null, null))!;
    const tiff = (await buildPhoto(file("a.tif"), null, null))!;

    expect(raw.decodeError).toBe("This RAW file can't be decoded.");
    expect(tiff.decodeError).toBe("This kind of TIFF file isn't supported.");
  });

  it("says a RAW that failed for now couldn't be read this time", async () => {
    h.blobSize = { width: 0, height: 0 };
    h.floatFailure = "transient";

    const raw = (await buildPhoto(file("a.NEF"), null, null))!;

    expect(raw.decodeError).toBe("This RAW file couldn't be read this time.");
  });

  it("keeps the decoder's own reason for the console", async () => {
    h.blobSize = { width: 0, height: 0 };

    await buildPhoto(file("a.NEF"), null, null);

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining("a.NEF"),
      "unsupported model",
    );
  });

  it("falls back to the float decode when the bitmap decoder can't handle the RAW", async () => {
    h.rawBitmap = null;
    h.rawFloat = { width: 2000, height: 1000, colorTemperature: 5200 };

    const photo = (await buildPhoto(file("a.rw2"), null, null))!;

    expect(photo).toMatchObject({ width: 2000, height: 1000 });
    expect(photo.exif.colorTemperature).toBe(5200);
    expect(photo.decodeError).toBeUndefined();
  });

  it("falls back to the camera's embedded preview when every decode fails", async () => {
    h.previewSource = "rendered";
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1600, height: 1200 };

    const photo = (await buildPhoto(file("a.NEF"), null, null))!;

    expect(photo).toMatchObject({ width: 1600, height: 1200 });
    expect(photo.decodeError).toBeUndefined();
  });

  it("maps a RAW extension to a MIME type when the OS reports none", async () => {
    const nef = (await buildPhoto(file("a.NEF"), null, null))!;
    const crw = (await buildPhoto(file("a.crw"), null, null))!;

    expect(nef.mimeType).toBe("image/x-nikon-nef");
    expect(crw.mimeType).toBe("image/x-canon-crw");
  });

  it("prefers the OS-reported MIME type when there is one", async () => {
    const photo = (await buildPhoto(file("a.dng", "image/x-adobe-dng"), null, null))!;
    expect(photo.mimeType).toBe("image/x-adobe-dng");
  });

  it("seeds curation from XMP the camera or another editor wrote", async () => {
    h.xmp = { rating: 4, colorLabel: "Red", keywords: ["dawn", "iceland"], title: "Sunrise" };

    const photo = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;

    expect(photo).toMatchObject({ rating: 4, colorLabel: "red", keywords: ["dawn", "iceland"] });
    expect(photo.exif.imageDescription).toBe("Sunrise");
  });

  it("leaves an unrecognised XMP colour label unset", async () => {
    h.xmp = { colorLabel: "Chartreuse" };
    const photo = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;
    expect(photo.colorLabel).toBe("none");
  });

  it("never lets XMP overwrite a description the file already carries", async () => {
    h.exif = { imageDescription: "from exif" };
    h.xmp = { title: "from xmp" };
    const photo = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;
    expect(photo.exif.imageDescription).toBe("from exif");
  });

  it("dates a photo by EXIF capture time, falling back to the file's mtime", async () => {
    h.exif = { dateTimeOriginal: "2024:05:01 10:00:00" };
    h.exifDate = 1_714_557_600_000;
    expect((await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!.dateCreated).toBe(
      1_714_557_600_000,
    );

    h.exif = {};
    expect((await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!.dateCreated).toBe(
      1_600_000_000_000,
    );
  });

  it("pulls the as-shot white balance from libraw for RAW files that lack it", async () => {
    h.rawMeta = { colorTemperature: 4800 };
    h.rawBitmap = { width: 100, height: 100, oriented: false };

    const photo = (await buildPhoto(file("a.NEF"), null, null))!;

    expect(photo.exif.colorTemperature).toBe(4800);
  });

  it("records the exposure bias libraw reports for a Fujifilm DR-mode raw", async () => {
    h.rawMeta = { rawExposureBias: -2.72 };
    h.rawBitmap = { width: 100, height: 100, oriented: false };

    const photo = (await buildPhoto(file("a.RAF"), null, null))!;

    expect(photo.exif.rawExposureBias).toBe(-2.72);
  });

  it("keeps a white balance the file already declared", async () => {
    h.exif = { colorTemperature: 6100 };
    h.rawMeta = { colorTemperature: 4800 };
    h.rawBitmap = { width: 100, height: 100, oriented: false };

    const photo = (await buildPhoto(file("a.dng"), null, null))!;

    expect(photo.exif.colorTemperature).toBe(6100);
  });

  it("records the frame libraw decodes, not the camera preview it thumbnails from", async () => {
    // Fujifilm embeds a preview smaller than the sensor frame, and an in-camera
    // aspect setting crops it further: fine for the grid, wrong as the size.
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1920, height: 1280 };
    h.rawMeta = { frame: { width: 6240, height: 4160 } };

    const photo = (await buildPhoto(file("a.RAF"), null, null))!;

    expect(photo).toMatchObject({ width: 6240, height: 4160 });
    expect(await thumbText(photo)).toBe("jpeg:768x512"); // still the camera preview
  });

  it("keeps libraw's frame as reported for a portrait shot — it comes back upright", async () => {
    h.exif = { orientation: 6 };
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1920, height: 1280 }; // sensor-native preview, turned here
    h.rawMeta = { frame: { width: 4160, height: 6240 } };

    const photo = (await buildPhoto(file("a.RAF"), null, null))!;

    expect(photo).toMatchObject({ width: 4160, height: 6240, rotation: 90 });
    expect(await thumbText(photo)).toBe("jpeg:512x768");
  });

  it("sizes a DNG from libraw's frame even when its EXIF already gave the white balance", async () => {
    h.exif = { colorTemperature: 6100 };
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1024, height: 683 };
    h.rawMeta = { frame: { width: 6000, height: 4000 }, colorTemperature: 4800 };

    const photo = (await buildPhoto(file("a.dng"), null, null))!;

    expect(photo).toMatchObject({ width: 6000, height: 4000 });
    expect(photo.exif.colorTemperature).toBe(6100);
  });

  it("sizes a RAW libraw can't read from its preview, as before", async () => {
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1920, height: 1280 };
    h.rawMeta = undefined;

    const photo = (await buildPhoto(file("a.RAF"), null, null))!;

    expect(photo).toMatchObject({ width: 1920, height: 1280 });
  });

  it("never opens libraw for a file that isn't RAW", async () => {
    await buildPhoto(file("a.jpg", "image/jpeg"), null, null);
    expect(h.libRawReads).toBe(0);
  });

  it("carries the handles it was opened with onto the record", async () => {
    const dir = { kind: "directory", name: "trip" } as unknown as FileSystemDirectoryHandle;
    const fh = { kind: "file", name: "a.jpg" } as unknown as FileSystemFileHandle;

    const photo = (await buildPhoto(file("a.jpg", "image/jpeg"), dir, fh))!;

    expect(photo.directoryHandle).toBe(dir);
    expect(photo.fileHandle).toBe(fh);
    expect(photo.relPath).toBe(""); // the project scan fills these in
    expect(photo.folder).toBe("");
  });

  it("gives every record its own id", async () => {
    const a = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;
    const b = (await buildPhoto(file("a.jpg", "image/jpeg"), null, null))!;
    expect(a.id).not.toBe(b.id);
  });
});

describe("buildPreviewBlob", () => {
  it("returns null for a record with no live file handle", async () => {
    await expect(buildPreviewBlob(record("a.jpg", { fileHandle: null }))).resolves.toBeNull();
  });

  it("returns null when the file no longer decodes", async () => {
    h.blobSize = { width: 0, height: 0 };
    await expect(buildPreviewBlob(record("a.jpg"))).resolves.toBeNull();
  });

  it("rebuilds at the photo's canonical rotation", async () => {
    const blob = await buildPreviewBlob(record("a.jpg", { rotation: 90 }));
    expect(await blob!.text()).toBe("jpeg:576x768");
  });

  it("does not rotate twice when the decoder already oriented the pixels", async () => {
    h.exif = { orientation: 6 };
    h.rawBitmap = { width: 3000, height: 4000, oriented: true };

    const blob = await buildPreviewBlob(
      record("a.NEF", { rotation: 90, exif: { orientation: 6 } }),
    );

    expect(await blob!.text()).toBe("jpeg:576x768");
  });

  it("honours the current thumbnail-quality setting", async () => {
    h.thumbMaxEdge = 400;
    const blob = await buildPreviewBlob(record("a.jpg"));
    expect(await blob!.text()).toBe("jpeg:400x300");
  });

  // The grid asks for these while the user works: a photo opened meanwhile
  // goes first.
  it("decodes a RAW as background work, with the signal it is handed", async () => {
    h.rawFloat = { width: 20, height: 10 };
    const project = new AbortController();

    await buildPreviewBlob(record("a.NEF"));
    await buildPreviewBlob(record("b.NEF"), project.signal);

    expect(h.floatDecodes).toEqual([true, true]);
    expect(h.floatSignals).toEqual([undefined, project.signal]);
  });
});

describe("repairMissingPreviews", () => {
  it("retries only records that were imported without a preview", async () => {
    const broken = record("broken.jpg", { width: 0, height: 0, decodeError: "RAW decode failed" });
    const fine = record("fine.jpg", { width: 100, height: 80 });
    const handleless = record("gone.jpg", { width: 0, fileHandle: null });
    const repaired: CatalogPhoto[] = [];

    await repairMissingPreviews([broken, fine, handleless], (p) => repaired.push(p));

    expect(repaired.map((p) => p.id)).toEqual(["id:broken.jpg"]);
    expect(h.saved.map((p) => p.id)).toEqual(["id:broken.jpg"]);
    expect(repaired[0]).toMatchObject({ width: 4000, height: 3000 });
    expect(repaired[0].decodeError).toBeUndefined();
    expect(await thumbText(repaired[0])).toBe("jpeg:768x576");
  });

  it("leaves a record that still won't decode for the next open", async () => {
    h.blobSize = { width: 0, height: 0 };
    const broken = record("broken.jpg", { width: 0, decodeError: "RAW decode failed" });
    const repaired: CatalogPhoto[] = [];

    await repairMissingPreviews([broken], (p) => repaired.push(p));

    expect(repaired).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(broken.decodeError).toBe("RAW decode failed");
  });

  it("keeps going after one record throws", async () => {
    const exploding = record("bad.jpg", { width: 0 });
    exploding.fileHandle = {
      name: "bad.jpg",
      getFile: async () => {
        throw new Error("EBUSY");
      },
    } as unknown as FileSystemFileHandle;

    await repairMissingPreviews([exploding, record("ok.jpg", { width: 0 })]);

    expect(h.saved.map((p) => p.id)).toEqual(["id:ok.jpg"]);
  });

  it("sizes a repaired RAW from libraw's frame, turned by its manual rotation", async () => {
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1920, height: 1280 };
    h.rawMeta = { frame: { width: 6240, height: 4160 } };
    const broken = record("a.RAF", { width: 0, height: 0, rotation: 90, decodeError: "RAW decode failed" });
    const repaired: CatalogPhoto[] = [];

    await repairMissingPreviews([broken], (p) => repaired.push(p));

    expect(repaired[0]).toMatchObject({ width: 4160, height: 6240, rotation: 90 });
    expect(await thumbText(repaired[0])).toBe("jpeg:512x768");
  });
});

describe("rebuildThumbnails", () => {
  it("replaces a preview-sized record with libraw's frame", async () => {
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1920, height: 1280 };
    h.rawMeta = { frame: { width: 6240, height: 4160 } };
    const stale = record("a.RAF", { width: 1920, height: 1280 });
    const rebuilt: CatalogPhoto[] = [];

    await rebuildThumbnails([stale], undefined, (p) => rebuilt.push(p));

    expect(rebuilt[0]).toMatchObject({ width: 6240, height: 4160 });
    expect(await thumbText(rebuilt[0])).toBe("jpeg:768x512");
    expect(h.saved.map((p) => p.id)).toEqual(["id:a.RAF"]);
  });
});

describe("reimportPhotos", () => {
  it("refreshes a RAW's size and white balance from libraw", async () => {
    h.embedded = new Blob(["embedded-jpeg"]);
    h.blobSize = { width: 1920, height: 1280 };
    h.rawMeta = { frame: { width: 6240, height: 4160 }, colorTemperature: 4800 };
    const stale = record("a.RAF", { width: 1920, height: 1280 });
    const reimported: CatalogPhoto[] = [];

    const result = await reimportPhotos([stale], undefined, (p) => reimported.push(p));

    expect(result).toEqual({ ok: 1, failed: 0 });
    expect(reimported[0]).toMatchObject({ width: 6240, height: 4160 });
    expect(reimported[0].exif.colorTemperature).toBe(4800);
  });
});

describe("a photo that changes while its preview is rebuilt", () => {
  // These passes walk a list read before their decodes, which take a while. What
  // they store goes onto the photo as the catalog holds it by then.

  it("keeps a rating and keywords given meanwhile when a missing preview is repaired", async () => {
    const broken = record("broken.jpg", { width: 0, decodeError: "RAW decode failed" });
    changeInCatalog(broken, { rating: 4, keywords: ["dusk"] });
    const repaired: CatalogPhoto[] = [];

    await repairMissingPreviews([broken], (p) => repaired.push(p));

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ rating: 4, keywords: ["dusk"], width: 4000 });
    expect(h.saved[0].decodeError).toBeUndefined();
    expect(repaired).toEqual(h.saved);
  });

  it("stores nothing for a photo that left the catalog meanwhile", async () => {
    const broken = record("broken.jpg", { width: 0 });
    h.catalog = [];
    const repaired: CatalogPhoto[] = [];

    await repairMissingPreviews([broken], (p) => repaired.push(p));

    expect(h.saved).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("stores no preview built for a turn the photo no longer has", async () => {
    const broken = record("broken.jpg", { width: 0 });
    changeInCatalog(broken, { rotation: 90 });

    await repairMissingPreviews([broken]);

    expect(h.saved).toEqual([]);
  });

  it("keeps a change made meanwhile when every preview is rebuilt", async () => {
    const photo = record("a.jpg", { width: 100, height: 75 });
    changeInCatalog(photo, { flag: "pick" });

    await rebuildThumbnails([photo]);

    expect(h.saved[0]).toMatchObject({ flag: "pick", width: 4000 });
  });

  it("keeps a change made meanwhile when a photo is imported again", async () => {
    const photo = record("a.jpg", { width: 100, height: 75 });
    changeInCatalog(photo, { colorLabel: "red" });

    const result = await reimportPhotos([photo]);

    expect(result).toEqual({ ok: 1, failed: 0 });
    expect(h.saved[0]).toMatchObject({ colorLabel: "red", width: 4000 });
  });

  it("keeps a change made meanwhile when an imported-again photo won't decode", async () => {
    h.blobSize = { width: 0, height: 0 };
    const photo = record("a.jpg", { width: 100, height: 75 });
    changeInCatalog(photo, { colorLabel: "red" });

    const result = await reimportPhotos([photo]);

    expect(result).toEqual({ ok: 0, failed: 1 });
    expect(h.saved[0]).toMatchObject({ colorLabel: "red", width: 100 });
    expect(h.saved[0].decodeError).toBeTruthy();
  });

  it("counts a photo removed or turned meanwhile neither as re-imported nor as unreadable", async () => {
    const removed = record("gone.jpg", { width: 100, height: 75 });
    const turned = record("turned.jpg", { width: 100, height: 75 });
    h.catalog = h.catalog.filter((p) => p.id !== removed.id);
    changeInCatalog(turned, { rotation: 90 });

    const result = await reimportPhotos([removed, turned]);

    expect(result).toEqual({ ok: 0, failed: 0 });
    expect(h.saved).toEqual([]);
  });

  it("gives an imported-again RAW that won't decode its own decode's reason", async () => {
    h.blobSize = { width: 0, height: 0 };
    const photo = record("a.NEF", { width: 100, height: 75 });

    await reimportPhotos([photo]);

    expect(h.saved[0].decodeError).toBe("This RAW file can't be decoded.");
  });

  it("doesn't count an unreadable photo removed meanwhile as unreadable", async () => {
    h.blobSize = { width: 0, height: 0 };
    const removed = record("gone.jpg", { width: 100, height: 75 });
    h.catalog = [];

    const result = await reimportPhotos([removed]);

    expect(result).toEqual({ ok: 0, failed: 0 });
  });
});

describe("what a pass hands on to the catalog", () => {
  // Only the fields it changed: the catalog takes them onto the photo as it holds
  // it once the preview is written, and another window may have turned the photo
  // during that write.
  const keys = (changes: RebuiltChange[]) => changes.map((change) => Object.keys(change).sort());

  it("a repair hands on the preview, its size and the cleared reason", async () => {
    const broken = record("broken.jpg", { width: 0, height: 0, decodeError: "RAW decode failed" });
    const changes: RebuiltChange[] = [];

    await repairMissingPreviews([broken], (_photo, change) => changes.push(change));

    expect(keys(changes)).toEqual([
      ["decodeError", "height", "thumbnailBlob", "thumbnailUrl", "width"],
    ]);
    expect(changes[0]).toMatchObject({ width: 4000, height: 3000 });
  });

  it("a rebuild that keeps the size hands on the preview alone", async () => {
    const photo = record("a.jpg", { width: 4000, height: 3000 });
    const changes: RebuiltChange[] = [];

    await rebuildThumbnails([photo], undefined, (_photo, change) => changes.push(change));

    expect(keys(changes)).toEqual([["thumbnailBlob", "thumbnailUrl"]]);
  });

  it("a re-import hands on the details it read again and the new preview", async () => {
    const photo = record("a.jpg", { width: 4000, height: 3000, dateCreated: 1_600_000_000_000 });
    const changes: RebuiltChange[] = [];

    await reimportPhotos([photo], undefined, (_photo, change) => changes.push(change));

    expect(keys(changes)).toEqual([["exif", "thumbnailBlob", "thumbnailUrl"]]);
  });

  // A preview built from the file shows no edit, whatever the one it replaces
  // showed, so Develop must not take it for the edited look.
  describe("of a photo whose preview showed its edit", () => {
    const EDIT = "0123456789abcdef";

    it("a repair hands on that the new preview shows no edit", async () => {
      const broken = record("broken.jpg", { width: 0, height: 0, previewEdit: EDIT });
      const changes: RebuiltChange[] = [];

      await repairMissingPreviews([broken], (_photo, change) => changes.push(change));

      expect(keys(changes)[0]).toContain("previewEdit");
      expect(changes[0].previewEdit).toBeUndefined();
      expect(h.saved[0].previewEdit).toBeUndefined();
    });

    it("a rebuild hands on that the new preview shows no edit", async () => {
      const photo = record("a.jpg", { width: 4000, height: 3000, previewEdit: EDIT });
      const changes: RebuiltChange[] = [];

      await rebuildThumbnails([photo], undefined, (_photo, change) => changes.push(change));

      expect(keys(changes)).toEqual([["previewEdit", "thumbnailBlob", "thumbnailUrl"]]);
      expect(changes[0].previewEdit).toBeUndefined();
      expect(h.saved[0].previewEdit).toBeUndefined();
    });

    it("a re-import hands on that the new preview shows no edit", async () => {
      const photo = record("a.jpg", { width: 4000, height: 3000, previewEdit: EDIT });
      const changes: RebuiltChange[] = [];

      await reimportPhotos([photo], undefined, (_photo, change) => changes.push(change));

      expect(keys(changes)[0]).toContain("previewEdit");
      expect(changes[0].previewEdit).toBeUndefined();
      expect(h.saved[0].previewEdit).toBeUndefined();
    });

    it("a re-import that keeps the preview keeps the edit it shows", async () => {
      h.blobSize = { width: 0, height: 0 };
      const photo = record("a.jpg", { width: 4000, height: 3000, previewEdit: EDIT });
      const changes: RebuiltChange[] = [];

      await reimportPhotos([photo], undefined, (_photo, change) => changes.push(change));

      expect(keys(changes)[0]).not.toContain("previewEdit");
      expect(h.saved[0].previewEdit).toBe(EDIT);
    });
  });
});

describe("preDecodeRawsForCache", () => {
  // The pre-fill shares libraw with Develop; it must not hold up the photo the
  // user opens while it runs.
  it("decodes as background work", async () => {
    await preDecodeRawsForCache([record("DSC_0001.NEF")], { force: true });
    expect(h.floatDecodes).toEqual([true]);
  });
});

// Develop refuses to remember a marginal decode and rejects one whose colours
// disagree with the camera's own preview; the background pass has to hold the
// same line, or a bad frame is cached once and served on every later open.
describe("preDecodeRawsForCache choosing what to remember", () => {
  const key = "DSC_0001.NEF:64:0";

  beforeEach(() => {
    h.rawFloat = { width: 4, height: 2, oriented: true };
  });

  it("writes a decode the check accepts", async () => {
    await preDecodeRawsForCache([record("DSC_0001.NEF")], { force: true });
    expect(h.cacheWrites).toEqual([[key, 4, 2]]);
  });

  it("does not write a decode the check will not have cached (a suspicious one)", async () => {
    h.rawFloat = { width: 4, height: 2, oriented: true, suspicious: true };
    h.verdict = { use: true, cache: false };

    await preDecodeRawsForCache([record("DSC_0001.NEF")], { force: true });

    expect(h.cacheWrites).toEqual([]);
    expect(h.judged).toHaveLength(1);
  });

  it("does not write a decode whose colours the check rejected", async () => {
    h.verdict = { use: false, cache: false };

    await preDecodeRawsForCache([record("DSC_0001.NEF")], { force: true });

    expect(h.cacheWrites).toEqual([]);
    expect(h.judged).toHaveLength(1);
  });

  it("judges the decode as it will be cached, against the embedded preview", async () => {
    const preview = new Blob(["jpeg"], { type: "image/jpeg" });
    h.embedded = preview;
    h.rawFloat = { width: 4, height: 2, oriented: false, suspicious: true };

    await preDecodeRawsForCache([record("DSC_0001.NEF", { rotation: 90 })], { force: true });

    expect(h.judged).toEqual([{ suspicious: true, size: [2, 4], preview }]);
  });

  it("judges without a preview when the camera embedded none, and still writes", async () => {
    h.embedded = null;

    await preDecodeRawsForCache([record("DSC_0001.NEF")], { force: true });

    expect(h.judged).toEqual([{ suspicious: undefined, size: [4, 2], preview: null }]);
    expect(h.cacheWrites).toEqual([[key, 4, 2]]);
  });

  // libraw fails the same way on every pass for an unsupported body; the
  // preview is only worth reading once there is a decode to judge.
  it("leaves the embedded preview alone when libraw has no decode", async () => {
    h.rawFloat = null;

    await preDecodeRawsForCache([record("DSC_0001.NEF")], { force: true });

    expect(h.previewReads).toBe(0);
    expect(h.judged).toEqual([]);
    expect(h.cacheWrites).toEqual([]);
  });

  it("counts a rejected decode as done", async () => {
    h.verdict = { use: false, cache: false };
    const progress: [number, number][] = [];

    await preDecodeRawsForCache([record("DSC_0001.NEF")], {
      force: true,
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(progress).toEqual([[0, 1], [1, 1]]);
  });
});
