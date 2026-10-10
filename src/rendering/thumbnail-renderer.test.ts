// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Library Info histogram renders on the main thread at a 256 px edge. When
// no grid thumbnail is loaded it falls back to the full photo load, which for
// a RAW is usually the cached develop preview; that must be capped to the
// histogram's edge, not uploaded at the cache's stored size. The renderer is
// faked here (its cap is covered on a real GL context by
// renderer.webgl.test.ts); this pins what the histogram asks of it.
//
// A renderer builds its develop program on the first frame it draws, so the
// histogram builds it up front, with the photo's process version. Stages or a
// display transform that can't be built fail that photo only: it gets no
// histogram and a later one, with a stage set that works, gets one from the same
// renderer. Only a stock program the driver can't build ends the histogram for
// the session, as a renderer that can't be created does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION, normalizeParams } from "@/catalog/types";

const h = vi.hoisted(() => {
  class FakeRenderer {
    static instances: FakeRenderer[] = [];
    static setImageCalls: unknown[][] = [];
    /** Whether prepareProgram throws, for this renderer and process version. */
    static prepareFails: (version: number, renderer: FakeRenderer) => boolean = () => false;
    /** Whether prepareStockProgram throws, for this renderer and process version. */
    static stockFails: (version: number, renderer: FakeRenderer) => boolean = () => false;
    /** Thrown by render, for a failure that isn't a program build. */
    static renderError: Error | null = null;
    /** What a failed prepareProgram throws: the real renderer rethrows one remembered object. */
    static buildError = new Error("no program");

    prepared: number[] = [];
    stockPrepared: number[] = [];
    disposed = false;

    constructor() {
      FakeRenderer.instances.push(this);
    }

    prepareProgram(version: number) {
      this.prepared.push(version);
      if (FakeRenderer.prepareFails(version, this)) throw FakeRenderer.buildError;
    }

    prepareStockProgram(version: number) {
      this.stockPrepared.push(version);
      if (FakeRenderer.stockFails(version, this)) {
        throw new Error(`no stock program for ${version}`);
      }
    }

    setAsShotTemperature() {}
    setImage(...args: unknown[]) {
      FakeRenderer.setImageCalls.push(args);
    }

    render() {
      if (FakeRenderer.renderError) throw FakeRenderer.renderError;
    }

    dispose() {
      this.disposed = true;
    }
  }

  class FakeCanvas {
    /** Whether getContext reports the context lost; new canvases take it from `lostAtStart`. */
    lost = false;
    private listeners = new Map<string, () => void>();

    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, listener);
    }

    getContext() {
      return { isContextLost: () => this.lost };
    }

    fire(type: string) {
      this.listeners.get(type)?.();
    }
  }

  function gate(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  return {
    FakeRenderer,
    FakeCanvas,
    gate,
    loads: [] as unknown[][],
    /** The next decodes wait on these, in order; with none left a decode goes straight through. */
    gates: [] as Promise<void>[],
    canvases: [] as InstanceType<typeof FakeCanvas>[],
    lostAtStart: { value: false },
    cached: {
      kind: "float16" as const,
      data: new Uint16Array(4 * 2 * 4),
      width: 4,
      height: 2,
    },
    histogram: { luma: new Uint32Array(256) },
  };
});

vi.mock("./webgl/renderer", () => ({ WebGLRenderer: h.FakeRenderer }));
vi.mock("@/catalog/load-image", () => ({
  loadPhotoImage: async (...args: unknown[]) => {
    h.loads.push(args);
    const gate = h.gates.shift();
    if (gate) await gate;
    return h.cached;
  },
}));
vi.mock("@/rendering/histogram", () => ({ computeHistogram: () => h.histogram }));
vi.mock("@/extensions/pipelines", () => ({ setPhotoParams: () => {} }));

function photo(): CatalogPhoto {
  return {
    id: "p1",
    filename: "DSCF0001.RAF",
    relPath: "DSCF0001.RAF",
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
    mimeType: "image/x-fuji-raf",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
  };
}

// The renderer and its dead-latch live in module state, so each test starts
// from a fresh copy of the module.
let renderPhotoHistogram: typeof import("./thumbnail-renderer").renderPhotoHistogram;

