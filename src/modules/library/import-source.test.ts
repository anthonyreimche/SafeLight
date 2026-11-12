// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo of a library source is imported from what the source lists alone: the
// grid reads the source's preview when the photo comes into view, and the
// original stays on the source until something opens it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  thumbs: [] as { width: number; height: number; rotation: number; maxSize: number }[],
  bitmap: { width: 768, height: 512 },
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ thumbMaxEdge: 768, previewSource: "auto" }),
}));
vi.mock("./import-thumb-task", () => ({
  createThumbnail: async (bitmap: ImageBitmap, rotation: number, maxSize: number) => {
    h.thumbs.push({ width: bitmap.width, height: bitmap.height, rotation, maxSize });
    return new Blob(["jpeg"], { type: "image/jpeg" });
  },
}));

import { buildPreviewBlob, importPhoto } from "./import-record";
import {
  bindSourceCache,
  dropLibrarySources,
  registerLibrarySource,
  sourceRoot,
  type LibrarySourceContribution,
  type LibrarySourceItem,
} from "@/project/library-sources";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import type { CatalogPhoto } from "@/catalog/types";

const RAW: LibrarySourceItem = {
  key: "a1",
  name: "IMG_0001.CR3",
  size: 25_000_000,
  modified: 1_700_000_000_000,
  taken: 1_699_000_000_000,
  width: 6000,
  height: 4000,
  mimeType: "image/x-canon-cr3",
  exif: { cameraMake: "Canon", cameraModel: "EOS R5", iso: 400, orientation: 6, dateTimeOriginal: "2023:11:03 08:26:40" },
  rating: 4,
  keywords: ["trip"],
};

let src: LibrarySourceContribution;

async function handleFor(item: LibrarySourceItem) {
  const root = sourceRoot("test.server")!;
  bindSourceCache(root, fsaDirectoryHandle(new MemoryFs("/sl"), "/sl"));
  const folder = await root.getDirectoryHandle("Trip");
  return { folder, file: await folder.getFileHandle(item.name) };
}

beforeEach(() => {
  h.thumbs = [];
  h.bitmap = { width: 768, height: 512 };
  vi.stubGlobal("createImageBitmap", async () => ({ ...h.bitmap, close: () => {} }));
  src = {
    id: "test.server",
    name: "Server",
    library: "lib",
    list: async () => ({ folders: [{ name: "Trip", items: [RAW] }] }),
    readPreview: vi.fn(async () => new Blob(["webp"], { type: "image/webp" })),
    readOriginal: vi.fn(async () => new Blob(["never"])),
  };
  registerLibrarySource("ext.a", src);
});

afterEach(() => {
  dropLibrarySources("ext.a");
  vi.unstubAllGlobals();
});

describe("importing a library source's photo", () => {
  it("builds its record from the listing alone, reading neither the preview nor the original", async () => {
    const { folder, file } = await handleFor(RAW);
    const photo = await importPhoto(file, folder);
    expect(src.readOriginal).not.toHaveBeenCalled();
    expect(src.readPreview).not.toHaveBeenCalled();
    expect(photo).toMatchObject({
      filename: "IMG_0001.CR3",
      fileHandle: file,
      directoryHandle: folder,
      fileSize: 25_000_000,
      mimeType: "image/x-canon-cr3",
      rating: 4,
      keywords: ["trip"],
      colorLabel: "none",
      flag: "none",
      exif: RAW.exif,
      rotation: 90,
      width: 6000,
      height: 4000,
    });
    expect(photo!.dateCreated).toBe(new Date(2023, 10, 3, 8, 26, 40).getTime());
    expect(photo).toMatchObject({ thumbnailBlob: null, thumbnailUrl: null });
    expect(photo!.metadataPending).toBeUndefined();
  });

  it("has no size until it is opened when the source lists none", async () => {
    registerLibrarySource("ext.a", { ...src, list: async () => ({ folders: [{ name: "Trip", items: [{ key: "b", name: "b.jpg" }] }] }) });
    const { folder, file } = await handleFor({ key: "b", name: "b.jpg" });
    expect(await importPhoto(file, folder)).toMatchObject({ width: 0, height: 0, fileSize: 0, rating: 0 });
  });

  it("builds its grid preview from the source's preview, not the original", async () => {
    const { folder, file } = await handleFor(RAW);
    const photo = (await importPhoto(file, folder)) as CatalogPhoto;
    const blob = await buildPreviewBlob(photo);
    expect(blob).toBeInstanceOf(Blob);
    expect(src.readPreview).toHaveBeenCalledWith(expect.objectContaining({ key: "a1" }), expect.objectContaining({ maxEdge: 768 }));
    expect(h.thumbs).toEqual([{ width: 768, height: 512, rotation: 0, maxSize: 768 }]);
    expect(src.readOriginal).not.toHaveBeenCalled();
  });

  it("turns the source's upright preview by a manual turn only", async () => {
    const { folder, file } = await handleFor(RAW);
    const photo = (await importPhoto(file, folder)) as CatalogPhoto;
    await buildPreviewBlob({ ...photo, rotation: 180 }); // EXIF 90 + a manual 90
    expect(h.thumbs).toEqual([{ width: 768, height: 512, rotation: 90, maxSize: 768 }]);
  });

  it("builds nothing once the grid no longer wants it", async () => {
    const { folder, file } = await handleFor(RAW);
    const photo = (await importPhoto(file, folder)) as CatalogPhoto;
    const stop = new AbortController();
    stop.abort();
    expect(await buildPreviewBlob(photo, stop.signal)).toBeNull();
    expect(src.readPreview).not.toHaveBeenCalled();
  });
});

describe("a source's photo details of the wrong shape", () => {
  it("are left out, and the photo is imported with the rest", async () => {
    const odd = {
      key: "o",
      name: "odd.jpg",
      exif: {
        cameraMake: "Canon",
        dateTimeOriginal: 20240601,
        iso: "400",
        orientation: 9,
        focalLength: 50,
        unknownTag: "x",
        colorTemperature: 3200,
        baselineExposure: 2,
      },
      // What an extension may hand over, whatever its types say.
    } as unknown as LibrarySourceItem;
    registerLibrarySource("ext.a", { ...src, list: async () => ({ folders: [{ name: "Trip", items: [odd] }] }) });
    const { folder, file } = await handleFor(odd);
    const photo = await importPhoto(file, folder);
    expect(photo?.exif).toEqual({ cameraMake: "Canon", focalLength: 50 });
    expect(photo?.rotation).toBe(0);
  });
});
