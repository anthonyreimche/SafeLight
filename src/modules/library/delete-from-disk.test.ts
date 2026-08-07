// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";

const h = vi.hoisted(() => ({
  photos: [] as CatalogPhoto[],
  removePhotos: vi.fn(),
  trash: vi.fn(async (_p: string): Promise<void> => {}),
  exists: vi.fn(async (_p: string): Promise<boolean> => false),
  deleteCachedPreview: vi.fn(async (_k: string): Promise<void> => {}),
  bridge: null as Partial<NativeFsBridge> | null,
}));

vi.mock("@/project/native-fs", () => ({
  nativeFs: () => h.bridge,
  nativePathOf: (handle: unknown) =>
    (handle as { path?: string } | null)?.path ?? null,
}));

vi.mock("@/raw/raw-cache", () => ({
  deleteCachedPreview: h.deleteCachedPreview,
  rawCacheKey: (relPath: string, fileSize: number, rotation = 0) =>
    `${relPath}|${fileSize}|${rotation}`,
}));

vi.mock("@/project/folder-ops", () => ({ SIDECAR_SUFFIX: ".safelight.json" }));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: {
    getState: () => ({ photos: h.photos, removePhotos: h.removePhotos }),
  },
}));

import { deletePhotosFromDisk, diskTrashAvailable } from "./delete-from-disk";

function fakePhoto(
  id: string,
  path: string | null,
  over: Partial<CatalogPhoto> = {},
): CatalogPhoto {
  return {
    id,
    filename: `${id}.NEF`,
    relPath: `${id}.NEF`,
    fileSize: 25_000_000,
    rotation: 0,
    fileHandle: path ? { path } : { name: `${id}.NEF` },
    ...over,
  } as unknown as CatalogPhoto;
}

beforeEach(() => {
  h.photos = [];
  h.removePhotos.mockClear();
  h.trash.mockClear().mockResolvedValue(undefined);
  h.exists.mockClear().mockResolvedValue(false);
  h.deleteCachedPreview.mockClear();
  h.bridge = { trash: h.trash, exists: h.exists };
});

describe("diskTrashAvailable", () => {
  it("is true only when the privileged bridge exposes trash", () => {
    expect(diskTrashAvailable()).toBe(true);
    h.bridge = {};
    expect(diskTrashAvailable()).toBe(false);
    h.bridge = null;
    expect(diskTrashAvailable()).toBe(false);
  });
});

describe("deletePhotosFromDisk", () => {
  it("moves selected photos to the trash and removes them from the catalog", async () => {
    h.photos = [fakePhoto("a", "D:/pics/a.NEF"), fakePhoto("b", "D:/pics/b.NEF")];
    const r = await deletePhotosFromDisk(["a", "b"]);
    expect(h.trash).toHaveBeenCalledWith("D:/pics/a.NEF");
    expect(h.trash).toHaveBeenCalledWith("D:/pics/b.NEF");
    expect(h.removePhotos).toHaveBeenCalledWith(["a", "b"]);
    expect(r).toMatchObject({ deleted: 2, skippedCopies: 0, failed: [] });
  });

  it("keeps a photo in the catalog when trashing its file fails", async () => {
    h.photos = [fakePhoto("a", "D:/pics/a.NEF"), fakePhoto("b", "D:/pics/b.NEF")];
    h.trash.mockImplementation(async (p: string) => {
      if (p.includes("a.NEF")) throw new Error("EBUSY: locked");
    });
    const r = await deletePhotosFromDisk(["a", "b"]);
    expect(h.removePhotos).toHaveBeenCalledWith(["b"]);
    expect(r.deleted).toBe(1);
    expect(r.failed).toEqual([{ filename: "a.NEF", message: "EBUSY: locked" }]);
  });

  it("skips virtual copies — they don't own a file on disk", async () => {
    h.photos = [fakePhoto("copy", "D:/pics/a.NEF", { copyOf: "a" })];
    const r = await deletePhotosFromDisk(["copy"]);
    expect(h.trash).not.toHaveBeenCalled();
    expect(h.removePhotos).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deleted: 0, skippedCopies: 1 });
  });

  it("fails a photo that has no native path instead of throwing", async () => {
    h.photos = [fakePhoto("a", null)];
    const r = await deletePhotosFromDisk(["a"]);
    expect(h.trash).not.toHaveBeenCalled();
    expect(r.deleted).toBe(0);
    expect(r.failed).toHaveLength(1);
  });

  it("trashes the sidecar next to the file when one exists", async () => {
    h.photos = [fakePhoto("a", "D:/pics/a.NEF")];
    h.exists.mockImplementation(async (p: string) => p.endsWith(".safelight.json"));
    await deletePhotosFromDisk(["a"]);
    expect(h.trash).toHaveBeenCalledWith("D:/pics/a.NEF.safelight.json");
  });

  it("purges the photo's raw-cache entry", async () => {
    h.photos = [fakePhoto("a", "D:/pics/a.NEF", { rotation: 90 })];
    await deletePhotosFromDisk(["a"]);
    expect(h.deleteCachedPreview).toHaveBeenCalledWith("a.NEF|25000000|90");
  });

  it("reports every photo as failed when the bridge is unavailable", async () => {
    h.photos = [fakePhoto("a", "D:/pics/a.NEF")];
    h.bridge = null;
    const r = await deletePhotosFromDisk(["a"]);
    expect(r.deleted).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(h.removePhotos).not.toHaveBeenCalled();
  });
});
