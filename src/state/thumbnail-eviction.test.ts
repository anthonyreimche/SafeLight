// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The grid-preview loader against the real catalogue store: how many previews a
// project holds in memory after a prefill of a big catalogue, and that a preview
// let go reloads when its cell comes back into view.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

vi.mock("./broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

vi.mock("@/extensions/registry", () => ({
  emitMetadataChange: async () => {},
  emitPhotoRemove: async () => {},
}));

import { structureVersion, useCatalogStore } from "./catalog-store";
import { adoptThumbnails, requestThumbnail, setThumbnailLoader } from "./thumbnail-loader";

const PHOTOS = 5000;
const PREVIEW_BYTES = 16 * 1024;

let urlSeq = 0;
const liveUrls = new Set<string>();
let frames: FrameRequestCallback[] = [];
let reads: string[] = [];

const flushFrames = (): void => {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function skeleton(id: string): CatalogPhoto {
  return {
    id,
    filename: `${id}.NEF`,
    relPath: `trip/${id}.NEF`,
    folder: "trip",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 25_000_000,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 1_700_000_000,
    dateImported: 1_700_000_100,
    exif: {},
  };
}

const idOf = (i: number): string => `p${i}`;
const photos = (): CatalogPhoto[] => useCatalogStore.getState().photos;
const held = (): CatalogPhoto[] => photos().filter((p) => p.thumbnailBlob !== null);
const heldBytes = (): number => held().reduce((sum, p) => sum + (p.thumbnailBlob?.size ?? 0), 0);

/** A read that lands a frame's worth of work at a time, as the loader's window does. */
async function read(id: string): Promise<Blob> {
  await tick();
  reads.push(id);
  flushFrames();
  return new Blob([new Uint8Array(PREVIEW_BYTES)]);
}

/** Wait for `count` reads to have landed and the last frame to flush. */
async function landed(count: number): Promise<void> {
  await vi.waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(count), { timeout: 30_000 });
  await tick();
  flushFrames();
}

async function prefill(opts: Parameters<typeof setThumbnailLoader>[1]): Promise<void> {
  setThumbnailLoader(read, opts);
  for (let i = 0; i < PHOTOS; i++) requestThumbnail(idOf(i));
  await landed(PHOTOS);
}

beforeEach(() => {
  urlSeq = 0;
  liveUrls.clear();
  frames = [];
  reads = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const url = `blob:test/${urlSeq++}`;
    liveUrls.add(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => void liveUrls.delete(url));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  useCatalogStore.setState({
    photos: Array.from({ length: PHOTOS }, (_, i) => skeleton(idOf(i))),
    selectedIds: new Set(),
    activePhotoId: null,
  });
});

afterEach(() => {
  setThumbnailLoader(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Each test prefills 5000 photos: half a second on a dev machine, several on a
// loaded CI runner. The timeout matches `landed`'s wait.
describe("a prefill of a big catalogue", { timeout: 30_000 }, () => {
  it("holds every preview while the cache has room, as a small catalogue always did", async () => {
    await prefill({ cacheLimit: PHOTOS + 1 });

    console.info(
      `[S3 baseline] ${PHOTOS} photos prefilled: ${held().length} previews, ` +
        `${(heldBytes() / 1024 / 1024).toFixed(1)} MB of blobs, ${liveUrls.size} live object URLs`,
    );
    expect(held()).toHaveLength(PHOTOS);
    expect(liveUrls.size).toBe(PHOTOS);
  });

  it("keeps no more previews and object URLs than the cache holds", async () => {
    const cap = 1000;
    await prefill({ cacheLimit: cap });

    console.info(
      `[S3 capped at ${cap}] ${PHOTOS} photos prefilled: ${held().length} previews, ` +
        `${(heldBytes() / 1024 / 1024).toFixed(1)} MB of blobs, ${liveUrls.size} live object URLs`,
    );
    expect(held().length).toBeLessThanOrEqual(cap);
    expect(liveUrls.size).toBeLessThanOrEqual(cap);
    expect(heldBytes()).toBeLessThanOrEqual(cap * PREVIEW_BYTES);
    expect(photos().filter((p) => p.thumbnailUrl !== null)).toHaveLength(held().length);
  });

  it("lets go of the previews loaded longest ago", async () => {
    await prefill({ cacheLimit: 1000 });

    const byId = new Map(photos().map((p) => [p.id, p] as const));
    expect(byId.get(idOf(0))?.thumbnailBlob).toBeNull();
    expect(byId.get(idOf(0))?.thumbnailUrl).toBeNull();
    expect(byId.get(idOf(PHOTOS - 1))?.thumbnailBlob).not.toBeNull();
  });

  it("reloads a released preview when its cell is back in view", async () => {
    await prefill({ cacheLimit: 1000 });
    reads = [];

    requestThumbnail(idOf(0), { visible: true });
    await landed(1);

    expect(reads).toEqual([idOf(0)]);
    expect(photos()[0].thumbnailUrl).not.toBeNull();
    expect(held().length).toBeLessThanOrEqual(1000);
  });

  it("never releases the photo open in Develop", async () => {
    useCatalogStore.setState({ activePhotoId: idOf(0) });
    await prefill({ cacheLimit: 1000 });

    expect(photos()[0].thumbnailBlob).not.toBeNull();
    expect(held().length).toBeLessThanOrEqual(1000);
  });

  it("tells the project which previews it released", async () => {
    const released: string[] = [];
    await prefill({ cacheLimit: 1000, onEvict: (ids) => released.push(...ids) });

    const heldIds = new Set(held().map((p) => p.id));
    expect(released).toHaveLength(PHOTOS - 1000);
    expect(released.some((id) => heldIds.has(id))).toBe(false);
  });

  it("leaves the structure version alone, as only previews changed", async () => {
    const before = structureVersion(photos());
    await prefill({ cacheLimit: 1000 });

    expect(structureVersion(photos())).toBe(before);
  });

  it("leaves a preview an edit replaced where it is", async () => {
    await prefill({ cacheLimit: PHOTOS + 1 });
    const edited = new Blob(["edited"]);
    useCatalogStore.getState().updatePhoto({ ...photos()[0], thumbnailBlob: edited });

    useCatalogStore.getState().dropThumbnails([{ id: idOf(0), blob: new Blob(["old"]) }]);

    expect(photos()[0].thumbnailBlob).toBe(edited);
  });
});

describe("previews the loader didn't read", () => {
  /** Photos that came with a preview of their own, as an import's do. */
  function imported(count: number): { id: string; blob: Blob }[] {
    const entries = Array.from({ length: count }, (_, i) => ({ id: idOf(i), blob: new Blob([`import ${i}`]) }));
    const blobs = new Map(entries.map((entry) => [entry.id, entry.blob] as const));
    useCatalogStore.setState({
      photos: photos().map((p) => {
        const blob = blobs.get(p.id);
        return blob ? { ...p, thumbnailBlob: blob, thumbnailUrl: URL.createObjectURL(blob) } : p;
      }),
    });
    return entries;
  }

  it("count against the cache once adopted, the oldest let go first", () => {
    const released: string[] = [];
    setThumbnailLoader(read, { cacheLimit: 3, onEvict: (ids) => released.push(...ids) });
    const entries = imported(4);

    adoptThumbnails(entries);

    expect(released).toEqual([idOf(0)]);
    expect(photos()[0]).toMatchObject({ thumbnailBlob: null, thumbnailUrl: null });
    expect(held().map((p) => p.id)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(liveUrls.size).toBe(3);
  });

  it("are read again once let go, when their cell is back in view", async () => {
    setThumbnailLoader(read, { cacheLimit: 3 });
    adoptThumbnails(imported(4));

    requestThumbnail(idOf(0), { visible: true });
    await landed(1);

    expect(reads).toEqual([idOf(0)]);
    expect(photos()[0].thumbnailUrl).not.toBeNull();
    expect(held()).toHaveLength(3);
  });
});
