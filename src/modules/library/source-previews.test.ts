// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A library source's grid previews, against a fake server, through the real
// import, catalogue storage and grid preview reader. Opening the library reads
// no preview at all, whatever its size: the grid shows at once. Previews are
// then read as cells come into view, in the order they asked, a few at a time,
// kept on disk so each is read once, and stopped when the cells leave (the
// person scrolled on or left the album).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";

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
  sourceRoot,
  type LibrarySourceContribution,
  type LibrarySourceItem,
} from "@/project/library-sources";
import { MemoryFs } from "@/project/memory-fs.test-support";
import { cancelThumbnail, requestThumbnail, setThumbnailLoader } from "@/state/thumbnail-loader";
import { setCatalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "@/state/catalog-store";
import { rebuildThumbnails, reimportPhotos } from "./import-passes";

const SL = "/data/source-catalogs/Server-1/.safelight";

const deps: ProjectStorageDeps = {
  isSupportedName,
  importPhoto,
  buildPreviewBlob: (photo, signal) => buildPreviewBlob(photo, signal),
  persistPreviews: () => true,
  emitPhotoImport: async () => null,
};

/** A fake photo server: its previews wait until the test answers them, or until
 *  they are stopped, as network reads do. */
function fakeServer(size: number, sized = true) {
  const asked: string[] = [];
  const stopped: string[] = [];
  const answer = new Map<string, () => void>();
  let inFlight = 0;
  let mostInFlight = 0;
  const items: LibrarySourceItem[] = Array.from({ length: size }, (_, i) => ({
    key: `k${i}`,
    name: `IMG_${i}.JPG`,
    size: 4,
    ...(sized ? { width: 6000, height: 4000 } : {}),
  }));
  const source: LibrarySourceContribution = {
    id: "test.server",
    name: "Server",
    library: "https://photos.example/#u1",
    list: vi.fn(async () => ({ folders: [{ name: "Trip", key: "al1", items }] })),
    readPreview: vi.fn((item: LibrarySourceItem, { signal }: { signal: AbortSignal }) => {
      asked.push(item.key);
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      return new Promise<Blob>((resolve, reject) => {
        answer.set(item.key, () => {
          inFlight--;
          resolve(new Blob(["webp"]));
        });
        signal.addEventListener("abort", () => {
          inFlight--;
          stopped.push(item.key);
          reject(new DOMException("stopped", "AbortError"));
        });
      });
    }),
    readOriginal: vi.fn(async () => new Blob(["orig"])),
  };
  return { source, asked, stopped, answer, mostInFlight: () => mostInFlight };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  const mem = new MemoryFs("/data");
  h.fs = Object.assign(mem, {
    sourceCatalogDir: async () => {
      mem.mkdirp(SL);
      return SL;
    },
  });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 512, height: 341, close: () => {} }));
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
});

afterEach(() => {
  setThumbnailLoader(null);
  dropLibrarySources("ext.a");
  vi.unstubAllGlobals();
});

const mem = () => h.fs as MemoryFs;

async function openLibrary(size: number, sized = true) {
  const server = fakeServer(size, sized);
  registerLibrarySource("ext.a", server.source);
  const opened = await ProjectStorage.open(sourceRoot("test.server")!, deps);
  setThumbnailLoader((id, signal) => opened.storage.readPreview(id, { signal }));
  const ids = opened.photos.map((p) => p.id);
  return { server, opened, ids };
}

describe("opening a library source", () => {
  it("reads no preview, however many photos it holds", async () => {
    const { server, opened } = await openLibrary(50_000);
    expect(opened.photos).toHaveLength(50_000);
    expect(server.source.readPreview).not.toHaveBeenCalled();
    expect(opened.photos[0]).toMatchObject({ width: 6000, height: 4000, thumbnailBlob: null });
    opened.storage.close();
  });
});

