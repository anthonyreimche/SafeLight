// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Post-commit grid-thumbnail regeneration: the three-step source ladder
// (resident GPU source → decode + upload → camera JPEG), the per-photo
// coalescing that collapses a burst of commits into one trailing render, and
// the guards that stop a stale or failed render from damaging the catalogue. The
// worker bridge and the decoder are the expensive edges, so they're faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImage, Fallback, LoadImageOptions } from "@/catalog/load-image";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { normalizeParams } from "@/catalog/types";
import type { RebuiltChange } from "./catalog-store";
import type { RendererAvailability } from "@/rendering/render-bridge";

interface ThumbRenderOpts {
  requestId: string;
  key: string;
  params: DevelopParams;
  asShotTemperature: number;
  maxEdge: number;
  quality?: number;
  contributedParams?: Record<string, unknown>;
  preview?: boolean;
}

const bridge = vi.hoisted(() => ({
  ready: Promise.resolve(),
  availability: "ready" as RendererAvailability,
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
    ) => void
  >(),
}));

const decode = vi.hoisted(() =>
  vi.fn<
    (photo: CatalogPhoto, opts?: LoadImageOptions) => Promise<DecodedImage | null>
  >(),
);

const catalog = vi.hoisted(() => ({
  photos: [] as CatalogPhoto[],
  mergeRebuiltPhoto: vi.fn<(id: string, change: RebuiltChange) => void>(),
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
import { editFingerprint } from "@/catalog/edit-fingerprint";
import { installMemoryStorage } from "@/catalog/stored-edit.fixtures";
import { denoiseBag } from "@/rendering/webgl/builtin-denoise";

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
  putPhoto: (p) => putPhoto(p),
  putPhotos: async () => {},
  deletePhotos: async () => {},
  getEditState: async () => undefined,
  putEditState: async () => {},
  putEditStates: async () => {},
};

beforeEach(() => {
  written = [];
  putPhoto = async (p) => void written.push(p);
  setCatalogStorage(storage);
  catalog.photos = [photo()];
  catalog.mergeRebuiltPhoto.mockClear();
  bridge.availability = "ready";
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

// On a machine where WebGL2 can't start, every rung would decode the photo for a
// render that can't happen.
it("neither renders nor decodes once the renderer has failed, and keeps the preview", async () => {
  bridge.availability = "failed";
  catalog.photos = [photo({ thumbnailBlob: new Blob(["camera"]) })];
  regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
  await settle();

  expect(bridge.renderThumbnailFromSource).not.toHaveBeenCalled();
  expect(bridge.renderThumbnailAsync).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled();
  expect(written).toEqual([]);
});

describe("rendering from the resident source", () => {
  beforeEach(() => {
    bridge.renderThumbnailFromSource.mockResolvedValue(rendered);
  });

  it("renders the committed look and writes it back to the catalogue", async () => {
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000, { "ext.stage.k": 3 });
    await settle();

    expect(bridge.renderThumbnailFromSource).toHaveBeenCalledTimes(1);
    const opts = bridge.renderThumbnailFromSource.mock.calls[0][0];
    expect(opts.key).toBe(`${PHOTO_ID}:0`);
    expect(opts.params.exposure).toBe(1);
    expect(opts.asShotTemperature).toBe(5000);
    expect(opts.maxEdge).toBe(THUMB_MAX_EDGE);
    expect(opts.preview).toBe(true);
    expect(opts.contributedParams).toEqual({ "ext.stage.k": 3, ...denoiseBag(params(1)) });

    expect(written).toHaveLength(1);
    expect(written[0].thumbnailBlob).toBe(rendered);
    expect(written[0].thumbnailUrl).toBe("blob:thumb");
    // Only the preview and the edit it shows: the rest of the photo may change in
    // the store meanwhile.
    expect(catalog.mergeRebuiltPhoto).toHaveBeenCalledWith(PHOTO_ID, {
      thumbnailBlob: rendered,
      thumbnailUrl: "blob:thumb",
      previewEdit: editFingerprint(params(1), { "ext.stage.k": 3 }),
    });
  });

  // The thumb renderer draws the bag it is handed in place of its own, so the
  // built-in denoiser's entries, which come from the Detail panel's params, go in it.
  it("draws the photo's bag with the built-in denoiser's entries, as Develop does", async () => {
    const nr = normalizeParams({ luminanceNR: 40 });
    regenerateEditedThumbnail(PHOTO_ID, nr, 5000, { "ext.stage.k": 3 });
    await settle();
    const opts = bridge.renderThumbnailFromSource.mock.calls[0][0];
    expect(opts.contributedParams).toEqual({ "ext.stage.k": 3, ...denoiseBag(nr) });
    expect(opts.contributedParams).toHaveProperty("builtin.denoise.lumAmount", 40);
    expect(written[0].previewEdit).toBe(editFingerprint(nr, { "ext.stage.k": 3 }));
  });

  // Develop draws the stored preview first only while it shows the edit it opens with.
  it("records which edit the preview shows", async () => {
    const bag = { "ext.stage.k": 3 };
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000, bag);
    await settle();
    expect(written[0].previewEdit).toBe(editFingerprint(params(1), bag));
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

  it("does nothing for a photo that is not in the catalogue", async () => {
    catalog.photos = [];
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(bridge.renderThumbnailFromSource).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  // A turn changes the photo's rotation, and a preview rendered at the old one would
  // show it the old way round under the new rotation.
  const textOf = (blob: Blob | null | undefined) => blob?.text();

  it("renders again, at the new rotation, a preview whose photo was turned while it rendered", async () => {
    const g = gate();
    bridge.renderThumbnailFromSource.mockImplementation(async (opts) => {
      if (opts.key.endsWith(":0")) await g.wait;
      return new Blob([opts.key]);
    });
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    catalog.photos = [photo({ rotation: 90 })];
    g.open();
    await settle();

    expect(bridge.renderThumbnailFromSource.mock.calls.map(([o]) => o.key)).toEqual([
      `${PHOTO_ID}:0`,
      `${PHOTO_ID}:90`,
    ]);
    expect(written).toHaveLength(1);
    await expect(textOf(written[0].thumbnailBlob)).resolves.toBe(`${PHOTO_ID}:90`);
    expect(catalog.mergeRebuiltPhoto).toHaveBeenCalledTimes(1);
  });

  it("renders again when the photo is turned while its preview is being stored", async () => {
    const g = gate();
    bridge.renderThumbnailFromSource.mockImplementation(async (opts) => new Blob([opts.key]));
    putPhoto = async (p) => {
      written.push(p);
      if (written.length > 1) return;
      catalog.photos = [photo({ rotation: 90 })];
      await g.wait;
    };
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    g.open();
    await settle();

    expect(catalog.mergeRebuiltPhoto).toHaveBeenCalledTimes(1);
    const merged = catalog.mergeRebuiltPhoto.mock.calls[0][1];
    await expect(textOf(merged.thumbnailBlob)).resolves.toBe(`${PHOTO_ID}:90`);
    await expect(textOf(written.at(-1)?.thumbnailBlob)).resolves.toBe(`${PHOTO_ID}:90`);
  });

  it("takes a photo saved with no rotation as unturned, and renders it once", async () => {
    const g = gate();
    bridge.renderThumbnailFromSource.mockImplementation(async () => {
      await g.wait;
      return rendered;
    });
    const saved: CatalogPhoto = JSON.parse(JSON.stringify({ ...photo(), rotation: undefined }));
    catalog.photos = [saved];
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    catalog.photos = [photo({ rotation: 0 })]; // the same turn, now written out
    g.open();
    await settle();

    expect(bridge.renderThumbnailFromSource).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
  });

  it("stores nothing once the project changed while it rendered", async () => {
    const g = gate();
    bridge.renderThumbnailFromSource.mockImplementation(async () => {
      await g.wait;
      return rendered;
    });
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    installMemoryStorage(); // another project, or this one opened again
    g.open();
    await settle();

    expect(written).toHaveLength(0);
    expect(catalog.mergeRebuiltPhoto).not.toHaveBeenCalled();
  });

  it("shows nothing once the project changed while its preview was stored", async () => {
    const g = gate();
    putPhoto = async (p) => {
      written.push(p);
      installMemoryStorage();
      await g.wait;
    };
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    g.open();
    await settle();

    expect(catalog.mergeRebuiltPhoto).not.toHaveBeenCalled();
  });

  // The edit committed as a project closes: the catalogue is gone by the time it renders.
  it("stores the preview of a photo whose project was left, in the catalogue it was left", async () => {
    const left = photo({ rating: 2 });
    catalog.photos = [];
    installMemoryStorage(); // the next project
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000, undefined, { photo: left, storage });
    await settle();

    expect(written).toHaveLength(1);
    expect(written[0].rating).toBe(2);
    expect(written[0].thumbnailBlob).toBe(rendered);
    expect(written[0].previewEdit).toBe(editFingerprint(params(1), {}));
    expect(catalog.mergeRebuiltPhoto).not.toHaveBeenCalled();
  });

  it("keeps what the catalogue holds of a left photo, changing only its preview", async () => {
    const left = photo({ rating: 2 });
    catalog.photos = [];
    const held = photo({ rating: 5, flag: "pick" });
    const holding: CatalogStorage = { ...storage, heldPhoto: () => held };
    await regenerateEditedThumbnail(PHOTO_ID, params(1), 5000, undefined, { photo: left, storage: holding });

    expect(written).toHaveLength(1);
    expect(written[0].rating).toBe(5);
    expect(written[0].flag).toBe("pick");
    expect(written[0].thumbnailBlob).toBe(rendered);
  });

  it("writes nothing for a left photo the catalogue no longer holds", async () => {
    catalog.photos = [];
    const holding: CatalogStorage = { ...storage, heldPhoto: () => undefined };
    await regenerateEditedThumbnail(PHOTO_ID, params(1), 5000, undefined, { photo: photo(), storage: holding });
    expect(written).toHaveLength(0);
  });

  it("resolves once the preview is stored, also for a commit coalesced into a running one", async () => {
    const g = gate();
    putPhoto = async (p) => {
      await g.wait;
      written.push(p);
    };
    let first = false;
    let second = false;
    void regenerateEditedThumbnail(PHOTO_ID, params(1), 5000).then(() => (first = true));
    await settle();
    void regenerateEditedThumbnail(PHOTO_ID, params(2), 5000).then(() => (second = true));
    await settle();
    expect([first, second, written.length]).toEqual([false, false, 0]);

    g.open();
    await settle();
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(written).toHaveLength(2);
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
    expect(catalog.mergeRebuiltPhoto).not.toHaveBeenCalled();
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
    );
    expect(bridge.renderThumbnailFromSource).toHaveBeenCalledTimes(2);
    expect(written[0].thumbnailBlob).toBe(rendered);
  });

  it("uploads a decoded bitmap on its own", async () => {
    const bitmap = { width: 2, height: 2 } as unknown as ImageBitmap;
    decode.mockResolvedValue({ kind: "bitmap", bitmap });
    bridge.renderThumbnailFromSource
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(rendered);

    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();

    expect(bridge.uploadSource).toHaveBeenCalledWith(
      "thumb",
      `${PHOTO_ID}:0`,
      { kind: "bitmap", bitmap },
      1280,
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
    expect(opts.contributedParams).toEqual({ "ext.stage.k": 3, ...denoiseBag(params(1)) });
    expect(written[0].thumbnailBlob).toBe(rendered);
  });

  it("draws the camera JPEG with the built-in denoiser's entries too", async () => {
    catalog.photos = [photo({ thumbnailBlob: new Blob(["jpeg"]) })];
    bridge.renderThumbnailFromSource.mockResolvedValue(null);
    bridge.renderThumbnailAsync.mockResolvedValue(rendered);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 2, height: 2 }) as unknown as ImageBitmap);
    const nr = normalizeParams({ colorNR: 30 });

    regenerateEditedThumbnail(PHOTO_ID, nr, 5000, { "ext.stage.k": 3 });
    await settle();

    const opts = bridge.renderThumbnailAsync.mock.calls[0][0] as ThumbRenderOpts;
    expect(opts.contributedParams).toEqual({ "ext.stage.k": 3, ...denoiseBag(nr) });
    expect(opts.contributedParams).toHaveProperty("builtin.denoise.colAmount", 30);
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
    expect(catalog.mergeRebuiltPhoto).not.toHaveBeenCalled();
  });

  it("keeps the existing preview when there is nothing left to fall back to", async () => {
    bridge.renderThumbnailFromSource.mockResolvedValue(null);
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(bridge.renderThumbnailAsync).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  // A grid thumbnail is never what the user is waiting on; its decode must not
  // hold up the photo they just opened.
  it("decodes as background work", async () => {
    bridge.renderThumbnailFromSource.mockResolvedValue(null);
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(decode).toHaveBeenCalledWith(
      expect.objectContaining({ id: PHOTO_ID }),
      { background: true },
    );
  });

  // A converted non-RAW frame is averaged down in the worker; a RAW's decode and
  // cache entry are left at full size.
  it("asks a non-RAW photo's load for no more than the thumb source's edge", async () => {
    catalog.photos = [photo({ filename: "IMG_1.JPG" })];
    bridge.renderThumbnailFromSource.mockResolvedValue(null);
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
    expect(decode).toHaveBeenCalledWith(
      expect.objectContaining({ id: PHOTO_ID }),
      { background: true, targetEdge: 1280 },
    );
  });
});

describe("a preview the load fell back on", () => {
  /** The thumb renderer's source cache: a render from a key hits once it's uploaded. */
  function residentSources() {
    const keys = new Set<string>();
    bridge.uploadSource.mockImplementation((_target, key) => void keys.add(key));
    bridge.renderThumbnailFromSource.mockImplementation(async (opts) =>
      keys.has(opts.key) ? rendered : null,
    );
    bridge.renderThumbnailAsync.mockResolvedValue(rendered);
    return keys;
  }

  const fakeBitmap = () => ({ width: 2, height: 2, close: vi.fn() }) as unknown as ImageBitmap;
  const fellBack = (fallback: Fallback): DecodedImage => ({
    kind: "bitmap",
    bitmap: fakeBitmap(),
    fallback,
  });
  const NONE = { offline: false, unsupported: false, timedOut: false };

  /** One regeneration, run to the end. */
  async function regenerate(): Promise<void> {
    regenerateEditedThumbnail(PHOTO_ID, params(1), 5000);
    await settle();
  }

  it("isn't kept as the photo's source when the decode timed out, so the next one loads again", async () => {
    const keys = residentSources();
    decode.mockImplementation(async () => fellBack({ from: "embedded", ...NONE, timedOut: true }));

    await regenerate();
    await regenerate();

    expect(keys.has(`${PHOTO_ID}:0`)).toBe(false);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(2);
  });

  // An edit rendered over the plain stored preview and written back would name an
  // edit (previewEdit), so from then on the load would hand it over as "stored-edited"
  // and Develop, which never renders over that, could show no later edit at all.
  it("leaves the plain stored preview of an original out of reach as it is, commit after commit", async () => {
    const keys = residentSources();
    const stored: DecodedImage[] = [];
    decode.mockImplementation(async () => {
      const image = fellBack({ from: "stored", ...NONE, offline: true });
      stored.push(image);
      return image;
    });

    await regenerate();
    regenerateEditedThumbnail(PHOTO_ID, params(2), 5000);
    await settle();

    expect(keys.has(`${PHOTO_ID}:0`)).toBe(false);
    expect(bridge.renderThumbnailAsync).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
    expect(catalog.mergeRebuiltPhoto).not.toHaveBeenCalled();
    expect(stored).toHaveLength(2);
    for (const image of stored)
      if (image.kind === "bitmap") expect(image.bitmap.close).toHaveBeenCalled();
  });

  it("is never rendered over, nor written back, when it already shows the edit", async () => {
    residentSources();
    catalog.photos = [photo({ thumbnailBlob: new Blob(["edited"]), previewEdit: "e1" })];
    const stored = fellBack({ from: "stored-edited", ...NONE, offline: true });
    decode.mockResolvedValue(stored);

    await regenerate();

    expect(bridge.uploadSource).not.toHaveBeenCalled();
    expect(bridge.renderThumbnailAsync).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
    expect(catalog.mergeRebuiltPhoto).not.toHaveBeenCalled();
    if (stored.kind === "bitmap") expect(stored.bitmap.close).toHaveBeenCalled();
  });

  it("doesn't render over the grid's preview when it already shows an edit", async () => {
    residentSources();
    catalog.photos = [photo({ thumbnailBlob: new Blob(["edited"]), previewEdit: "e1" })];
    decode.mockResolvedValue(null); // passed over for now
    vi.stubGlobal("createImageBitmap", async () => fakeBitmap());

    await regenerate();

    expect(bridge.renderThumbnailAsync).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it("keeps a full decode as the photo's source, and renders from it next time", async () => {
    const keys = residentSources();
    decode.mockResolvedValue({ kind: "float", data: new Float32Array(4), width: 2, height: 2 });

    await regenerate();
    await regenerate();

    expect(keys.has(`${PHOTO_ID}:0`)).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(2);
  });

  it("isn't kept as the photo's source when it is the stored preview of a RAW it can't open", async () => {
    const keys = residentSources();
    decode.mockImplementation(async () => fellBack({ from: "stored", ...NONE, unsupported: true }));

    await regenerate();

    expect(keys.has(`${PHOTO_ID}:0`)).toBe(false);
    expect(written).toHaveLength(0);
  });

  it("keeps the camera preview of a RAW it can't open as the photo's source", async () => {
    const keys = residentSources();
    decode.mockImplementation(async () => fellBack({ from: "embedded", ...NONE, unsupported: true }));

    await regenerate();

    expect(keys.has(`${PHOTO_ID}:0`)).toBe(true);
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
    expect(written.map((p) => p.previewEdit)).toEqual([
      editFingerprint(params(1), {}),
      editFingerprint(params(4), {}),
    ]);
    expect(catalog.mergeRebuiltPhoto.mock.calls.at(-1)?.[1].previewEdit).toBe(
      editFingerprint(params(4), {}),
    );
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
    expect(catalog.mergeRebuiltPhoto).toHaveBeenCalledTimes(1);
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
