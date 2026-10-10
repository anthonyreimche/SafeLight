// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The "Cache all" pre-decode runs one decode fewer than the libraw pool holds:
// the pool never gives background work its last instance (decode-pool.ts), so
// a further decode would only sit on its file's bytes while it waited. The
// decoder is faked; only how many decodes run at once is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const h = vi.hoisted(() => ({
  poolSize: 3,
  /** The size warming the pool gives it. */
  warmSize: 3,
  /** Decodes running right now, and the most that ever ran at once. */
  running: 0,
  peak: 0,
  decoded: 0,
}));

vi.mock("@/raw/decode-pool", () => ({
  decodePoolSize: () => h.poolSize,
  warmDecodePool: async () => {
    await Promise.resolve();
    h.poolSize = h.warmSize;
  },
}));

vi.mock("@/raw/decode", () => ({
  decodeRawToBitmap: async () => null,
  decodeRawToFloat: async () => {
    h.running++;
    h.peak = Math.max(h.peak, h.running);
    await new Promise((r) => setTimeout(r, 5));
    h.running--;
    h.decoded++;
    return { failure: "transient" as const };
  },
}));

vi.mock("@/raw/raw-cache", () => ({
  cachedKeys: async () => new Set<string>(),
  deleteCachedPreview: async () => {},
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 0,
  writeCachedPreview: async () => {},
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

const records = (count: number): CatalogPhoto[] =>
  Array.from({ length: count }, (_, i) => rawPhoto(`DSC_000${i}.NEF`));

beforeEach(() => {
  h.poolSize = 3;
  h.warmSize = 3;
  h.running = 0;
  h.peak = 0;
  h.decoded = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preDecodeRawsForCache concurrency", () => {
  it("runs one decode fewer than the pool holds", async () => {
    await preDecodeRawsForCache(records(6), { force: true });

    expect(h.decoded).toBe(6);
    expect(h.peak).toBe(2);
  });

  // "Cache all now" can start before the pool has warmed up.
  it("sizes itself by the pool once it has warmed up", async () => {
    h.poolSize = 0;

    await preDecodeRawsForCache(records(6), { force: true });

    expect(h.decoded).toBe(6);
    expect(h.peak).toBe(2);
  });

  it("still decodes one at a time when the pool holds a single instance", async () => {
    h.poolSize = 1;
    h.warmSize = 1;

    await preDecodeRawsForCache(records(3), { force: true });

    expect(h.decoded).toBe(3);
    expect(h.peak).toBe(1);
  });
});
