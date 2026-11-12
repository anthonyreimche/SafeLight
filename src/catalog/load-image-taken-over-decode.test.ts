// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop decodes the next photo ahead of time, for the photo that is open. Step
// onto that next photo while its decode runs and the open photo is left, which
// abandons the decode: libraw can't be stopped, so it ran to its end for nobody
// while the photo now open began the same decode again. The opened photo takes
// the running decode over instead. The chain is real from load-image.ts down to
// the libraw pool; libraw's instances are faked and answer when the test says.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "./types";

const SIZE = 128 * 1024;

const h = vi.hoisted(() => ({
  /** One per decode libraw began, in order: call it to let that decode answer,
   *  with pixels unless told libraw failed. */
  answers: [] as ((failed?: "failed") => void)[],
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    worker = { terminate: () => {} };
    async open(): Promise<void> {}
    async metadata(): Promise<Record<string, unknown>> {
      return { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
    }
    imageData(): Promise<unknown> {
      return new Promise((resolve) => {
        h.answers.push((failed) =>
          resolve(failed ? undefined : new Uint16Array(2 * 2 * 3).fill(12000)),
        );
      });
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

vi.mock("@/raw/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/raw/raw-preview")>()),
  extractRawPreview: async () => null,
  extractRawPreviewDecoded: async () => null,
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
  const file = new File([new Uint8Array(SIZE)], name);
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

const decodesBegun = (count: number) => vi.waitFor(() => expect(h.answers).toHaveLength(count));

/** Lets the pending loads run as far as they can without libraw answering. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The next photo's decode, begun ahead for the photo that is open and running. */
async function prefetching(photo: CatalogPhoto) {
  const openPhoto = new AbortController();
  const prefetched = loadPhotoImage(photo, { background: true, signal: openPhoto.signal });
  await decodesBegun(1);
  return { leaveOpenPhoto: () => openPhoto.abort(), prefetched };
}

const kindOf = (image: DecodedImage | null) => image?.kind ?? null;

beforeEach(() => {
  h.answers = [];
  vi.stubGlobal("Worker", class {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("opening the photo whose prefetch is still decoding", () => {
  it("takes the running decode over instead of beginning the same one again", async () => {
    const photo = rawPhoto("B.ARW");
    const { leaveOpenPhoto, prefetched } = await prefetching(photo);

    leaveOpenPhoto();
    const opened = loadPhotoImage(photo, { signal: new AbortController().signal });
    await settle();
    expect(h.answers).toHaveLength(1);

    h.answers[0]();
    expect(await opened).toMatchObject({ kind: "float", width: 2, height: 2 });
    expect(await prefetched).toBeNull();
    expect(h.answers).toHaveLength(1);
  });

  it("decodes for itself beside a decode whose own caller still waits for it", async () => {
    const photo = rawPhoto("B.ARW");
    const { prefetched } = await prefetching(photo);

    const opened = loadPhotoImage(photo);
    await decodesBegun(2);

    h.answers.forEach((answer) => answer());
    expect(kindOf(await opened)).toBe("float");
    expect(kindOf(await prefetched)).toBe("float");
  });

  it("decodes for itself when it asks for another frame than the one running", async () => {
    const photo = rawPhoto("B.ARW");
    const { leaveOpenPhoto, prefetched } = await prefetching(photo);

    leaveOpenPhoto();
    const turned = loadPhotoImage({ ...photo, rotation: 90 });
    await decodesBegun(2);

    h.answers.forEach((answer) => answer());
    expect(await turned).toMatchObject({ kind: "float" });
    expect(await prefetched).toBeNull();
  });

  it("hands the decode to the last of several opens that each left in turn", async () => {
    const photo = rawPhoto("B.ARW");
    const { leaveOpenPhoto, prefetched } = await prefetching(photo);
    leaveOpenPhoto();

    const first = new AbortController();
    const firstOpen = loadPhotoImage(photo, { signal: first.signal });
    await settle();
    first.abort();
    const secondOpen = loadPhotoImage(photo);
    await settle();

    h.answers[0]();
    expect(kindOf(await secondOpen)).toBe("float");
    expect(await firstOpen).toBeNull();
    expect(await prefetched).toBeNull();
    expect(h.answers).toHaveLength(1);
  });

  it("gives nobody the frame once the open that took the decode over has left too", async () => {
    const photo = rawPhoto("B.ARW");
    const { leaveOpenPhoto, prefetched } = await prefetching(photo);
    leaveOpenPhoto();
    const open = new AbortController();
    const opened = loadPhotoImage(photo, { signal: open.signal });
    await settle();

    open.abort();
    h.answers[0]();

    expect(await opened).toBeNull();
    expect(await prefetched).toBeNull();
  });

  it("learns from the decode it took over that libraw can't read the file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const photo = rawPhoto("B.ARW");
    const { leaveOpenPhoto, prefetched } = await prefetching(photo);
    leaveOpenPhoto();
    const opened = loadPhotoImage(photo);
    await settle();

    h.answers[0]("failed");

    expect(kindOf(await opened)).not.toBe("float");
    expect(await prefetched).toBeNull();
    expect(h.answers).toHaveLength(1);
  });

  it("decodes again for a photo opened after the abandoned decode has ended", async () => {
    const photo = rawPhoto("B.ARW");
    const { leaveOpenPhoto, prefetched } = await prefetching(photo);
    leaveOpenPhoto();
    h.answers[0]();
    await prefetched;

    const opened = loadPhotoImage(photo);
    await decodesBegun(2);
    h.answers[1]();

    expect(kindOf(await opened)).toBe("float");
  });
});
