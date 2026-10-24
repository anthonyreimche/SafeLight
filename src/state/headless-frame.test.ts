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
import type { FloatCaptureOptions, FloatFrame } from "@/rendering/float-frame";
import { normalizeParams } from "@/catalog/types";
import { photo as fixture } from "@/catalog/stored-edit.fixtures";
import { denoiseBag } from "@/rendering/webgl/builtin-denoise";

const h = vi.hoisted(() => ({
  photos: [] as CatalogPhoto[],
  /** The keys uploaded to the thumb renderer's source cache. */
  resident: new Set<string>(),
  decoded: null as DecodedImage | null,
  decodes: 0,
  /** Loads the photo: by default `decoded`, counting a decode each time. */
  load: null as ((opts?: { background?: boolean }) => DecodedImage | null) | null,
  asyncRenders: 0,
  /** The as-shot temperature each render from the resident source was given. */
  sourceTemperatures: [] as number[],
  /** Every request the bridge was asked to render, and which of its calls took it. */
  requests: [] as { call: "source" | "bitmap" | "float"; request: Record<string, unknown> }[],
  /** What a float render answers when it isn't a miss. */
  floatFrame: null as FloatFrame | null,
  /** Whether a render from an image rejects, as one the worker failed does. */
  asyncFails: false,
  /** The worker's EXT_color_buffer_float flag, as the bridge reports it once ready. */
  pipelineFloat: true,
}));

