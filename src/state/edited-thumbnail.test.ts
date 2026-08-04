// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Post-commit grid-thumbnail regeneration: the three-step source ladder
// (resident GPU source → decode + upload → camera JPEG), the per-photo
// coalescing that collapses a burst of commits into one trailing render, and
// the guards that stop a stale or failed render from damaging the catalog. The
// worker bridge and the decoder are the expensive edges, so they're faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImage } from "@/catalog/load-image";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { normalizeParams } from "@/catalog/types";

interface ThumbRenderOpts {
  requestId: string;
  key: string;
  params: DevelopParams;
  asShotTemperature: number;
  maxEdge: number;
  quality?: number;
  contributedParams?: Record<string, unknown>;
}

const bridge = vi.hoisted(() => ({
  ready: Promise.resolve(),
  renderThumbnailFromSource:
    vi.fn<(opts: ThumbRenderOpts) => Promise<Blob | null>>(),
  renderThumbnailAsync: vi.fn<(opts: unknown) => Promise<Blob | null>>(),
  uploadSource: vi.fn<
    (
      target: string,
      key: string,
      image: DecodedImage,
      maxEdge?: number,
      isFallbackPreview?: boolean,
      baseCurveForBitmap?: boolean,
    ) => void
  >(),
}));

const decode = vi.hoisted(() =>
  vi.fn<(photo: CatalogPhoto) => Promise<DecodedImage | null>>(),
);

const catalog = vi.hoisted(() => ({
  photos: [] as CatalogPhoto[],
  updatePhoto: vi.fn<(photo: CatalogPhoto) => void>(),
}));

vi.mock("@/rendering/render-bridge", () => ({ getRenderBridge: () => bridge }));
vi.mock("@/catalog/load-image", () => ({
  loadPhotoImage: decode,
  photoSourceKey: (photo: CatalogPhoto) => `${photo.id}:${photo.rotation}`,
}));
vi.mock("./catalog-store", () => ({
  useCatalogStore: { getState: () => catalog },
}));

import { regenerateEditedThumbnail } from "./edited-thumbnail";
import { setCatalogStorage, type CatalogStorage } from "@/catalog/storage";

const PHOTO_ID = "photo-1";
const THUMB_MAX_EDGE = 640;

function photo(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: PHOTO_ID,
    filename: "IMG_1.NEF",
    relPath: "IMG_1.NEF",
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1024,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...over,
  };
}

