// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A change to a photo is stored with its record whether or not the preview it
// carries can be written, so the change shows in this window either way. The
// window runs its real storage and catalog store; only the disk refuses to write
// previews, as a full or locked one does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

// The plain-browser build: no native file bridge.
vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));

vi.mock("@/project/project-store", () => ({
  useProjectStore: { getState: () => ({}) },
}));

vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.nef$/i.test(name),
  buildPhoto: async () => null,
  buildPreviewBlob: async () => null,
}));

// Turning a preview bakes pixels through an OffscreenCanvas; a tagged blob stands in.
vi.mock("@/catalog/orient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/catalog/orient")>()),
  rotateBlob: async (blob: Blob, deg: number) => new Blob([`${await blob.text()}+${deg}`]),
}));

import { setCatalogStorage } from "@/catalog/storage";
import { photo } from "@/catalog/stored-edit.fixtures";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import { ProjectStorage } from "@/project/project-storage";
import { useCatalogStore } from "./catalog-store";
import { useSettings } from "./settings-store";

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** A disk that refuses to write previews while `full` is set. */
class FullFs extends MemoryFs {
  full = false;
  override async write(path: string, data: Uint8Array): Promise<void> {
    if (this.full && /[\\/]previews[\\/]/.test(path)) throw new Error("ENOSPC: no space left");
    return super.write(path, data);
  }
}

const ROOT = "/home/u/photos";
const storages: ProjectStorage[] = [];

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useSettings.setState({ persistPreviews: true });
  useCatalogStore.setState({ photos: [] });
});

afterEach(() => {
  setCatalogStorage(null);
  for (const storage of storages.splice(0)) storage.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Open a project holding x.NEF in this window, its photos showing previews the
 *  storage hasn't stored yet, on a disk that is full from now on. */
async function opened(): Promise<FullFs> {
  const fs = new FullFs(ROOT);
  const x = photo("x");
  fs.put(`${ROOT}/${x.relPath}`, "raw");
  fs.put(`${ROOT}/.safelight/catalog.json`, JSON.stringify({ version: 1, photos: [x], edits: [] }));
  const { storage, photos } = await ProjectStorage.open(fsaDirectoryHandle(fs, ROOT));
  storages.push(storage);
  setCatalogStorage(storage);
  useCatalogStore.setState({
    photos: photos.map((p) => ({ ...p, thumbnailBlob: new Blob([`shown:${p.id}`]) })),
  });
  fs.full = true;
  return fs;
}

const state = () => useCatalogStore.getState();
const x = (): CatalogPhoto | undefined => state().photos.find((p) => p.id === "x");

describe("a change whose preview can't be written", () => {
  it.each([
    ["a rating", () => state().setRating("x", 4), { rating: 4 }],
    ["a flag", () => state().setFlag("x", "pick"), { flag: "pick" }],
    ["a colour label", () => state().setColorLabel("x", "red"), { colorLabel: "red" }],
    ["a keyword", () => state().addKeyword("x", "sea"), { keywords: ["sea"] }],
    ["a copy name", () => state().setCopyName("x", "print"), { copyName: "print" }],
  ] as const)("shows %s, stored", async (_what, change, shows) => {
    await opened();

    await expect(change()).resolves.toBeUndefined();

    expect(x()).toMatchObject(shows);
    const [stored] = await storages[0].getAllPhotos();
    expect(stored).toMatchObject(shows);
  });

  it("shows a move, stored", async () => {
    await opened();
    const at = x();
    if (!at) throw new Error("x isn't shown");
    const moved = { ...at, relPath: "trip/x.NEF", folder: "trip" };

    await expect(state().relocatePhotos([moved])).resolves.toBeUndefined();

    expect(x()).toMatchObject({ relPath: "trip/x.NEF", folder: "trip" });
  });

  it("shows virtual copies, stored", async () => {
    await opened();
    const at = x();
    if (!at) throw new Error("x isn't shown");
    const copy = { ...at, id: "x-copy", copyOf: "x", thumbnailBlob: new Blob(["copy"]) };

    await expect(state().addPhotos([copy], { afterId: "x" })).resolves.toBeUndefined();

    expect(state().photos.map((p) => p.id)).toEqual(["x", "x-copy"]);
  });

  it("finishes a turn, stored", async () => {
    await opened();

    await expect(state().rotatePhotos(["x"], 90)).resolves.toBeUndefined();

    expect(x()).toMatchObject({ rotation: 90 });
    const [stored] = await storages[0].getAllPhotos();
    expect(stored).toMatchObject({ rotation: 90, previewRotation: 0 });
  });
});
