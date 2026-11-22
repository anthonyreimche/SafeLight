// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension reads the data it keeps for the open photo, or for any photo it
// names: a stage texture made for a thumbnail or an export of another photo
// must come from that photo's own data (SafeLight #278).

import { afterEach, describe, expect, it } from "vitest";
import { setCatalogStorage, type CatalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "./catalog-store";
import { useDevelopStore } from "./develop-store";
import { getPhotoData } from "./photo-blob-store";

const blobs = new Map([
  ["open:acme.lut", new Uint8Array([1])],
  ["other:acme.lut", new Uint8Array([2])],
  ["other.x:acme.lut", new Uint8Array([3])],
]);

const inCatalogue = (...ids: string[]) =>
  useCatalogStore.setState({ photos: ids.map((id) => ({ id }) as ReturnType<typeof useCatalogStore.getState>["photos"][number]) });

const storage = {
  getPhotoBlob: async (photoId: string, key: string) => blobs.get(`${photoId}:${key}`) ?? null,
} as unknown as CatalogStorage;

afterEach(() => {
  setCatalogStorage(null);
  useCatalogStore.setState({ photos: [] });
  useDevelopStore.setState({ photoId: null });
});

describe("getPhotoData", () => {
  it("reads the open photo's data, or a named photo's", async () => {
    setCatalogStorage(storage);
    inCatalogue("open", "other", "none");
    useDevelopStore.setState({ photoId: "open" });
    expect(await getPhotoData("acme.lut")).toEqual(new Uint8Array([1]));
    expect(await getPhotoData("acme.lut", "other")).toEqual(new Uint8Array([2]));
    expect(await getPhotoData("acme.lut", "none")).toBeNull();
  });

  // The blob's file is named "{photoId}.{key}", so an id with a dot, or one the
  // catalogue doesn't hold, could name another extension's blob.
  it("reads nothing for an id the catalogue doesn't hold, or one with a dot", async () => {
    setCatalogStorage(storage);
    inCatalogue("open", "other.x");
    expect(await getPhotoData("acme.lut", "other")).toBeNull();
    expect(await getPhotoData("acme.lut", "other.x")).toBeNull();
  });
});
