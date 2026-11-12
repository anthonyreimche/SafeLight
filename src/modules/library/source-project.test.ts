// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A library source opened as a project, through the real working-dir, scan,
// import and catalogue storage, over the desktop bridge on an in-memory disk:
// its photos become catalogue records, their previews read from the source and
// kept once the grid asks, the catalogue and edits live in the app data, and the
// next open finds them again with the source unreachable, the originals read
// before still there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";
import { normalizeParams, type EditState } from "@/catalog/types";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    thumbMaxEdge: 512,
    previewSource: "auto",
    persistPreviews: true,
    catalogLocation: "in-folder",
    externalCatalogDir: "",
  }),
}));
vi.mock("./import-thumb-task", () => ({ createThumbnail: async () => new Blob(["jpeg"], { type: "image/jpeg" }) }));

import { ProjectStorage, type ProjectStorageDeps } from "@/project/project-storage";
import { buildPreviewBlob, importPhoto, isSupportedName } from "./import-record";
import {
  dropLibrarySources,
  registerLibrarySource,
  sourceOffline,
  sourceRoot,
  type LibrarySourceContribution,
} from "@/project/library-sources";
import { MemoryFs } from "@/project/memory-fs.test-support";

const SL = "/data/source-catalogs/Server-1/.safelight";

const deps: ProjectStorageDeps = {
  isSupportedName,
  importPhoto,
  buildPreviewBlob: (photo) => buildPreviewBlob(photo),
  persistPreviews: () => true,
  emitPhotoImport: async () => null,
};

let online = true;
let source: LibrarySourceContribution;

beforeEach(() => {
  online = true;
  const mem = new MemoryFs("/data");
  h.fs = Object.assign(mem, {
    sourceCatalogDir: async () => {
      mem.mkdirp(SL);
      return SL;
    },
  });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 512, height: 341, close: () => {} }));
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
  source = {
    id: "test.server",
    name: "Server",
    library: "https://photos.example/#u1",
    list: vi.fn(async () => {
      if (!online) throw new TypeError("Failed to fetch");
      return {
        folders: [
          { name: "Trip", items: [{ key: "a1", name: "IMG_1.JPG", size: 4, width: 6000, height: 4000 }] },
          { name: "Home", items: [{ key: "b1", name: "DSC_2.NEF", size: 4 }, { key: "v1", name: "clip.MOV" }] },
        ],
      };
    }),
    readPreview: vi.fn(async () => {
      if (!online) throw new TypeError("Failed to fetch");
      return new Blob(["webp"]);
    }),
    readOriginal: vi.fn(async () => {
      if (!online) throw new TypeError("Failed to fetch");
      return new Blob(["orig"]);
    }),
  };
  registerLibrarySource("ext.a", source);
});

afterEach(() => {
  dropLibrarySources("ext.a");
  vi.unstubAllGlobals();
});

const mem = () => h.fs as MemoryFs;

describe("a library source opened as a project", () => {
  it("is catalogued like a folder, kept in the app data, and opens again offline", async () => {
    const first = await ProjectStorage.open(sourceRoot("test.server")!, deps);
    expect(first.storageLocation).toBe("source");
    expect(first.photos.map((p) => p.relPath).sort()).toEqual(["Home/DSC_2.NEF", "Trip/IMG_1.JPG"]);
    expect(first.tree.children.map((c) => [c.name, c.count])).toEqual([
      ["Home", 1],
      ["Trip", 1],
    ]);
    expect(source.readOriginal).not.toHaveBeenCalled();
    const jpg = first.photos.find((p) => p.filename === "IMG_1.JPG")!;
    expect(jpg).toMatchObject({ folder: "Trip", width: 6000, height: 4000 });
    expect(source.readPreview).not.toHaveBeenCalled();
    expect(await first.storage.readPreview(jpg.id)).toBeInstanceOf(Blob);
    await vi.waitFor(() => expect(mem().has(`${SL}/previews/${jpg.id}.jpg`)).toBe(true));

    // Rated and opened (its original read once) before the project is left.
    await first.storage.putPhoto({ ...jpg, rating: 5 });
    expect(await (await jpg.fileHandle!.getFile()).text()).toBe("orig");
    await first.storage.flush?.();
    first.storage.close();
    expect(mem().text(`${SL}/catalog.json`)).toContain(jpg.id);

    online = false;
    const root = sourceRoot("test.server")!;
    const again = await ProjectStorage.open(root, deps);
    expect(sourceOffline(root)).toBe(true);
    const back = again.photos.find((p) => p.id === jpg.id)!;
    expect(back).toMatchObject({ rating: 5, relPath: "Trip/IMG_1.JPG" });
    expect(await (await back.fileHandle!.getFile()).text()).toBe("orig");
    const raw = again.photos.find((p) => p.filename === "DSC_2.NEF")!;
    await expect(raw.fileHandle!.getFile()).rejects.toThrow("Failed to fetch");
    expect(source.readOriginal).toHaveBeenCalledTimes(2);
    again.storage.close();
  });
});

