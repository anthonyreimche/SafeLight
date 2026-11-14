// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW opened in Develop with no cache entry shows its camera preview while
// libraw decodes. Finding that preview already decodes it, to prove the browser
// can; the stand-in is painted from that decode, not from a second one. The
// preview is read once more, small, for the colour check on the decode: that
// read begins as soon as the preview is found, not after libraw has answered.
// The chain is real from load-image.ts down to the libraw pool and the preview
// search; libraw's instances and the image decoder are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

const SIZE = 128 * 1024;

// A complete minimal baseline JPEG: 6000×4000 SOF0, one entropy pair, EOI.
const EMBEDDED_JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x0f, 0xa0, 0x17, 0x70, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x02, 0x11, 0x22,
  0xff, 0xd9,
]);

type Read = "full" | "sample";

const h = vi.hoisted(() => ({
  /** Each read of the preview by the image decoder: whole, or the small sample. */
  reads: [] as ("full" | "sample")[],
  /** The whole-preview bitmaps closed. */
  closed: 0,
  /** Lets libraw answer; unset, it answers at once. */
  answer: null as Promise<void> | null,
  /** What the colour check was handed as the sample begun for it. */
  sampled: [] as unknown[],
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    worker = { terminate: () => {} };
    async open(): Promise<void> {}
    async metadata(): Promise<Record<string, unknown>> {
      return { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
    }
    async imageData(): Promise<unknown> {
      await h.answer;
      return new Uint16Array(2 * 2 * 3).fill(12000);
    }
  },
}));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async () => null,
  writeCachedPreview: async () => {},
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async (_decode: unknown, _upright: unknown, _preview: unknown, sampled: unknown) => {
    h.sampled.push(sampled);
    return { use: true, cache: true };
  },
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheMaxEdge: 3072 }),
}));

vi.mock("./storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: [] }) },
}));

import { loadPhotoImage, type DecodedImage } from "./load-image";
import { disposeDecodePool } from "@/raw/decode-pool";

function rawPhoto(name: string): CatalogPhoto {
  const bytes = new Uint8Array(SIZE);
  bytes.set(EMBEDDED_JPEG, 4096);
  const file = new File([bytes], name);
  return {
    id: name,
    filename: name,
    relPath: name,
    folder: "",
    directoryHandle: null,
    fileHandle: { kind: "file", name, getFile: async () => file } as FileSystemFileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: SIZE,
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

const fullReads = () => h.reads.filter((read: Read) => read === "full");

beforeEach(() => {
  h.reads = [];
  h.closed = 0;
  h.answer = null;
  h.sampled = [];
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal(
    "createImageBitmap",
    async (_src: Blob, opts?: ImageBitmapOptions): Promise<ImageBitmap> => {
      const sample = opts?.resizeWidth !== undefined;
      h.reads.push(sample ? "sample" : "full");
      return {
        width: sample ? 64 : 6000,
        height: sample ? 64 : 4000,
        close: () => {
          if (!sample) h.closed++;
        },
      } as ImageBitmap;
    },
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the camera preview of a RAW opened with no cache entry", () => {
  it("is decoded whole once for the stand-in Develop paints", async () => {
    const previews: DecodedImage[] = [];

    const image = await loadPhotoImage(rawPhoto("A.ARW"), { onPreview: (p) => previews.push(p) });

    expect(image).toMatchObject({ kind: "float", width: 2, height: 2 });
    expect(previews.map((p) => p.kind)).toEqual(["bitmap"]);
    expect(fullReads()).toHaveLength(1);
    expect(h.closed).toBe(0);
  });

  it("is decoded whole once to find it, and closed, when nothing paints it", async () => {
    await loadPhotoImage(rawPhoto("B.ARW"));

    expect(fullReads()).toHaveLength(1);
    expect(h.closed).toBe(1);
  });

  it("has its sample for the colour check under way before libraw answers", async () => {
    let answer = (): void => {};
    h.answer = new Promise((resolve) => (answer = resolve));

    const loading = loadPhotoImage(rawPhoto("C.ARW"), { onPreview: () => {} });
    await vi.waitFor(() => expect(h.reads).toContain("sample"));
    expect(h.sampled).toEqual([]);

    answer();
    await loading;

    expect(h.reads.filter((read: Read) => read === "sample")).toHaveLength(1);
    expect(h.sampled).toHaveLength(1);
    expect(h.sampled[0]).toBeInstanceOf(Promise);
  });
});
