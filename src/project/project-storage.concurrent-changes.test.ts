// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Two windows changing one photo at once, each before the other's change has
// reached it: messages arrive late, in the order each window sent them, as
// between real windows. A change to one group of a record's fields survives a
// change to another group, and both windows, and the disk, end with one record.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshParams, type CatalogPhoto } from "@/catalog/types";
import type { BroadcastMessage } from "@/state/broadcast";

const h = vi.hoisted(() => ({
  listeners: new Set<(message: BroadcastMessage) => void>(),
  listenerIds: new WeakMap<object, number>(),
  lastListenerId: 0,
  /** When the last message from each sender reaches each listener. */
  arrivals: new Map<string, number>(),
  /** How long the next message takes to arrive, in ms. */
  latency: (): number => 0,
  built: 0,
}));

// The plain-browser build: no native file bridge.
vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    persistPreviews: true,
    thumbMaxEdge: 768,
    externalCatalogDir: "",
    catalogLocation: "in-folder",
  }),
}));
vi.mock("@/extensions/registry", () => ({ emitPhotoImport: async () => null }));
vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.(nef|jpe?g)$/i.test(name),
  buildPhoto: async (
    file: File,
    directoryHandle: FileSystemDirectoryHandle | null,
    fileHandle: FileSystemFileHandle | null,
  ): Promise<CatalogPhoto | null> => ({
    id: `new${++h.built}:${file.name}`,
    filename: file.name,
    relPath: "",
    folder: "",
    directoryHandle,
    fileHandle,
    thumbnailBlob: new Blob([`thumb:${file.name}`]),
    thumbnailUrl: null,
    width: 4000,
    height: 3000,
    fileSize: file.size,
    mimeType: "image/jpeg",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 1,
    dateImported: 2,
    exif: {},
  }),
  buildPreviewBlob: async (photo: CatalogPhoto) => new Blob([`built at ${photo.rotation}`]),
}));
vi.mock("@/state/broadcast", () => ({
  WINDOW_ID: "test-window",
  broadcast: (message: BroadcastMessage) => {
    const sender =
      message.type === "catalog-records" || message.type === "catalog-hello"
        ? message.payload.origin
        : "";
    for (const listener of [...h.listeners]) {
      let id = h.listenerIds.get(listener);
      if (!id) h.listenerIds.set(listener, (id = ++h.lastListenerId));
      const route = `${sender}→${id}`;
      const at = Math.max(Date.now() + h.latency(), h.arrivals.get(route) ?? 0);
      h.arrivals.set(route, at);
      const copy = structuredClone(message);
      setTimeout(() => {
        if (h.listeners.has(listener)) listener(copy);
      }, at - Date.now());
    }
  },
  onBroadcast: (listener: (message: BroadcastMessage) => void) => {
    h.listeners.add(listener);
    return () => void h.listeners.delete(listener);
  },
}));

import { photo } from "@/catalog/stored-edit.fixtures";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";
import { ProjectStorage } from "./project-storage";

const ROOT = "/home/u/photos";