// What the server changes between two opens: albums renamed, photos moved or
// renamed, a photo removed beside another of its name. Each photo keeps its own
// record, rating and edit, known by the source's key for it, never by its path.
describe("a library source changed on the server between opens", () => {
  type Listing = Awaited<ReturnType<LibrarySourceContribution["list"]>>;
  let listing: Listing;

  beforeEach(() => {
    registerLibrarySource("ext.a", { ...source, list: async () => listing });
  });

  const edit = (photoId: string, exposure: number): EditState => ({
    photoId,
    currentIndex: 0,
    stack: [{ timestamp: 1, label: "Exposure", params: normalizeParams({ exposure }) }],
  });

  /** Open, rate and edit each photo by where it is, and leave. */
  async function firstOpen(ratings: Record<string, number>) {
    const opened = await ProjectStorage.open(sourceRoot("test.server")!, deps);
    for (const photo of opened.photos) {
      const rating = ratings[photo.relPath] ?? 0;
      await opened.storage.putPhoto({ ...photo, rating });
      await opened.storage.putEditState(edit(photo.id, rating));
    }
    await opened.storage.flush?.();
    opened.storage.close();
    return opened.photos;
  }

  async function reopen() {
    const opened = await ProjectStorage.open(sourceRoot("test.server")!, deps);
    const rows = await Promise.all(
      opened.photos.map(async (p) => ({
        id: p.id,
        relPath: p.relPath,
        rating: p.rating,
        exposure: (await opened.storage.getEditState(p.id))?.stack[0]?.params.exposure ?? null,
      })),
    );
    opened.storage.close();
    return rows.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  it("keeps a photo's record, rating and edit when its album is renamed", async () => {
    listing = { folders: [{ name: "Trip", key: "al1", items: [{ key: "a1", name: "IMG_1.JPG", size: 4, exif: { dateTimeOriginal: "2024:06:01 08:00:00" } }] }] };
    const [before] = await firstOpen({ "Trip/IMG_1.JPG": 4 });
    listing = { folders: [{ name: "Holiday", key: "al1", items: [{ key: "a1", name: "IMG_1.JPG", size: 4, exif: { dateTimeOriginal: "2024:06:01 08:00:00" } }] }] };
    expect(await reopen()).toEqual([{ id: before.id, relPath: "Holiday/IMG_1.JPG", rating: 4, exposure: 4 }]);
  });

  it("keeps them when a photo moves to another album under another name", async () => {
    const exif = { dateTimeOriginal: "2024:06:01 08:00:00" };
    listing = {
      folders: [
        { name: "Trip", key: "al1", items: [{ key: "a1", name: "IMG_1.JPG", size: 4, exif }] },
        { name: "Best", key: "al2", items: [] },
      ],
    };
    const [before] = await firstOpen({ "Trip/IMG_1.JPG": 3 });
    listing = {
      folders: [
        { name: "Trip", key: "al1", items: [] },
        { name: "Best", key: "al2", items: [{ key: "a1", name: "Harbour.JPG", size: 4, exif }] },
      ],
    };
    expect(await reopen()).toEqual([{ id: before.id, relPath: "Best/Harbour.JPG", rating: 3, exposure: 3 }]);
  });

  it("never gives a removed photo's record to another that takes its name", async () => {
    listing = {
      folders: [
        {
          name: "Trip",
          key: "al1",
          items: [
            { key: "A", name: "IMG_0001.JPG", size: 4 },
            { key: "B", name: "IMG_0001.JPG", size: 4 },
          ],
        },
      ],
    };
    const before = await firstOpen({ "Trip/IMG_0001.JPG": 5, "Trip/IMG_0001 (B).JPG": 1 });
    const b = before.find((p) => p.relPath === "Trip/IMG_0001 (B).JPG")!;
    listing = { folders: [{ name: "Trip", key: "al1", items: [{ key: "B", name: "IMG_0001.JPG", size: 4 }] }] };
    expect(await reopen()).toEqual([{ id: b.id, relPath: "Trip/IMG_0001.JPG", rating: 1, exposure: 1 }]);
  });

  it("keeps a photo in two albums as two photos, each with its own edit", async () => {
    listing = {
      folders: [
        { name: "Trip", key: "al1", items: [{ key: "a1", name: "IMG_1.JPG", size: 4 }] },
        { name: "Best", key: "al2", items: [{ key: "a1", name: "IMG_1.JPG", size: 4 }] },
      ],
    };
    const before = await firstOpen({ "Best/IMG_1.JPG": 2, "Trip/IMG_1.JPG": 5 });
    const id = (path: string) => before.find((p) => p.relPath === path)!.id;
    expect(await reopen()).toEqual([
      { id: id("Best/IMG_1.JPG"), relPath: "Best/IMG_1.JPG", rating: 2, exposure: 2 },
      { id: id("Trip/IMG_1.JPG"), relPath: "Trip/IMG_1.JPG", rating: 5, exposure: 5 },
    ]);
  });
});
