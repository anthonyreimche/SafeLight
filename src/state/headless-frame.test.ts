// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo measured off-screen (batch Auto) renders from the source Develop would
// use, by the same rules: a preview the load fell back on never stands for the
// photo's own pixels, and one that already shows an edit is never rendered over.
// The worker bridge and the decoder are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImage, Fallback } from "@/catalog/load-image";
import type { CatalogPhoto } from "@/catalog/types";
import { normalizeParams } from "@/catalog/types";
import { photo as fixture } from "@/catalog/stored-edit.fixtures";

const h = vi.hoisted(() => ({
  photos: [] as CatalogPhoto[],
  /** The keys uploaded to the thumb renderer's source cache. */
  resident: new Set<string>(),
  decoded: null as DecodedImage | null,
  decodes: 0,
  /** Loads the photo: by default `decoded`, counting a decode each time. */
  load: null as ((opts?: { background?: boolean }) => DecodedImage | null) | null,
  asyncRenders: 0,
}));

vi.mock("@/rendering/render-bridge", () => ({
  getRenderBridge: () => ({
    ready: Promise.resolve(),
    uploadSource: (_target: string, key: string) => void h.resident.add(key),
    renderThumbnailFromSource: async (opts: { key: string }) =>
      h.resident.has(opts.key) ? new Blob(["from source"]) : null,
    renderThumbnailAsync: async () => {
      h.asyncRenders++;
      return new Blob(["from bitmap"]);
    },
  }),
}));
vi.mock("@/catalog/load-image", () => ({
  loadPhotoImage: async (_photo: CatalogPhoto, opts?: { background?: boolean }) => {
    if (h.load) return h.load(opts);
    h.decodes++;
    return h.decoded;
  },
  photoSourceKey: (photo: CatalogPhoto) => `${photo.id}:${photo.rotation ?? 0}`,
}));
vi.mock("./catalog-store", () => ({
  useCatalogStore: { getState: () => ({ photos: h.photos }) },
}));

import { renderPhotoFrame } from "./headless-frame";

const ID = "x";
const KEY = `${ID}:0`;
const NONE = { offline: false, unsupported: false, timedOut: false };
const frame = { width: 2, height: 2 } as unknown as ImageBitmap;

function fellBack(fallback: Fallback): DecodedImage & { kind: "bitmap" } {
  const bitmap = { width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap;
  return { kind: "bitmap", bitmap, fallback };
}

const measure = () => renderPhotoFrame(ID, normalizeParams({ exposure: 1 }));

beforeEach(() => {
  h.photos = [fixture(ID)];
  h.resident.clear();
  h.decoded = null;
  h.decodes = 0;
  h.load = null;
  h.asyncRenders = 0;
  vi.stubGlobal("createImageBitmap", async () => frame);
});

afterEach(() => vi.unstubAllGlobals());

describe("measuring a photo off-screen", () => {
  it("never renders over a stored preview that already shows an edit", async () => {
    const stored = fellBack({ from: "stored-edited", ...NONE, offline: true });
    h.decoded = stored;

    await expect(measure()).resolves.toBeNull();

    expect(h.resident.size).toBe(0);
    expect(h.asyncRenders).toBe(0);
    expect(stored.bitmap.close).toHaveBeenCalled();
  });

  it("doesn't keep a preview the decode fell back on as the photo's source", async () => {
    h.decoded = fellBack({ from: "embedded", ...NONE, timedOut: true });

    await expect(measure()).resolves.toBe(frame);
    await measure();

    expect(h.resident.has(KEY)).toBe(false);
    expect(h.decodes).toBe(2);
  });

  it("starts one decode, not one per call, for a RAW whose decode timed out", async () => {
    // Background work passes a file over for the rest of the session once libraw
    // gave it no answer; work the user waits on would decode it again each time.
    let timedOut = false;
    h.load = (opts) => {
      if (timedOut && opts?.background) return null;
      h.decodes++;
      timedOut = true;
      return fellBack({ from: "embedded", ...NONE, timedOut: true });
    };

    for (let i = 0; i < 5; i++) await measure();

    expect(h.decodes).toBe(1);
  });

  it("keeps a full decode as the photo's source", async () => {
    h.decoded = { kind: "float", data: new Float32Array(4), width: 2, height: 2 };

    await expect(measure()).resolves.toBe(frame);
    await measure();

    expect(h.resident.has(KEY)).toBe(true);
    expect(h.decodes).toBe(1);
  });

  it("doesn't fall back on the grid's preview when it already shows an edit", async () => {
    h.photos = [{ ...fixture(ID), thumbnailBlob: new Blob(["edited"]), previewEdit: "e1" }];

    await expect(measure()).resolves.toBeNull();

    expect(h.asyncRenders).toBe(0);
  });
});
