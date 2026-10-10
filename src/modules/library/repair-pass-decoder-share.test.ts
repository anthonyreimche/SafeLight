// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The repair pass runs when a project opens, alongside the "Cache all"
// pre-decode, and a photo the user opens in Develop meanwhile must not wait for
// either. The decode chain is real from import-photos.ts down to the libraw
// pool; libraw itself is faked, and a decode it starts never finishes, so the
// instance it took stays taken. Time is fake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const h = vi.hoisted(() => ({
  /** How many files libraw was handed. */
  opens: 0,
}));

vi.mock("libraw-wasm", () => ({
  default: class {
    open(): Promise<void> {
      h.opens++;
      return new Promise<void>(() => {});
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
  hasDecodeMarker: async () => false,
  rawCacheKey: (rel: string, size: number, rot: number) => `${rel}:${size}:${rot}`,
  rawCacheGeneration: () => 1,
  writeCachedPreview: async () => {},
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ previewSource: "auto", thumbMaxEdge: 768, rawCacheEnabled: true }),
}));

vi.mock("@/catalog/storage", () => ({ catalogStorage: () => ({ putPhoto: async () => {} }) }));
vi.mock("@/state/catalog-store", () => ({ useCatalogStore: { getState: () => ({ photos: [] }) } }));

import { repairMissingPreviews } from "./import-photos";
import {
  acquireInstance,
  decodePoolSize,
  disposeDecodePool,
  releaseInstance,
  warmDecodePool,
} from "@/raw/decode-pool";
import type { Instance } from "@/raw/decode-pool.test-support";
import { rawPhoto } from "./raw-photo.test-support";

/** Lets every chain already under way run as far as it can. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** A RAW imported without a preview, big enough for libraw to take on. */
const unrepairedRaw = (): CatalogPhoto =>
  rawPhoto("DSC_0001.NEF", { bytes: 2 * 1024 * 1024, width: 0, height: 0 });

beforeEach(() => {
  h.opens = 0;
  vi.useFakeTimers();
  // Each instance owns a Worker over shared memory; Node has the latter only.
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

describe("a photo opened while previews are repaired", () => {
  it("still gets a decoder while the Cache all pre-decode holds its share", async () => {
    await warmDecodePool();
    // The pre-decode at the most the pool lets background work hold.
    const preDecode: Instance[] = [];
    for (let i = 0; i < decodePoolSize() - 1; i++) {
      const inst = await acquireInstance({ background: true });
      if (!inst) throw new Error("pool unavailable");
      preDecode.push(inst);
    }
    let repairEnded = false;
    void repairMissingPreviews([unrepairedRaw()], undefined, new AbortController().signal).then(
      () => {
        repairEnded = true;
      },
    );
    await settle();

    let opened = false;
    void acquireInstance().then(() => {
      opened = true;
    });
    await settle();

    expect(opened).toBe(true);
    expect(repairEnded).toBe(false);
    expect(h.opens).toBe(0);

    // Its decode was waiting its turn, not given up: it takes the next
    // instance the pre-decode lets go of.
    releaseInstance(preDecode[0]);
    await settle();
    expect(h.opens).toBe(1);
  });
});