describe("a library source's grid previews", () => {
  it("are read as cells come into view, in their order, three at a time", async () => {
    const { server, opened, ids } = await openLibrary(10);
    for (const id of ids.slice(0, 6)) requestThumbnail(id, { visible: true });
    await settle();
    expect(server.asked).toEqual(["k0", "k1", "k2"]);
    for (const key of ["k0", "k1", "k2", "k3", "k4", "k5"]) {
      server.answer.get(key)?.();
      await settle();
    }
    expect(server.asked).toEqual(["k0", "k1", "k2", "k3", "k4", "k5"]);
    expect(server.mostInFlight()).toBe(3);
    opened.storage.close();
  });

  it("are kept on disk, so each is read from the server once", async () => {
    const { server, opened, ids } = await openLibrary(2);
    const first = opened.storage.readPreview(ids[0]);
    await settle();
    server.answer.get("k0")!();
    expect(await first).toBeInstanceOf(Blob);
    await vi.waitFor(() => expect(mem().has(`${SL}/previews/${ids[0]}.jpg`)).toBe(true));
    expect(await opened.storage.readPreview(ids[0])).toBeInstanceOf(Blob);
    expect(server.asked).toEqual(["k0"]);
    opened.storage.close();
  });

  it("stop when their cells leave, and those not begun are never asked for", async () => {
    const { server, opened, ids } = await openLibrary(10);
    for (const id of ids.slice(0, 6)) requestThumbnail(id, { visible: true });
    await settle();
    for (const id of ids.slice(0, 6)) cancelThumbnail(id); // the person left the album
    await settle();
    expect(server.asked).toEqual(["k0", "k1", "k2"]);
    expect(server.stopped).toEqual(["k0", "k1", "k2"]);
    expect(mem().tree(`${SL}/previews`)).toEqual([]);

    requestThumbnail(ids[9], { visible: true }); // another album's cell
    await settle();
    expect(server.asked).toEqual(["k0", "k1", "k2", "k9"]);
    opened.storage.close();
  });

  it("are only read from disk where the server isn't to be asked", async () => {
    const { server, opened, ids } = await openLibrary(1);
    expect(await opened.storage.readPreview(ids[0], { build: false })).toBeNull();
    expect(server.source.readPreview).not.toHaveBeenCalled();
    opened.storage.close();
  });

  it("aren't asked of a server the open found unreachable", async () => {
    const { server, opened } = await openLibrary(1);
    await opened.storage.flush?.();
    opened.storage.close();
    vi.mocked(server.source.list).mockRejectedValue(new TypeError("Failed to fetch"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const again = await ProjectStorage.open(sourceRoot("test.server")!, deps);
    expect(await again.storage.readPreview(again.photos[0].id)).toBeNull();
    expect(server.source.readPreview).not.toHaveBeenCalled();
    warn.mockRestore();
    again.storage.close();
  });

  it("leave the photo without one when the server fails, to ask again later", async () => {
    const { server, opened, ids } = await openLibrary(1);
    vi.mocked(server.source.readPreview).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await opened.storage.readPreview(ids[0])).toBeNull();
    warn.mockRestore();
    opened.storage.close();
  });
});

describe("Rebuild previews and Re-import on a library source", () => {
  it.each(["rebuild", "reimport"] as const)(
    "%s asks the server for nothing until a cell shows, then reads that preview again",
    async (command) => {
      const { server, opened, ids } = await openLibrary(3);
      setCatalogStorage(opened.storage);
      useCatalogStore.setState({ photos: opened.photos });
      requestThumbnail(ids[0], { visible: true });
      await settle();
      server.answer.get("k0")!();
      await vi.waitFor(() => expect(mem().has(`${SL}/previews/${ids[0]}.jpg`)).toBe(true));
      await settle();

      const photos = useCatalogStore.getState().photos;
      const result = command === "rebuild" ? await rebuildThumbnails(photos) : await reimportPhotos(photos);
      expect(result).toMatchObject({ refetched: 3 });
      expect(server.asked).toEqual(["k0"]);
      expect(mem().has(`${SL}/previews/${ids[0]}.jpg`)).toBe(false);
      expect(useCatalogStore.getState().photos.find((p) => p.id === ids[0])?.thumbnailUrl).toBeNull();

      requestThumbnail(ids[0], { visible: true });
      await settle();
      expect(server.asked).toEqual(["k0", "k0"]);
      setCatalogStorage(null);
      opened.storage.close();
    },
  );
});

describe("a source photo listed without a size", () => {
  it("takes its preview's own size when the preview first arrives, here and in the grid", async () => {
    const { server, opened, ids } = await openLibrary(1, false);
    expect(opened.photos[0]).toMatchObject({ width: 0, height: 0 });
    const read = opened.storage.readPreview(ids[0]);
    await settle();
    server.answer.get("k0")!();
    const blob = await read;
    expect(blob?.frame).toEqual({ width: 512, height: 341 });
    expect(opened.storage.heldPhoto(ids[0])).toMatchObject({ width: 512, height: 341 });

    useCatalogStore.setState({ photos: opened.photos });
    useCatalogStore.getState().mergeThumbnails([{ id: ids[0], blob: blob! }]);
    expect(useCatalogStore.getState().photos[0]).toMatchObject({ width: 512, height: 341 });
    opened.storage.close();
  });

  it("keeps the size the source listed", async () => {
    const { server, opened, ids } = await openLibrary(1);
    const read = opened.storage.readPreview(ids[0]);
    await settle();
    server.answer.get("k0")!();
    const blob = await read;
    expect(opened.storage.heldPhoto(ids[0])).toMatchObject({ width: 6000, height: 4000 });
    useCatalogStore.setState({ photos: opened.photos });
    useCatalogStore.getState().mergeThumbnails([{ id: ids[0], blob: blob! }]);
    expect(useCatalogStore.getState().photos[0]).toMatchObject({ width: 6000, height: 4000 });
    opened.storage.close();
  });
});
