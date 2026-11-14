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
import { denoiseBag } from "./webgl/builtin-denoise";

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
    /** What prepareProgramAsync resolves with: the driver's build finishing. None is done at once. */
    static driverBuild: Promise<void> | null = null;

    /** Each prepareProgramAsync call's version. */
    builtAsync: number[] = [];
    prepared: number[] = [];
    stockPrepared: number[] = [];
    disposed = false;
    /** Each setContributedParams call's bag. */
    contributed: Record<string, unknown>[] = [];

    readonly opts: { confirmedDraws?: readonly string[] };

    constructor(_canvas: unknown, opts: FakeRenderer["opts"] = {}) {
      this.opts = opts;
      FakeRenderer.instances.push(this);
    }

    prepareProgramAsync(version: number): Promise<void> {
      this.builtAsync.push(version);
      return FakeRenderer.driverBuild ?? Promise.resolve();
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
    setContributedParams(bag: Record<string, unknown>) {
      this.contributed.push(bag);
    }
    setImage(...args: unknown[]) {
      FakeRenderer.setImageCalls.push(args);
    }

    /** The stage textures it was handed, by reference as the histogram hands them. */
    stageTextures: Record<string, unknown> = {};
    /** The stage texture keys it held at each draw. */
    drawnTextures: string[][] = [];
    setStageTextures(bag: Record<string, unknown>) {
      this.stageTextures = bag;
    }

    render() {
      this.drawnTextures.push(Object.keys(this.stageTextures));
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
    /** The live stage-texture bag, as getStageTextures hands it out. */
    stageTextures: {} as Record<string, unknown>,
    /** needStageVariants: what a frame of a bag waits for, or null for nothing. */
    needVariants: (_bag: Record<string, unknown>): Promise<{ failure: string | null; release(): void }> | null => null,
  };
});

vi.mock("./webgl/renderer", () => ({ WebGLRenderer: h.FakeRenderer }));
vi.mock("./render-bridge", () => ({
  getStageTextures: () => h.stageTextures,
  needStageVariants: (bag: Record<string, unknown>) => h.needVariants(bag),
}));
vi.mock("@/catalog/load-image", () => ({
  loadPhotoImage: async (...args: unknown[]) => {
    h.loads.push(args);
    const gate = h.gates.shift();
    if (gate) await gate;
    return h.cached;
  },
}));
vi.mock("@/rendering/histogram", () => ({ computeHistogram: () => h.histogram }));
vi.mock("@/extensions/pipelines", () => ({
  setPhotoParams: () => {},
  resolvePipelineFor: (displayTransform: string | null) => `pipeline:${displayTransform}`,
}));
// Only the "t.x" transform derives anything, so the other photos' bags stay as they are.
vi.mock("@/extensions/transform-derive", () => ({
  bagForRender: (pipeline: string, bag: Record<string, unknown>) =>
    pipeline === "pipeline:t.x" ? { ...bag, [`derived:${pipeline}`]: true } : bag,
}));

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
  h.FakeRenderer.driverBuild = null;
  h.loads.length = 0;
  h.gates.length = 0;
  h.canvases.length = 0;
  h.lostAtStart.value = false;
  h.stageTextures = {};
  h.needVariants = () => null;
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
    expect(options).toEqual([256, false, true]);
  });

  it("loads a library source's photo as background work, which never fetches its original", async () => {
    const sources = await import("@/project/library-sources");
    sources.registerLibrarySource("ext.a", {
      id: "test.server",
      name: "Server",
      list: async () => ({ items: [{ key: "k", name: "DSCF0001.RAF" }] }),
      readPreview: async () => new Blob(),
      readOriginal: async () => new Blob(),
    });
    try {
      const root = sources.sourceRoot("test.server")!;
      const fileHandle = await root.getFileHandle("DSCF0001.RAF");
      await renderPhotoHistogram({ ...photo(), fileHandle }, normalizeParams({}));
      expect(h.loads).toHaveLength(1);
      expect(h.loads[0][1]).toEqual({ background: true });
    } finally {
      sources.dropLibrarySources("ext.a");
    }
  });

  it("loads a photo on disk as before", async () => {
    await renderPhotoHistogram(photo(), normalizeParams({}));
    expect(h.loads[0][1]).toBeUndefined();
  });
});

