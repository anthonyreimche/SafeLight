// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW whose libraw decode never answers holds a decoder for the whole time
// limit. Background work (Develop's neighbour prefetch here) pays that once a
// session: it passes over a file that is being decoded already, and one libraw
// gave no answer for. A photo the user opens is still tried. The chain is real
// from load-image.ts down to the libraw pool; libraw's instances are faked (a
// file whose first byte is 1 hangs), and time is fake. Each test names its own
// files: what the decoder remembers lasts the session, which is this file's run.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { rawPhoto } from "@/modules/library/raw-photo.test-support";

const HANG = 1;
const SIZE = 128 * 1024;

const h = vi.hoisted(() => ({
  /** The first byte of each file libraw was handed. */
  opened: [] as number[],
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    worker = { terminate: () => {} };
    open(data: Uint8Array): Promise<void> {
      h.opened.push(data[0]);
      return data[0] === 1 ? new Promise<void>(() => {}) : Promise.resolve();
    }
    async metadata(): Promise<Record<string, unknown>> {
      return { width: 2, height: 2, color_data: { cam_mul: [1, 1, 1, 1] } };
    }
    async imageData(): Promise<unknown> {
      return new Uint16Array(2 * 2 * 3).fill(12000);
    }
  },
}));

vi.mock("@/raw/raw-cache", () => ({
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  readCachedPreview: async () => null,
  writeCachedPreview: async () => {},
  hasDecodeMarker: async () => false,
  markDecode: async () => {},
}));

vi.mock("@/raw/accept-decode", () => ({ acceptDecode: async () => ({ use: true, cache: true }) }));

vi.mock("@/modules/library/raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/library/raw-preview")>()),
  extractRawPreview: async () => new Blob(["jpeg"], { type: "image/jpeg" }),
}));

vi.mock("@/state/settings-store", () => ({ getSettings: () => ({ rawCacheMaxEdge: 3072 }) }));
vi.mock("@/catalog/storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));
vi.mock("@/state/catalog-store", () => ({ useCatalogStore: { getState: () => ({ photos: [] }) } }));

import { loadPhotoImage } from "@/catalog/load-image";
import { decodeTimeLimit } from "./libraw-wasm-adapter";
import { disposeDecodePool } from "./decode-pool";

function raw(name: string, firstByte: number): CatalogPhoto {
  const bytes = new Uint8Array(SIZE);
  bytes[0] = firstByte;
  return rawPhoto(name, { bytes });
}

/** Develop's prefetch of `photo` from a neighbour the user then left. */
async function prefetchFromALeftNeighbour(photo: CatalogPhoto): Promise<void> {
  const neighbour = new AbortController();
  void loadPhotoImage(photo, { background: true, signal: neighbour.signal });
  await vi.advanceTimersByTimeAsync(0);
  neighbour.abort();
}

beforeEach(() => {
  h.opened = [];
  vi.useFakeTimers();
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal(
    "createImageBitmap",
    async (): Promise<ImageBitmap> => ({ width: 6000, height: 4000, close() {} }) as ImageBitmap,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  disposeDecodePool();
});

afterEach(() => {
  disposeDecodePool();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("background work and a RAW whose decode never answers", () => {
  it("decodes it once when two neighbours prefetch it, leaving the other background slot free", async () => {
    const hanging = raw("H1.ARW", HANG);
    await prefetchFromALeftNeighbour(hanging);
    await prefetchFromALeftNeighbour(hanging);

    let otherDone = false;
    void loadPhotoImage(raw("C1.ARW", 0), { background: true }).then(() => (otherDone = true));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(otherDone).toBe(true);
    expect(h.opened).toEqual([HANG, 0]);
  });

  it("passes over it for the rest of the session once it has had its time", async () => {
    const hanging = raw("H2.ARW", HANG);
    await prefetchFromALeftNeighbour(hanging);
    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));

    let againDone = false;
    void loadPhotoImage(hanging, { background: true }).then(() => (againDone = true));
    await vi.advanceTimersByTimeAsync(0);

    expect(againDone).toBe(true);
    expect(h.opened).toEqual([HANG]);
  });

  it("still tries it when the user opens it", async () => {
    const hanging = raw("H3.ARW", HANG);
    await prefetchFromALeftNeighbour(hanging);
    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));

    void loadPhotoImage(hanging);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.opened).toEqual([HANG, HANG]);
  });
});
