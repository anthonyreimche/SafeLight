// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo turned while an edit's preview is rendered: the grid ends up showing
// the edit the new way round. The catalog store and edited-thumbnail run as they
// are; the render worker and the decoder are faked, and each render is labelled
// with the rotation it was made at.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

interface ThumbRender {
  key: string;
}

vi.mock("@/rendering/render-bridge", () => ({
  getRenderBridge: () => ({
    ready: Promise.resolve(),
    renderThumbnailFromSource: async ({ key }: ThumbRender) => new Blob([`edit at ${key}`]),
    renderThumbnailAsync: async () => null,
    uploadSource: () => {},
  }),
}));

vi.mock("@/catalog/load-image", () => ({
  loadPhotoImage: async () => null,
  photoSourceKey: (photo: CatalogPhoto) => `${photo.id}:${photo.rotation}`,
}));

vi.mock("@/catalog/orient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/catalog/orient")>()),
  rotateBlob: async (blob: Blob, deg: number) => new Blob([`${await blob.text()}+${deg}`]),
}));

vi.mock("@/project/project-store", () => ({
  useProjectStore: { getState: () => ({}) },
}));

import { catalogStorage, setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage, photo } from "@/catalog/stored-edit.fixtures";
import { normalizeParams } from "@/catalog/types";
import { useCatalogStore } from "./catalog-store";
import { regenerateEditedThumbnail } from "./edited-thumbnail";

class FakeChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const ID = "x";
const inStore = () => useCatalogStore.getState().photos[0];

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  installMemoryStorage();
  const shown = new Blob(["plain"]);
  useCatalogStore.setState({
    photos: [{ ...photo(ID), thumbnailBlob: shown, thumbnailUrl: URL.createObjectURL(shown) }],
  });
});

afterEach(() => {
  setCatalogStorage(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an edit's preview rendered while a turn is being written", () => {
  it("shows the edit the new way round", async () => {
    const storage = catalogStorage();
    let written = (): void => {};
    const writing = new Promise<void>((resolve) => (written = resolve));
    const turnWritten = vi.spyOn(storage, "putPhoto").mockImplementationOnce(async () => {
      await writing;
    });

    const turning = useCatalogStore.getState().rotatePhotos([ID], 90);
    await vi.waitFor(() => expect(turnWritten).toHaveBeenCalled());
    regenerateEditedThumbnail(ID, normalizeParams({ exposure: 1 }), 5000);
    await vi.waitFor(() => expect(storage.putPhoto).toHaveBeenCalledTimes(2));
    written();
    await turning;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inStore().rotation).toBe(90);
    await expect(inStore().thumbnailBlob?.text()).resolves.toBe(`edit at ${ID}:90`);
  });
});
