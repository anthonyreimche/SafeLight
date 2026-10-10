// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop opening RAWs whose libraw decode never answers: once the decode has
// had its time, each open settles on the camera's embedded preview, and the
// next photo decodes on the instances the hung ones were replaced with. The
// decode chain is real from load-image.ts down to the libraw pool; libraw's
// instances are faked (a file whose first byte is 1 hangs), and time is fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

const HANG = 1;
const SIZE = 128 * 1024;

const h = vi.hoisted(() => ({
  /** The first byte of each file libraw was handed. */
  opened: [] as number[],
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    worker = { terminate: () => {} };
    open(data: Uint8Array): Promise<void> {
      h.opened.push(data[0]);
      return data[0] === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    }
    async metadata(): Promise<Record<string, unknown>> {
      return { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
    }
    async imageData(): Promise<unknown> {
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
  acceptDecode: async () => ({ use: true, cache: true }),
}));

vi.mock("@/modules/library/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/raw-preview")>()),
  extractRawPreview: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheMaxEdge: 3072 }),
}));

vi.mock("./storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: [] }) },
}));

import { loadPhotoImage, type DecodedImage } from "./load-image";
import { decodeTimeLimit } from "@/raw/libraw-wasm-adapter";
import { disposeDecodePool } from "@/raw/decode-pool";

function rawPhoto(name: string, firstByte: number): CatalogPhoto {
  const bytes = new Uint8Array(SIZE);
  bytes[0] = firstByte;
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

interface Tracked {
  image?: DecodedImage | null;
  done: boolean;
}

/** Settles a load into a readable state without waiting on it forever. */
function track(load: Promise<DecodedImage | null>): Tracked {
  const state: Tracked = { done: false };
  void load.then((image) => {
    state.image = image;
    state.done = true;
  });
  return state;
}

beforeEach(() => {
  h.opened = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal(
    "createImageBitmap",
    async (): Promise<ImageBitmap> => ({ width: 6000, height: 4000, close() {} }) as ImageBitmap,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Develop and decodes that never answer", () => {
  it("settles each open on the embedded preview, and the next photo still decodes", async () => {
    const previews: DecodedImage[] = [];
    const hung = ["A.ARW", "B.ARW", "C.ARW"].map((name) =>
      track(loadPhotoImage(rawPhoto(name, HANG), { onPreview: (p) => previews.push(p) })),
    );
    await vi.advanceTimersByTimeAsync(0);
    const next = track(loadPhotoImage(rawPhoto("D.ARW", 0)));

    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));
    await vi.advanceTimersByTimeAsync(0);

    expect(previews).toHaveLength(3);
    expect(hung.map((load) => load.done)).toEqual([true, true, true]);
    expect(hung.map((load) => load.image?.kind)).toEqual(["bitmap", "bitmap", "bitmap"]);
    expect(next.done).toBe(true);
    expect(next.image).toMatchObject({ kind: "float", width: 2, height: 2 });
    expect(h.opened).toEqual([HANG, HANG, HANG, 0]);
  });
});