// The histogram draws the saved edit as Develop does: the photo's own stage bag
// under the built-in denoiser's entries, which come from the Detail panel's
// params, with its transform's derived uniforms.
describe("renderPhotoHistogram's renderer", () => {
  it("doesn't wait on the stage draws that finished on this machine before", async () => {
    const { registerProcessingStage } = await import("@/extensions/registry");
    const guard = await import("./gpu-crash-guard");
    const film = { id: "acme.film", name: "Film", phase: "effects" as const, glsl: "c = c;", uniforms: [] };
    registerProcessingStage("acme", film);
    const key = guard.stageKey(film);
    guard.noteDrawEnded([key], "a11d3", true);
    await renderPhotoHistogram(photo(), normalizeParams({}));
    expect(h.FakeRenderer.instances[0].opts.confirmedDraws).toContain(`${key}|a11d3`);
  });
});

// A stage that samples a texture draws black without it; one made on demand is
// had before the frame, as an export's is.
describe("renderPhotoHistogram's stage textures", () => {
  it("draws with the stage textures, once the variants the photo's bag names are held, then lets go", async () => {
    h.stageTextures = { "lut.stage.lut": { width: 1 } };
    const events: string[] = [];
    h.needVariants = (bag) =>
      bag["acme.calib.table"] === "v1"
        ? new Promise((done) =>
            setTimeout(() => {
              h.stageTextures["acme.calib.table#v1"] = { width: 1 };
              done({ failure: null, release: () => events.push("released") });
            }),
          )
        : null;
    expect(await renderPhotoHistogram(photo(), normalizeParams({}), { "acme.calib.table": "v1" })).toBe(h.histogram);
    expect(h.FakeRenderer.instances[0].drawnTextures).toEqual([["lut.stage.lut", "acme.calib.table#v1"]]);
    expect(events).toEqual(["released"]);
  });

  it("gives no histogram when a variant the photo's bag names can't be had", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const release = vi.fn();
    h.needVariants = async () => ({ failure: "Calibration couldn't make what this photo needs", release });
    expect(await renderPhotoHistogram(photo(), normalizeParams({}), { "acme.calib.table": "v1" })).toBeNull();
    expect(h.FakeRenderer.instances[0]?.drawnTextures ?? []).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("renderPhotoHistogram's stage bag", () => {
  const NR = normalizeParams({ processVersion: CURRENT_PROCESS_VERSION, luminanceNR: 40, colorNR: 0 });

  it("draws the photo's own bag with the built-in denoiser's entries", async () => {
    await renderPhotoHistogram(photo(), NR, { "own.stage.x": 1 });
    const [bag] = h.FakeRenderer.instances[0].contributed;
    expect(bag).toMatchObject({ "own.stage.x": 1, "builtin.denoise.lumAmount": 40 });
    expect(bag).not.toHaveProperty("builtin.denoise.colAmount");
  });

  it("draws the denoiser's entries for a photo with no bag of its own", async () => {
    await renderPhotoHistogram(photo(), NR);
    expect(h.FakeRenderer.instances[0].contributed).toEqual([denoiseBag(NR)]);
  });

  it("adds the derived uniforms of the photo's transform", async () => {
    await renderPhotoHistogram(photo(), { ...NR, displayTransform: "t.x" }, { "own.stage.x": 1 });
    expect(h.FakeRenderer.instances[0].contributed).toEqual([
      { "own.stage.x": 1, ...denoiseBag(NR), "derived:pipeline:t.x": true },
    ]);
  });

  // The renderer is shared: one photo's bag must not linger into the next.
  it("replaces the previous photo's bag", async () => {
    await renderPhotoHistogram(photo(), NR, { "own.stage.x": 1 });
    await renderPhotoHistogram(photo(), { ...NR, luminanceNR: 0 }, {});
    expect(h.FakeRenderer.instances[0].contributed.at(-1)).toEqual({});
  });
});

// Built at the first frame, on the window's thread, the program held the Library
// still for up to a second on the first selection and after every extension change.
describe("renderPhotoHistogram's develop program", () => {
  it("is built by the driver before any build on this thread, decode or draw", async () => {
    const driver = h.gate();
    h.FakeRenderer.driverBuild = driver.promise;
    const histogram = renderPhotoHistogram(photo(), normalizeParams({ processVersion: LEGACY_PROCESS_VERSION }));
    const [renderer] = h.FakeRenderer.instances;
    expect(renderer.builtAsync).toEqual([LEGACY_PROCESS_VERSION]);
    expect(renderer.prepared).toEqual([]);
    expect(h.loads).toHaveLength(0);

    driver.open();
    expect(await histogram).toBe(h.histogram);
    expect(new Set(renderer.prepared)).toEqual(new Set([LEGACY_PROCESS_VERSION]));
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