interface Gate {
  wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/** Resolve after every already-queued microtask chain has run to completion. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const rendered = new Blob(["rendered"]);
const params = (exposure: number): DevelopParams => normalizeParams({ exposure });

let written: CatalogPhoto[];
let putPhoto: (p: CatalogPhoto) => Promise<void>;

const storage: CatalogStorage = {
  getAllPhotos: async () => [],
  putPhoto: (p) => putPhoto(p),
  putPhotos: async () => {},
  deletePhoto: async () => {},
  getEditState: async () => undefined,
  getAllEditStates: async () => [],
  putEditState: async () => {},
};

beforeEach(() => {
  written = [];
  putPhoto = async (p) => void written.push(p);
  setCatalogStorage(storage);
  catalog.photos = [photo()];
  catalog.updatePhoto.mockClear();
  bridge.renderThumbnailFromSource.mockReset();
  bridge.renderThumbnailAsync.mockReset();
  bridge.uploadSource.mockReset();
  decode.mockReset();
  decode.mockResolvedValue(null);
  vi.stubGlobal("URL", { createObjectURL: () => "blob:thumb", revokeObjectURL: () => {} });
});

afterEach(() => {
  setCatalogStorage(null);
  vi.unstubAllGlobals();
});

describe("rendering from the resident source", () => {
  beforeEach(() => {
    bridge.renderThumbnailFromSource.mockResolvedValue(rendered);
  });

  it("renders the committed look and writes it back to the catalog", async () => {
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000, { "ext.stage.k": 3 });
    await settle();

    expect(bridge.renderThumbnailFromSource).toHaveBeenCalledTimes(1);
    const opts = bridge.renderThumbnailFromSource.mock.calls[0][0];
    expect(opts.key).toBe(`${PHOTO_ID}:0`);
    expect(opts.params.exposure).toBe(1);
    expect(opts.asShotTemperature).toBe(5000);
    expect(opts.maxEdge).toBe(THUMB_MAX_EDGE);
    expect(opts.contributedParams).toEqual({ "ext.stage.k": 3 });

    expect(written).toHaveLength(1);
    expect(written[0].thumbnailBlob).toBe(rendered);
    expect(written[0].thumbnailUrl).toBe("blob:thumb");
    expect(catalog.updatePhoto).toHaveBeenCalledWith(written[0]);
  });

  it("neither decodes nor uploads when the source is already resident", async () => {
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(decode).not.toHaveBeenCalled();
    expect(bridge.uploadSource).not.toHaveBeenCalled();
  });

  it("writes back onto the photo record as it stands at the end of the render", async () => {
    const g = gate();
    bridge.renderThumbnailFromSource.mockImplementation(async () => {
      await g.wait;
      return rendered;
    });
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    catalog.photos = [photo({ rating: 4 })]; // culled in the Library mid-render
    g.open();
    await settle();
    expect(written[0].rating).toBe(4);
  });

  it("does nothing for a photo that is not in the catalog", async () => {
    catalog.photos = [];
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(bridge.renderThumbnailFromSource).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it("abandons the write when the photo disappears mid-render", async () => {
    const g = gate();
    bridge.renderThumbnailFromSource.mockImplementation(async () => {
      await g.wait;
      return rendered;
    });
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    catalog.photos = [];
    g.open();
    await settle();
    expect(written).toHaveLength(0);
    expect(catalog.updatePhoto).not.toHaveBeenCalled();
  });
});

describe("source ladder", () => {
  it("decodes and uploads a capped source on the first commit, then renders", async () => {
    const image: DecodedImage = {
      kind: "float",
      data: new Float32Array(4),
      width: 2,
      height: 2,
      isFallbackPreview: true,
    };
    decode.mockResolvedValue(image);
    bridge.renderThumbnailFromSource
      .mockResolvedValueOnce(null) // cache miss
      .mockResolvedValueOnce(rendered);

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    expect(bridge.uploadSource).toHaveBeenCalledWith(
      "thumb",
      `${PHOTO_ID}:0`,
      image,
      1280,
      true, // a fallback preview stays flagged so the renderer tones it right
      false,
    );
    expect(bridge.renderThumbnailFromSource).toHaveBeenCalledTimes(2);
    expect(written[0].thumbnailBlob).toBe(rendered);
  });

  it("uploads a decoded bitmap without a base curve", async () => {
    const bitmap = { width: 2, height: 2 } as unknown as ImageBitmap;
    decode.mockResolvedValue({ kind: "bitmap", bitmap, cached: true });
    bridge.renderThumbnailFromSource
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rendered);

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    expect(bridge.uploadSource).toHaveBeenCalledWith(
      "thumb",
      `${PHOTO_ID}:0`,
      { kind: "bitmap", bitmap }, // re-wrapped: the cache flag is not the renderer's
      1280,
      false,
      false,
    );
  });

  it("falls back to the camera JPEG when no source can be obtained", async () => {
    catalog.photos = [photo({ thumbnailBlob: new Blob(["jpeg"]) })];
    bridge.renderThumbnailFromSource.mockResolvedValue(null);
    bridge.renderThumbnailAsync.mockResolvedValue(rendered);
    const bitmap = { width: 2, height: 2 } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", async () => bitmap);

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000, { "ext.stage.k": 3 });
    await settle();

    expect(bridge.renderThumbnailAsync).toHaveBeenCalledTimes(1);
    const opts = bridge.renderThumbnailAsync.mock.calls[0][0] as ThumbRenderOpts & {
      image: { kind: string; bitmap: ImageBitmap };
    };
    expect(opts.image).toEqual({ kind: "bitmap", bitmap });
    expect(opts.contributedParams).toEqual({ "ext.stage.k": 3 });
    expect(written[0].thumbnailBlob).toBe(rendered);
  });

  it("keeps the existing preview when every path fails", async () => {
    catalog.photos = [photo({ thumbnailBlob: new Blob(["jpeg"]) })];
    bridge.renderThumbnailFromSource.mockResolvedValue(null);
    bridge.renderThumbnailAsync.mockResolvedValue(null);
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("undecodable");
    });

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(written).toHaveLength(0);
    expect(catalog.updatePhoto).not.toHaveBeenCalled();
  });

  it("keeps the existing preview when there is nothing left to fall back to", async () => {
    bridge.renderThumbnailFromSource.mockResolvedValue(null);
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(bridge.renderThumbnailAsync).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });
});

describe("per-photo coalescing", () => {
  it("collapses a burst of commits into one trailing render of the latest look", async () => {
    const g = gate();
    bridge.renderThumbnailFromSource.mockImplementation(async () => {
      await g.wait;
      return rendered;
    });

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    regenerateEditedThumbnail(PHOTO_ID, params(2), 5000);
    regenerateEditedThumbnail(PHOTO_ID, params(3), 5000);
    regenerateEditedThumbnail(PHOTO_ID, params(4), 5000);

    g.open();
    await settle();

    const exposures = bridge.renderThumbnailFromSource.mock.calls.map(
      ([o]) => o.params.exposure,
    );
    expect(exposures).toEqual([1, 4]);
  });

  it("keeps different photos independent", async () => {
    const g = gate();
    catalog.photos = [photo(), photo({ id: "photo-2" })];
    bridge.renderThumbnailFromSource.mockImplementation(async () => {
      await g.wait;
      return rendered;
    });

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    regenerateEditedThumbnail("photo-2", params(2), 5000);
    await settle();
    expect(bridge.renderThumbnailFromSource).toHaveBeenCalledTimes(2);

    g.open();
    await settle();
  });

  it("releases the photo after a failed render, and still runs the queued one", async () => {
    // A rejected regen must stay contained (no unhandled rejection) and must not
    // wedge the photo as permanently in-flight.
    const g = gate();
    putPhoto = async () => {
      await g.wait;
      throw new Error("disk is read-only");
    };
    bridge.renderThumbnailFromSource.mockResolvedValue(rendered);

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    regenerateEditedThumbnail(PHOTO_ID, params(2), 5000);

    putPhoto = async (p) => void written.push(p);
    g.open();
    await settle();

    expect(bridge.renderThumbnailFromSource).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(1);
    expect(catalog.updatePhoto).toHaveBeenCalledTimes(1);
  });

  it("accepts a fresh commit once a failed render has settled", async () => {
    putPhoto = async () => {
      throw new Error("disk is read-only");
    };
    bridge.renderThumbnailFromSource.mockResolvedValue(rendered);
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    putPhoto = async (p) => void written.push(p);
    regenerateEditedThumbnail(PHOTO_ID, params(2), 5000);
    await settle();
    expect(written).toHaveLength(1);
    expect(written[0].thumbnailBlob).toBe(rendered);
  });
});