beforeEach(async () => {
  vi.resetModules();
  h.FakeRenderer.instances = [];
  h.FakeRenderer.setImageCalls = [];
  h.FakeRenderer.prepareFails = () => false;
  h.FakeRenderer.stockFails = () => false;
  h.FakeRenderer.renderError = null;
  h.FakeRenderer.buildError = new Error("no program");
  h.loads.length = 0;
  h.gates.length = 0;
  h.canvases.length = 0;
  h.lostAtStart.value = false;
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = new h.FakeCanvas();
      canvas.lost = h.lostAtStart.value;
      h.canvases.push(canvas);
      return canvas;
    },
  });
  ({ renderPhotoHistogram } = await import("./thumbnail-renderer"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renderPhotoHistogram without a loaded thumbnail", () => {
  it("caps a cached RAW source to the histogram edge", async () => {
    const result = await renderPhotoHistogram(photo(), normalizeParams({}));
    expect(result).toBe(h.histogram);
    expect(h.FakeRenderer.setImageCalls).toHaveLength(1);
    const [image, ...options] = h.FakeRenderer.setImageCalls[0];
    expect(image).toBe(h.cached);
    expect(options).toEqual([256, false, false, true]);
  });
});

describe("renderPhotoHistogram when the develop program can't be built", () => {
  const OLD = normalizeParams({ processVersion: LEGACY_PROCESS_VERSION });
  const NEW = normalizeParams({ processVersion: CURRENT_PROCESS_VERSION });
  const quietly = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("builds the program for the photo's version", async () => {
    await renderPhotoHistogram(photo(), OLD);
    const [renderer] = h.FakeRenderer.instances;
    expect(renderer.prepared.length).toBeGreaterThan(0);
    expect(new Set(renderer.prepared)).toEqual(new Set([LEGACY_PROCESS_VERSION]));
  });

  // Stages or a transform that can't be built fail photos, not the renderer: the stock
  // program builds, so this photo gets none, before any decode, and the next one gets
  // a histogram from the same renderer once its stage set works.
  it("gives a photo no histogram when its stages can't build, then the next one", async () => {
    const logged = quietly();
    h.FakeRenderer.prepareFails = () => true;
    expect(await renderPhotoHistogram(photo(), NEW)).toBeNull();
    expect(h.loads).toHaveLength(0);
    expect(h.FakeRenderer.instances).toHaveLength(1);
    expect(h.FakeRenderer.instances[0].stockPrepared).toEqual([CURRENT_PROCESS_VERSION]);
    expect(h.FakeRenderer.instances[0].disposed).toBe(false);
    expect(logged).toHaveBeenCalledTimes(1);

    h.FakeRenderer.prepareFails = () => false;
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    expect(h.FakeRenderer.instances).toHaveLength(1);
  });

  it("gives only the photos of a failing process version no histogram", async () => {
    quietly();
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);

    h.FakeRenderer.prepareFails = (version) => version === LEGACY_PROCESS_VERSION;
    expect(await renderPhotoHistogram(photo(), OLD)).toBeNull();
    expect(h.FakeRenderer.instances[0].stockPrepared).toEqual([LEGACY_PROCESS_VERSION]);
    expect(h.FakeRenderer.instances[0].disposed).toBe(false);

    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    expect(h.FakeRenderer.instances).toHaveLength(1);
  });

  it("reports a failure once however many photos meet it, and a different one again", async () => {
    const logged = quietly();
    h.FakeRenderer.prepareFails = () => true;
    for (let i = 0; i < 3; i++) await renderPhotoHistogram(photo(), NEW);
    expect(logged).toHaveBeenCalledTimes(1);

    h.FakeRenderer.buildError = new Error("another stage");
    await renderPhotoHistogram(photo(), NEW);
    expect(logged).toHaveBeenCalledTimes(2);
  });

  it("ends the histogram for the session when even the stock program can't be built", async () => {
    const logged = quietly();
    h.FakeRenderer.prepareFails = () => true;
    h.FakeRenderer.stockFails = () => true;
    expect(await renderPhotoHistogram(photo(), NEW)).toBeNull();
    expect(h.loads).toHaveLength(0);
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);

    // Latched: later photos don't create, build or decode anything.
    h.FakeRenderer.prepareFails = () => false;
    h.FakeRenderer.stockFails = () => false;
    expect(await renderPhotoHistogram(photo(), NEW)).toBeNull();
    expect(h.FakeRenderer.instances).toHaveLength(1);
    expect(h.loads).toHaveLength(0);
  });

  it("ends the histogram when a later photo's stock program can't be built", async () => {
    quietly();
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);

    h.FakeRenderer.prepareFails = () => true;
    h.FakeRenderer.stockFails = () => true;
    expect(await renderPhotoHistogram(photo(), OLD)).toBeNull();
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);

    h.FakeRenderer.prepareFails = () => false;
    h.FakeRenderer.stockFails = () => false;
    const decodes = h.loads.length;
    expect(await renderPhotoHistogram(photo(), NEW)).toBeNull();
    expect(h.FakeRenderer.instances).toHaveLength(1);
    expect(h.loads).toHaveLength(decodes);
  });

  // A lost context fails every compile, the stock program's too, and says nothing
  // about the machine: the lost-context listener drops it and the next call starts
  // afresh, as it always did.
  it("does not end the histogram for a context lost while building", async () => {
    quietly();
    h.lostAtStart.value = true;
    h.FakeRenderer.prepareFails = () => true;
    h.FakeRenderer.stockFails = () => true;
    expect(await renderPhotoHistogram(photo(), NEW)).toBeNull();
    expect(h.FakeRenderer.instances[0].disposed).toBe(false);

    h.canvases[0].fire("webglcontextlost");
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);

    h.lostAtStart.value = false;
    h.FakeRenderer.prepareFails = () => false;
    h.FakeRenderer.stockFails = () => false;
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    expect(h.FakeRenderer.instances).toHaveLength(2);
  });

  // Calls aren't serialized: one can be decoding when its context is lost and a
  // newer call has made a fresh one. Whatever the first then meets must not touch
  // the fresh context.
  it("leaves a newer context alone when a replaced one's build fails", async () => {
    quietly();
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    const [replaced] = h.FakeRenderer.instances;

    const decoding = h.gate();
    h.gates.push(decoding.promise);
    const stale = renderPhotoHistogram(photo(), NEW);

    h.canvases[0].fire("webglcontextlost");
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    const fresh = h.FakeRenderer.instances[1];
    expect(fresh).not.toBe(replaced);

    h.FakeRenderer.prepareFails = (_version, renderer) => renderer === replaced;
    h.FakeRenderer.stockFails = (_version, renderer) => renderer === replaced;
    decoding.open();
    expect(await stale).toBeNull();
    expect(fresh.disposed).toBe(false);

    h.FakeRenderer.prepareFails = () => false;
    h.FakeRenderer.stockFails = () => false;
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    expect(h.FakeRenderer.instances).toHaveLength(2);
  });

  // The lost-context listener belongs to its own context: a replaced one's event, late
  // as events can be, must not drop the context that replaced it.
  it("ignores a replaced context's late lost event", async () => {
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    h.canvases[0].fire("webglcontextlost");
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    const fresh = h.FakeRenderer.instances[1];

    h.canvases[0].fire("webglcontextlost");
    expect(fresh.disposed).toBe(false);
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    expect(h.FakeRenderer.instances).toHaveLength(2);
  });

  // Only a stock program that can't build ends the histogram: one photo whose frame
  // throws for another reason must not take it away from every other photo.
  it("lets any other render failure reject, and keeps the histogram going", async () => {
    h.FakeRenderer.renderError = new Error("bad mask");
    await expect(renderPhotoHistogram(photo(), NEW)).rejects.toThrow("bad mask");

    h.FakeRenderer.renderError = null;
    expect(await renderPhotoHistogram(photo(), NEW)).toBe(h.histogram);
    expect(h.FakeRenderer.instances).toHaveLength(1);
    expect(h.FakeRenderer.instances[0].disposed).toBe(false);
  });
});
