// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The "Cache all" pass over RAWs whose libraw decode never answers: it gives
// up on them once they have had their time, strikes nothing against them, and
// caches the rest. The decode chain is real from import-photos.ts down to the
// libraw pool; libraw's instances are faked (a file whose first byte is 1
// hangs), and time is fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const SIZE = 128 * 1024;

const h = vi.hoisted(() => ({
  /** Each cache write, by key. */
  writes: [] as string[],
  /** Each strike against a photo, as "kind key". */
  strikes: [] as string[],
  /** How many files libraw was handed. */
  opens: 0,
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    worker = { terminate: () => {} };
    open(data: Uint8Array): Promise<void> {
      h.opens++;
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

vi.mock("@/catalog/exif", () => ({
  parseExif: async () => ({}),
  parseXmp: async () => ({}),
  parseExifDate: () => undefined,
}));

vi.mock("./raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./raw-preview")>()),
  extractRawPreview: async () => null,
  extractRawPreviewDecoded: async () => null,
}));

vi.mock("./import-thumb-task", () => ({ createThumbnail: async () => new Blob(["thumb"]) }));
vi.mock("./import-thumb-pool", () => ({ processThumb: async () => ({ ok: false }) }));

vi.mock("@/raw/raw-cache", () => ({
  cachedKeys: async () => new Set<string>(),
  deleteCachedPreview: async () => {},
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  writeCachedPreview: async (key: string) => void h.writes.push(key),
  markDecode: async (key: string, kind: string) => void h.strikes.push(`${kind} ${key}`),
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheEnabled: true, rawCachePrefetch: true, rawCacheMaxEdge: 3072 }),
}));

vi.mock("@/catalog/storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));
vi.mock("@/state/catalog-store", () => ({ useCatalogStore: { getState: () => ({ photos: [] }) } }));

import { preDecodeRawsForCache } from "./import-photos";
import { decodeTimeLimit } from "@/raw/libraw-wasm-adapter";
import { disposeDecodePool } from "@/raw/decode-pool";
import { rawPhoto } from "./raw-photo.test-support";

function raw(name: string, firstByte: number): CatalogPhoto {
  const bytes = new Uint8Array(SIZE);
  bytes[0] = firstByte;
  return rawPhoto(name, { bytes });
}

beforeEach(() => {
  h.writes = [];
  h.strikes = [];
  h.opens = 0;
  vi.useFakeTimers();
  vi.stubGlobal("Worker", class {});
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

describe("the Cache all pass and decodes that never answer", () => {
  it("gives up on two hung RAWs in time and caches the others", async () => {
    let finished = false;
    void preDecodeRawsForCache(
      [raw("A.ARW", 1), raw("B.ARW", 1), raw("C.ARW", 0), raw("D.ARW", 0)],
      { force: true },
    ).then(() => (finished = true));

    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));
    await vi.runAllTimersAsync();

    expect(finished).toBe(true);
    expect(h.writes.sort()).toEqual([`C.ARW:${SIZE}:0`, `D.ARW:${SIZE}:0`]);
    expect(h.strikes).toEqual([]);
  });

  it("passes over a RAW that hung on its next pass of the same session", async () => {
    const hung = raw("E.ARW", 1);
    void preDecodeRawsForCache([hung], { force: true });
    await vi.advanceTimersByTimeAsync(decodeTimeLimit(SIZE));
    h.opens = 0;

    let finished = false;
    void preDecodeRawsForCache([hung], { force: true }).then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(0);

    expect(finished).toBe(true);
    expect(h.opens).toBe(0);
    expect(h.strikes).toEqual([]);
  });
});