const storages: ProjectStorage[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  h.listeners.clear();
  h.arrivals.clear();
  h.latency = () => 0;
  h.built = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A MemoryFs whose preview writes fail while `failPreviews` is set. */
class PreviewFailingFs extends MemoryFs {
  failPreviews = false;
  override async write(path: string, data: Uint8Array): Promise<void> {
    if (this.failPreviews && /[\\/]previews[\\/]/.test(path)) throw new Error("ENOSPC: write");
    return super.write(path, data);
  }
}

/** A project saved with photos x and y, whose messages arrive `latency` ms late. */
function project() {
  const fs = new PreviewFailingFs(ROOT);
  const photos = [photo("x"), photo("y")];
  for (const p of photos) fs.put(`${ROOT}/${p.relPath}`, p.id);
  fs.put(`${ROOT}/.safelight/catalog.json`, JSON.stringify({ version: 1, photos, edits: [] }));
  const root = fsaDirectoryHandle(fs, ROOT);
  const disk = (): CatalogPhoto | undefined =>
    JSON.parse(fs.text(`${ROOT}/.safelight/catalog.json`) ?? "{}").photos?.find(
      (p: CatalogPhoto) => p.id === "x",
    );
  return { fs, root, disk };
}

async function open(
  root: FileSystemDirectoryHandle,
  onPhoto?: (photo: CatalogPhoto) => void,
  onSkeletons?: (storage: ProjectStorage) => void,
): Promise<ProjectStorage> {
  const opened = await ProjectStorage.open(root, onPhoto, onSkeletons);
  storages.push(opened.storage);
  return opened.storage;
}

/** Both windows open, a while before the test acts. */
async function twoWindows() {
  const { fs, root, disk } = project();
  const a = await open(root);
  const b = await open(root);
  await vi.advanceTimersByTimeAsync(5000);
  return { fs, root, disk, a, b };
}

const x = async (storage: ProjectStorage) => {
  const held = (await storage.getAllPhotos()).find((p) => p.id === "x");
  if (!held) throw new Error("x is gone");
  return held;
};

/** Let every message arrive and every save land. */
async function settle(a: ProjectStorage, b: ProjectStorage) {
  await vi.advanceTimersByTimeAsync(5000);
  await a.flush();
  await b.flush();
}

describe("two windows changing one photo at once", () => {
  it("keep a rating from one and a flag from the other", async () => {
    const { a, b, disk } = await twoWindows();
    h.latency = () => 50;

    await a.putPhoto({ ...(await x(a)), rating: 4 });
    await b.putPhoto({ ...(await x(b)), flag: "pick" });
    await settle(a, b);

    const both = { rating: 4, flag: "pick" };
    expect(await x(a)).toMatchObject(both);
    expect(await x(b)).toMatchObject(both);
    expect(disk()).toMatchObject(both);
  });

  it("keep both when one reaches a window still walking the folder", async () => {
    const { fs, root, disk } = project();
    const a = await open(root);
    await vi.advanceTimersByTimeAsync(5000);
    fs.put(`${ROOT}/z.jpg`, "Z"); // B's walk has a file to import
    h.latency = () => 50;

    const walking: { b?: ProjectStorage } = {};
    const b = await open(
      root,
      () => {
        const storage = walking.b;
        if (storage) void x(storage).then((held) => storage.putPhoto({ ...held, flag: "pick" }));
      },
      (storage) => {
        walking.b = storage;
        void x(a).then((held) => a.putPhoto({ ...held, rating: 4 }));
      },
    );
    await settle(a, b);

    const both = { rating: 4, flag: "pick" };
    expect(await x(a)).toMatchObject(both);
    expect(await x(b)).toMatchObject(both);
    expect(disk()).toMatchObject(both);
  });

  it("end with one whole location when both move it", async () => {
    const { a, b, disk } = await twoWindows();
    h.latency = () => 50;

    await a.putPhoto({ ...(await x(a)), filename: "renamed.NEF", relPath: "renamed.NEF" });
    await b.putPhoto({ ...(await x(b)), relPath: "trip/x.NEF", folder: "trip" });
    await settle(a, b);

    const where = (p: CatalogPhoto | undefined) => ({
      filename: p?.filename,
      relPath: p?.relPath,
      folder: p?.folder,
    });
    const inA = where(await x(a));
    expect(where(await x(b))).toEqual(inA);
    expect(where(disk())).toEqual(inA);
    expect([
      { filename: "renamed.NEF", relPath: "renamed.NEF", folder: "" },
      { filename: "x.NEF", relPath: "trip/x.NEF", folder: "trip" },
    ]).toContainEqual(inA);
  });

  it("keep a rating from one while the other stored only a new preview", async () => {
    const { a, b, disk } = await twoWindows();
    h.latency = () => 50;

    await b.putPhoto({ ...(await x(b)), rating: 3 });
    await a.putPhoto({ ...(await x(a)), thumbnailBlob: new Blob(["edited"]), previewEdit: "e1" });
    await settle(a, b);

    expect((await x(a)).rating).toBe(3);
    expect((await x(b)).rating).toBe(3);
    expect(disk()?.rating).toBe(3);
  });

  it("agree on one rating when both rate it", async () => {
    const { a, b, disk } = await twoWindows();
    h.latency = () => 50;

    await a.putPhoto({ ...(await x(a)), rating: 1 });
    await b.putPhoto({ ...(await x(b)), rating: 2 });
    await settle(a, b);

    const inA = (await x(a)).rating;
    expect((await x(b)).rating).toBe(inA);
    expect(disk()?.rating).toBe(inA);
  });

  it("never show a preview the wrong way round after a turn whose preview failed", async () => {
    const { fs, a, b } = await twoWindows();
    fs.put(`${ROOT}/.safelight/previews/x.jpg`, "x at 0");
    h.latency = () => 50;

    await a.putPhoto({ ...(await x(a)), rating: 2 });
    fs.failPreviews = true;
    const held = await x(b);
    const turn = { rotation: 90, width: held.height, height: held.width };
    await b.putPhoto({ ...held, ...turn, thumbnailBlob: new Blob(["x at 90"]) }).catch(() => {});
    fs.failPreviews = false;
    await settle(a, b);

    expect(await x(b)).toMatchObject({ rating: 2, rotation: 90 });
    await expect((await b.readPreview("x"))?.text()).resolves.toBe("built at 90");
  });
});

describe("a window opening while another's change is on its way", () => {
  it("keeps what it read over an older answer from a window that hadn't heard of it", async () => {
    const { fs, root } = project();
    const a = await open(root);
    const c = await open(root);
    await vi.advanceTimersByTimeAsync(5000);
    const look = (label: string) => ({
      photoId: "x",
      stack: [{ timestamp: 1, label, params: freshParams() }],
      currentIndex: 0,
    });
    await a.putEditState(look("From A"));
    await vi.advanceTimersByTimeAsync(10);
    h.latency = () => 500; // C's edit reaches A late, but its save lands at once
    await c.putEditState(look("From C"));
    c.close(); // C's window closes, its save landed
    h.latency = () => 20;

    const b = await open(root); // reads C's edit; A answers with its own, older one
    await settle(a, b);
    await b.putPhoto({ ...(await x(b)), rating: 1 });
    await b.flush();

    expect((await b.getEditState("x"))?.stack[0].label).toBe("From C");
    const saved = JSON.parse(fs.text(`${ROOT}/.safelight/catalog.json`) ?? "{}");
    expect(saved.edits.find((e: { photoId: string }) => e.photoId === "x")?.stack[0].label).toBe(
      "From C",
    );
  });

  it("leaves a third window's preview as it is when another window is answered", async () => {
    const { fs, root } = project();
    const a = await open(root);
    const c = await open(root);
    await vi.advanceTimersByTimeAsync(5000);
    await a.putPhoto({ ...(await x(a)), rating: 2 }); // A answers with x from now on
    await vi.advanceTimersByTimeAsync(10);
    h.latency = () => 500; // C's new preview of x reaches A late
    await c.putPhoto({ ...(await x(c)), thumbnailBlob: new Blob(["e2"]), previewEdit: "e2" });
    h.latency = () => 20;

    const b = await open(root); // A answers B with x as it holds it, naming no preview edit
    await settle(c, b);

    expect((await x(c)).previewEdit).toBe("e2");
    expect(fs.text(`${ROOT}/.safelight/previews/x.jpg`)).toBe("e2");
  });

  it("doesn't tombstone a file it already imported when an answer says it was removed", async () => {
    const { fs, root } = project();
    fs.put(`${ROOT}/z.jpg`, "Z");
    const a = await open(root); // imports z.jpg; its save waits for the debounce
    const z = (await a.getAllPhotos()).find((p) => p.relPath === "z.jpg");
    if (!z) throw new Error("z.jpg wasn't imported");
    await a.deletePhoto(z.id);
    h.latency = () => 50;

    const b = await open(root); // imports z.jpg itself before A's answer arrives
    await settle(a, b);
    await b.putPhoto({ ...(await x(b)), rating: 1 });
    await b.flush();

    const saved = JSON.parse(fs.text(`${ROOT}/.safelight/catalog.json`) ?? "{}");
    expect(saved.photos.map((p: CatalogPhoto) => p.relPath)).toContain("z.jpg");
    expect(saved.removed).not.toContain("z.jpg");
  });
});

describe("a window opening while another's change is on its way to disk", () => {
  it("keeps its own later change when the other window's answer arrives after it", async () => {
    const { root, disk } = project();
    const a = await open(root);
    await vi.advanceTimersByTimeAsync(5000);
    h.latency = () => 50;
    await a.putPhoto({ ...(await x(a)), rating: 4 }); // saved after the debounce
    await vi.advanceTimersByTimeAsync(5);

    const b = await open(root);
    await b.putPhoto({ ...(await x(b)), rating: 1 }); // before A's answer arrives
    await settle(a, b);

    expect((await x(a)).rating).toBe(1);
    expect((await x(b)).rating).toBe(1);
    expect(disk()?.rating).toBe(1);
  });
});
