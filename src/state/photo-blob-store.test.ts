// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension reads the data it keeps for the open photo, or for any photo it
// names: a stage texture made for a thumbnail or an export of another photo
// must come from that photo's own data (SafeLight #278).

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogStorage, type CatalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "./catalog-store";
import { useDevelopStore } from "./develop-store";
import { getPhotoData, putPhotoData } from "./photo-blob-store";

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

describe("putPhotoData", () => {
  function writable() {
    const written: { photoId: string; key: string; data: Uint8Array | null }[] = [];
    const release: (() => void)[] = [];
    const fake = {
      getPhotoBlob: async () => null,
      putPhotoBlob: (photoId: string, key: string, data: Uint8Array | null) =>
        new Promise<void>((resolve) => {
          written.push({ photoId, key, data });
          release.push(resolve);
        }),
    } as unknown as CatalogStorage;
    return { fake, written, release };
  }

  it("writes the open photo's blob when no photo is named", () => {
    const { fake, written, release } = writable();
    setCatalogStorage(fake);
    inCatalogue("open", "other");
    useDevelopStore.setState({ photoId: "open" });
    putPhotoData("acme.lut", new Uint8Array([7]));
    expect(written).toEqual([{ photoId: "open", key: "acme.lut", data: new Uint8Array([7]) }]);
    release[0]();
  });

  it("writes another photo's blob when it is named, and a read of it sees it before the write lands", async () => {
    const { fake, written, release } = writable();
    setCatalogStorage(fake);
    inCatalogue("open", "other");
    useDevelopStore.setState({ photoId: "open" });
    putPhotoData("acme.lut", new Uint8Array([9]), "other");
    expect(written).toEqual([{ photoId: "other", key: "acme.lut", data: new Uint8Array([9]) }]);
    expect(await getPhotoData("acme.lut", "other")).toEqual(new Uint8Array([9]));
    expect(await getPhotoData("acme.lut")).toBeNull();
    release[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(await getPhotoData("acme.lut", "other")).toBeNull();
  });

  it("sees a pending delete as no data, and writes nothing for a photo the catalogue doesn't hold or an id with a dot", async () => {
    const { fake, written, release } = writable();
    setCatalogStorage({ ...fake, getPhotoBlob: async () => new Uint8Array([1]) } as unknown as CatalogStorage);
    inCatalogue("other", "o.x");
    putPhotoData("acme.lut", null, "other");
    expect(await getPhotoData("acme.lut", "other")).toBeNull();
    putPhotoData("acme.lut", new Uint8Array([2]), "gone");
    putPhotoData("acme.lut", new Uint8Array([2]), "o.x");
    expect(written).toHaveLength(1);
    release[0]();
  });

  it("warns instead of throwing when the write is refused, and reads fall back to storage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setCatalogStorage({
      getPhotoBlob: async () => null,
      putPhotoBlob: () => Promise.reject(new Error("read-only folder")),
    } as unknown as CatalogStorage);
    inCatalogue("open");
    useDevelopStore.setState({ photoId: "open" });
    putPhotoData("acme.lut", new Uint8Array([7]));
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/acme.lut.*read-only folder/);
    expect(await getPhotoData("acme.lut")).toBeNull();
    warn.mockRestore();
  });
});
