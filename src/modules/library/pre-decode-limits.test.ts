// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the automatic cache fill costs (about 2.3 s of decode and 36 MB of cache
// per photo, measured 2026-10-18) is why it has limits: it leaves a big project
// to caching as photos are opened, and gives up on a cache that refuses writes.
// The decoder and the cache are faked; only when the pass runs and stops is
// under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const h = vi.hoisted(() => ({
  /** Photos decoded so far. */
  decoded: 0,
  /** Writes attempted so far. */
  writes: 0,
  /** Keys the cache already holds. */
  present: new Set<string>(),
  /** Whether the cache takes the nth write (counted from 1). */
  takes: (_n: number): boolean => true,
}));

vi.mock("@/raw/decode-pool", () => ({
  decodePoolSize: () => 3,
  warmDecodePool: async () => {},
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async () => {
    h.decoded++;
    return { data: new Float32Array(4).fill(0.5), width: 1, height: 1, oriented: true };
  },
}));

vi.mock("@/raw/accept-decode", () => ({
  acceptDecode: async () => ({ use: true, cache: true }),
}));

vi.mock("./raw-preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./raw-preview")>()),
  extractRawPreview: async () => null,
}));

vi.mock("@/raw/raw-cache", () => ({
  cachedKeys: async () => new Set(h.present),
  deleteCachedPreview: async () => {},
  hasDecodeMarker: async () => false,
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  markDecode: async () => {},
  writeCachedPreview: async () => h.takes(++h.writes),
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheEnabled: true, rawCachePrefetch: true }),
}));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: [] }) },
}));

vi.mock("@/catalog/storage", () => ({
  catalogStorage: () => ({ putPhoto: async () => {} }),
}));

import { preDecodeRawsForCache } from "./import-photos";
import { rawPhoto } from "./raw-photo.test-support";

const name = (i: number) => `DSC_${i}.NEF`;
const photos = (count: number): CatalogPhoto[] =>
  Array.from({ length: count }, (_, i) => rawPhoto(name(i)));
/** The cache key of photo `i`, as the faked key function spells it. */
const keyOf = (i: number) => `${name(i)}:64:0`;

/** Runs a pass to its end. The pass yields to the UI between photos with a
 *  timer, which takes real time on a thousand of them; the timers are faked. */
async function fill(
  list: CatalogPhoto[],
  opts?: Parameters<typeof preDecodeRawsForCache>[1],
): Promise<void> {
  const pass = preDecodeRawsForCache(list, opts);
  await vi.runAllTimersAsync();
  await pass;
}

beforeEach(() => {
  vi.useFakeTimers();
  h.decoded = 0;
  h.writes = 0;
  h.present = new Set();
  h.takes = () => true;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Filling the cache for a few thousand photos takes hours and tens of
// gigabytes, so the automatic pass leaves a big project to the on-demand
// caching Develop does as photos are opened. Cache all now still does it all.
describe("preDecodeRawsForCache on a large project", () => {
  it("decodes nothing on its own when more than 1000 photos need caching", async () => {
    await fill(photos(1001));

    expect(h.decoded).toBe(0);
  });

  it("caches a project of exactly 1000 photos", async () => {
    await fill(photos(1000));

    expect(h.decoded).toBe(1000);
  });

  // The limit is on the work the pass would do: a big project that is mostly
  // cached already still gets its newcomers cached.
  it("counts only the photos the cache lacks", async () => {
    h.present = new Set(Array.from({ length: 600 }, (_, i) => keyOf(i)));

    await fill(photos(1500));

    expect(h.decoded).toBe(900);
  });

  it("caches a large project when asked to (Cache all now)", async () => {
    await fill(photos(1001), { force: true });

    expect(h.decoded).toBe(1001);
  });
});

// A full disk or an exhausted storage quota refuses every write. Left alone the
// pass would decode the whole project for nothing, and again on every open.
describe("preDecodeRawsForCache when the cache refuses writes", () => {
  it("stops after three refused writes in a row", async () => {
    h.takes = () => false;

    await fill(photos(12));

    // The two decodes run side by side, so one more can already be under way.
    expect(h.decoded).toBeGreaterThanOrEqual(3);
    expect(h.decoded).toBeLessThanOrEqual(4);
  });

  it("stops a pass that was asked for as well", async () => {
    h.takes = () => false;

    await fill(photos(12), { force: true });

    expect(h.decoded).toBeGreaterThanOrEqual(3);
    expect(h.decoded).toBeLessThanOrEqual(4);
  });

  it("says why it stopped", async () => {
    h.takes = () => false;

    await fill(photos(12));

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("goes on while the refused writes are not in a row", async () => {
    h.takes = (n) => n % 3 === 0; // two refused, one taken, and so on

    await fill(photos(12));

    expect(h.decoded).toBe(12);
  });

  it("starts the next pass with a clean count", async () => {
    h.takes = () => false;
    await fill(photos(12));
    h.decoded = 0;
    h.takes = () => true;

    await fill(photos(12));

    expect(h.decoded).toBe(12);
  });
});
