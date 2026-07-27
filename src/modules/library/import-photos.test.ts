// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, ExifData } from "@/catalog/types";

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
  } | null,
  colorTemperature: undefined as number | undefined,
  /** Photos handed to catalogStorage().putPhoto. */
  saved: [] as CatalogPhoto[],
}));

vi.mock("@/catalog/exif", () => ({
  parseExif: async (): Promise<ExifData> => ({ ...h.exif }),
  parseXmp: async (): Promise<XmpFields> => ({ ...h.xmp }),
  parseExifDate: (raw: string | undefined) => (raw ? h.exifDate : undefined),
}));

vi.mock("./raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./raw-preview")>()),
  extractRawPreview: async () => h.embedded,
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
  decodeRawToFloat: async () =>
    h.rawFloat
      ? {
          data: new Float32Array(h.rawFloat.width * h.rawFloat.height * 4).fill(0.5),
          width: h.rawFloat.width,
          height: h.rawFloat.height,
          oriented: h.rawFloat.oriented ?? false,
          colorTemperature: h.rawFloat.colorTemperature,
        }
      : null,
}));

vi.mock("@/raw/libraw-wasm-adapter", () => ({
  extractColorTemperature: async () => h.colorTemperature,
  lastLibRawStatus: "unsupported model",
}));

vi.mock("@/raw/decode-pool", () => ({ decodePoolSize: () => 2 }));

vi.mock("@/raw/raw-cache", () => ({
  cachedKeys: async () => new Set<string>(),
  deleteCachedPreview: async () => {},
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  writeCachedPreview: async () => {},
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ previewSource: h.previewSource, thumbMaxEdge: h.thumbMaxEdge }),
}));

vi.mock("@/catalog/storage", () => ({
  catalogStorage: () => ({
    putPhoto: async (photo: CatalogPhoto) => {
      h.saved.push(photo);
    },
  }),
}));

import {
  buildPhoto,
  buildPreviewBlob,
  isSupportedName,
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
 *  rebuild passes walk. */
function record(name: string, extra: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
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
}

beforeEach(() => {
  h.exif = {};
  h.xmp = {};
  h.exifDate = undefined;
  h.previewSource = "auto";
  h.thumbMaxEdge = 768;
  h.embedded = null;
  h.blobSize = { width: 4000, height: 3000 };
  h.rawBitmap = null;
  h.rawFloat = null;
  h.colorTemperature = undefined;
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
    expect(photo.decodeError).toBe("no decoder could read this file");
  });

  it("names the format in the failure reason so the grid can explain itself", async () => {
    h.blobSize = { width: 0, height: 0 };

    const raw = (await buildPhoto(file("a.NEF"), null, null))!;
    const tiff = (await buildPhoto(file("a.tif"), null, null))!;

    expect(raw.decodeError).toBe("RAW decode failed — unsupported model");
    expect(tiff.decodeError).toBe("TIFF decode failed (unsupported variant)");
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
    h.colorTemperature = 4800;
    h.rawBitmap = { width: 100, height: 100, oriented: false };

    const photo = (await buildPhoto(file("a.NEF"), null, null))!;

    expect(photo.exif.colorTemperature).toBe(4800);
  });

  it("keeps a white balance the file already declared", async () => {
    h.exif = { colorTemperature: 6100 };
    h.colorTemperature = 4800;
    h.rawBitmap = { width: 100, height: 100, oriented: false };

    const photo = (await buildPhoto(file("a.dng"), null, null))!;

    expect(photo.exif.colorTemperature).toBe(6100);
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
});