vi.mock("@/rendering/render-bridge", () => ({
  getRenderBridge: () => ({
    ready: Promise.resolve(),
    pipelineFloat: h.pipelineFloat,
    uploadSource: (_target: string, key: string) => void h.resident.add(key),
    renderThumbnailFromSource: async (opts: { key: string; asShotTemperature: number }) => {
      h.requests.push({ call: "source", request: opts });
      if (!h.resident.has(opts.key)) return null;
      h.sourceTemperatures.push(opts.asShotTemperature);
      return new Blob(["from source"]);
    },
    renderThumbnailAsync: async (opts: Record<string, unknown>) => {
      h.requests.push({ call: "bitmap", request: opts });
      h.asyncRenders++;
      if (h.asyncFails) throw new Error("thumbnail render failed");
      return new Blob(["from bitmap"]);
    },
    renderThumbnailFloat: async (opts: { key?: string }) => {
      h.requests.push({ call: "float", request: opts });
      if (opts.key !== undefined && !h.resident.has(opts.key)) return null;
      return h.floatFrame;
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

import { renderPhotoFloatFrame, renderPhotoFrame } from "./headless-frame";

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
  h.sourceTemperatures = [];
  h.requests = [];
  h.floatFrame = null;
  h.asyncFails = false;
  h.pipelineFloat = true;
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

  it("renders a first touch at the as-shot white balance its decode learned", async () => {
    // A RAW whose import left its metadata pending has no as-shot white balance
    // until a decode reads one, which the load stores on the photo.
    h.load = () => {
      h.photos[0].exif.colorTemperature = 5200;
      return { kind: "float", data: new Float32Array(4), width: 2, height: 2 };
    };

    await measure();

    expect(h.sourceTemperatures).toEqual([5200]);
  });

  it("is null, not a failure, when rendering a preview once fails", async () => {
    h.decoded = fellBack({ from: "embedded", ...NONE, timedOut: true });
    h.asyncFails = true;

    await expect(measure()).resolves.toBeNull();

    expect(h.asyncRenders).toBe(1);
  });

  it("doesn't fall back on the grid's preview when it already shows an edit", async () => {
    h.photos = [{ ...fixture(ID), thumbnailBlob: new Blob(["edited"]), previewEdit: "e1" }];

    await expect(measure()).resolves.toBeNull();

    expect(h.asyncRenders).toBe(0);
  });
});

// A frame that carries data rather than a picture (a stage's measurement encoding,
// say) is read back byte for byte, so the extension can ask for it lossless. Every
// path a frame can take has to carry the ask to the renderer, and a frame asked for
// without it is encoded exactly as before: JPEG at 0.9.
describe("the encoding of a measured frame", () => {
  const params = normalizeParams({ exposure: 1 });
  const LAST_RESORT: [string, "source" | "bitmap", () => void] = [
    "the grid's preview, as a last resort",
    "bitmap",
    () => {
      h.photos = [{ ...fixture(ID), thumbnailBlob: new Blob(["preview"]) }];
    },
  ];
  const LOSSLESS_PATHS: [string, "source" | "bitmap", () => void][] = [
    ["the resident source", "source", () => void h.resident.add(KEY)],
    [
      "a first touch that uploads the source",
      "source",
      () => {
        h.decoded = { kind: "float", data: new Float32Array(4), width: 2, height: 2 };
      },
    ],
    [
      "a preview rendered once",
      "bitmap",
      () => {
        h.decoded = fellBack({ from: "embedded", ...NONE, timedOut: true });
      },
    ],
  ];
  const PATHS = [...LOSSLESS_PATHS, LAST_RESORT];

  it.each(LOSSLESS_PATHS)("asks for a lossless frame on %s", async (_label, call, arrange) => {
    arrange();

    await expect(
      renderPhotoFrame(ID, params, undefined, { lossless: true }),
    ).resolves.toBe(frame);

    expect(h.requests.at(-1)?.call).toBe(call);
    expect(h.requests.length).toBeGreaterThan(0);
    for (const { request } of h.requests) expect(request).toMatchObject({ lossless: true });
  });

  it.each(PATHS)("keeps JPEG at 0.9, with no new field, on %s", async (_label, call, arrange) => {
    arrange();

    await expect(measure()).resolves.toBe(frame);

    expect(h.requests.at(-1)?.call).toBe(call);
    for (const { request } of h.requests) {
      expect(request).not.toHaveProperty("lossless");
      expect(request).toMatchObject({ quality: 0.9 });
    }
  });

  it("treats lossless: false as no option at all", async () => {
    h.resident.add(KEY);

    await renderPhotoFrame(ID, params, undefined, { lossless: false });

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].request).not.toHaveProperty("lossless");
    expect(h.requests[0].request).toMatchObject({ quality: 0.9 });
  });

  it("hands the photo's stage params through alongside the option", async () => {
    h.resident.add(KEY);
    const bag = { "ext.stage.mode": 1 };

    await renderPhotoFrame(ID, params, bag, { lossless: true });

    expect(h.requests[0].request).toMatchObject({ contributedParams: bag, lossless: true });
  });
});

// The live Develop view draws with the photo's stage bag under the keys Safelight's
// built-in stages take from the params: the Detail panel's noise reduction, on by
// default. A measured frame draws with the same bag, or it measures a photo the
// user never sees.
describe("the stage bag of a measured frame", () => {
  const params = normalizeParams({ exposure: 1 });
  const bag = { "ext.stage.mode": 1 };
  const CALLS: [string, () => void][] = [
    ["the resident source", () => void h.resident.add(KEY)],
    [
      "the grid's preview, as a last resort",
      () => {
        h.photos = [{ ...fixture(ID), thumbnailBlob: new Blob(["preview"]) }];
      },
    ],
  ];

  it.each(CALLS)("carries the core noise reduction under the caller's bag on %s", async (_label, arrange) => {
    arrange();

    await renderPhotoFrame(ID, params, bag);

    expect(h.requests.length).toBeGreaterThan(0);
    for (const { request } of h.requests) {
      expect(request.contributedParams).toMatchObject({ ...bag, "builtin.denoise.colAmount": params.colorNR });
      expect(request.contributedParams).toEqual({ ...bag, ...denoiseBag(params) });
    }
  });

  it("takes the core keys from the params over the bag's, as the live view does", async () => {
    h.resident.add(KEY);

    await renderPhotoFrame(ID, params, { ...bag, "builtin.denoise.colAmount": 0 });

    expect(h.requests[0].request.contributedParams).toMatchObject({
      ...bag,
      "builtin.denoise.colAmount": params.colorNR,
    });
  });

  it("sends no bag when the caller gives none, so the renderer keeps its own", async () => {
    h.resident.add(KEY);

    await renderPhotoFrame(ID, params);

    expect(h.requests[0].request.contributedParams).toBeUndefined();
  });
});

// A frame asked for lossless carries data about the photo's own pixels, so one
// rendered from another source (the grid's camera JPEG) would be wrong rather
// than merely flat: there is no frame, and the caller reads that as not yet.
describe("a lossless frame with no source of the photo's own", () => {
  const params = normalizeParams({ exposure: 1 });
  const arrange = () => {
    h.photos = [{ ...fixture(ID), thumbnailBlob: new Blob(["preview"]) }];
  };

  it("is null, and the grid's preview is not rendered", async () => {
    arrange();

    await expect(renderPhotoFrame(ID, params, undefined, { lossless: true })).resolves.toBeNull();

    expect(h.asyncRenders).toBe(0);
    expect(h.requests.filter(({ call }) => call === "bitmap")).toEqual([]);
    expect(h.resident.size).toBe(0);
  });

  it("is null for a RAW the background load passed over", async () => {
    arrange();
    h.load = () => null;

    await expect(renderPhotoFrame(ID, params, undefined, { lossless: true })).resolves.toBeNull();

    expect(h.asyncRenders).toBe(0);
  });

  it("is still rendered once the photo's own source is resident", async () => {
    arrange();
    h.resident.add(KEY);

    await expect(renderPhotoFrame(ID, params, undefined, { lossless: true })).resolves.toBe(frame);
  });

  it("falls back on the grid's preview for a frame that is not lossless, as before", async () => {
    arrange();

    await expect(renderPhotoFrame(ID, params)).resolves.toBe(frame);
    await expect(renderPhotoFrame(ID, params, undefined, { lossless: false })).resolves.toBe(frame);

    expect(h.asyncRenders).toBe(2);
  });
});

// A float frame carries data about the photo's own pixels, as a lossless frame
// does: it takes the same sources, small, read at the point and in the space
// asked for, and never the grid's camera preview, which is another source.
describe("a float frame of a photo", () => {
  const params = normalizeParams({ exposure: 1 });
  const FLOAT = { point: "output", space: { encoding: "perceptual", primaries: "rec2020" } } as const;
  const FRAME: FloatFrame = { data: new Float32Array(4), width: 1, height: 1, space: FLOAT.space, point: FLOAT.point };
  const floats = (opts?: FloatCaptureOptions) => renderPhotoFloatFrame(ID, params, opts);

  beforeEach(() => {
    h.floatFrame = FRAME;
  });

  it("resolves the frame the resident source renders, small, at the point and in the space asked for", async () => {
    h.resident.add(KEY);

    await expect(floats(FLOAT)).resolves.toBe(FRAME);

    expect(h.requests).toEqual([
      { call: "float", request: expect.objectContaining({ key: KEY, params, maxEdge: 640, float: FLOAT }) },
    ]);
    expect(h.requests[0].request).not.toHaveProperty("quality");
    expect(h.requests[0].request).not.toHaveProperty("lossless");
    expect(h.decodes).toBe(0);
  });

  it("decodes, uploads and renders again from the source on a miss", async () => {
    h.decoded = { kind: "float", data: new Float32Array(4), width: 2, height: 2 };

    await expect(floats(FLOAT)).resolves.toBe(FRAME);

    expect(h.decodes).toBe(1);
    expect(h.resident.has(KEY)).toBe(true);
    expect(h.requests.map(({ call, request }) => [call, request.key, request.float])).toEqual([
      ["float", KEY, FLOAT],
      ["float", KEY, FLOAT],
    ]);
  });

  it("renders a preview the load fell back on once, from the image, as a lossless frame does", async () => {
    const preview = fellBack({ from: "embedded", ...NONE, timedOut: true });
    h.decoded = preview;

    await expect(floats(FLOAT)).resolves.toBe(FRAME);

    expect(h.resident.size).toBe(0);
    expect(h.requests.at(-1)).toEqual({
      call: "float",
      request: expect.objectContaining({ image: { kind: "bitmap", bitmap: preview.bitmap }, maxEdge: 640, float: FLOAT }),
    });
  });

  it("is null, and never renders the grid's camera preview, for a photo with no source of its own", async () => {
    h.photos = [{ ...fixture(ID), thumbnailBlob: new Blob(["preview"]) }];
    const decodeBlob = vi.fn(async () => frame);
    vi.stubGlobal("createImageBitmap", decodeBlob);

    await expect(floats(FLOAT)).resolves.toBeNull();

    expect(decodeBlob).not.toHaveBeenCalled();
    expect(h.requests.filter(({ request }) => "image" in request)).toEqual([]);
    expect(h.asyncRenders).toBe(0);
  });

  it("is null for a photo the catalog doesn't hold, asking the renderer nothing", async () => {
    await expect(renderPhotoFloatFrame("unknown", params, FLOAT)).resolves.toBeNull();

    expect(h.requests).toEqual([]);
    expect(h.decodes).toBe(0);
  });

  it("is null when the renderer reads no frame, as without float render targets", async () => {
    h.resident.add(KEY);
    h.floatFrame = null;

    await expect(floats(FLOAT)).resolves.toBeNull();
  });

  it("is null without float render targets, before any render or decode", async () => {
    // Every rung would read null there, and a null from a resident source starts
    // a decode: a call per photo of a selection would decode them all for nothing.
    h.pipelineFloat = false;
    h.floatFrame = null;
    h.decoded = { kind: "float", data: new Float32Array(4), width: 2, height: 2 };

    await expect(floats(FLOAT)).resolves.toBeNull();

    expect(h.requests).toEqual([]);
    expect(h.decodes).toBe(0);
    expect(h.resident.size).toBe(0);
  });

  it("draws the bag under the core noise reduction, as renderPhotoFrame draws its bag", async () => {
    h.resident.add(KEY);
    const bag = { "ext.stage.mode": 1, "builtin.denoise.colAmount": 0 };

    await floats({ ...FLOAT, paramBag: bag });

    expect(h.requests[0].request.contributedParams).toEqual({ ...bag, ...denoiseBag(params) });
    expect(h.requests[0].request.float).toEqual(FLOAT);
  });

  it("sends no bag when the caller gives none, so the renderer keeps its own", async () => {
    h.resident.add(KEY);

    await floats(FLOAT);

    expect(h.requests[0].request.contributedParams).toBeUndefined();
  });
});
