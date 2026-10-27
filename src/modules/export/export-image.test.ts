// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A batch shares one renderer, which builds its develop program on the first
// frame it draws. The batch builds the first photo's program before decoding
// anything. A stock program the driver can't build fails the whole batch up front,
// as a renderer that couldn't be created does, instead of decoding every photo
// only to fail each at its frame. Stages or a display transform that can't be built
// are logged and the photos fail one by one, as they always did. The renderer is
// faked: what it does with a program is covered on a real GL context by
// renderer.webgl.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImage } from "@/catalog/load-image";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION, normalizeParams } from "@/catalog/types";
import type { ExportFrame } from "@/extensions/types";
import { buildIccProfile, type ColorSpaceId } from "@/rendering/color-space";
import type { ExportPixels, ExportPixelsOptions, ExportTarget, Sharpen } from "@/rendering/webgl/export-draw";

const h = vi.hoisted(() => {
  /** What happened, in order: "prepare:<version>", "stock:<version>", "decode:<photo id>". */
  const events: string[] = [];
  /** The codes every version 3 16-bit export draws: 2×1, RGBA. */
  const exportCodes = new Uint16Array([1, 2, 3, 65535, 40000, 50000, 65535, 65535]);
  class FakeRenderer {
    static instances: FakeRenderer[] = [];
    static prepareError: Error | null = null;
    static stockError: Error | null = null;
    static texturesError: Error | null = null;
    /** The newest version the renderer draws; a photo past it renders as it. */
    static newestVersion = 3;
    /** The targets the next exportPixels calls land in, in turn: "float32" once
     *  they run out, and null for none the device can render. */
    static exportTargets: (ExportTarget | null)[] = [];
    /** Whether renderSharpened finds a float target. */
    static gpuSharpens = true;
    /** What captureFloatFrame reads back: null without a float target. */
    static floatCapture: { data: Float32Array; width: number; height: number } | null = null;

    pipeline: unknown = null;
    /** Each prepareProgram call: its version, and the pipeline the renderer held. */
    prepared: { version: number; pipeline: unknown }[] = [];
    disposed = false;
    /** Each setContributedParams call's bag. */
    contributed: Record<string, unknown>[] = [];
    maxTextureEdge = 16384;
    /** The frames drawn, in order: "render", "renderSharpened", "exportPixels", "captureFloatFrame". */
    draws: string[] = [];
    /** Each exportPixels call's options. */
    exportOptions: ExportPixelsOptions[] = [];
    /** Each renderSharpened call's sharpening. */
    gpuSharpened: Sharpen[] = [];

    constructor() {
      FakeRenderer.instances.push(this);
    }

    setActivePipeline(pipeline: unknown) {
      this.pipeline = pipeline;
    }

    prepareProgram(version: number) {
      this.prepared.push({ version, pipeline: this.pipeline });
      events.push(`prepare:${version}`);
      if (FakeRenderer.prepareError) throw FakeRenderer.prepareError;
    }

    prepareStockProgram(version: number) {
      events.push(`stock:${version}`);
      if (FakeRenderer.stockError) throw FakeRenderer.stockError;
    }

    setStageTextures() {
      if (FakeRenderer.texturesError) throw FakeRenderer.texturesError;
    }
    setOutputColorSpace() {}
    setAsShotTemperature() {}
    setHslStyle() {}
    setContributedParams(bag: Record<string, unknown>) {
      this.contributed.push(bag);
    }
    setImage() {
      events.push("setImage");
    }
    signedOutputFor(params: DevelopParams): boolean {
      return Math.min(params.processVersion, FakeRenderer.newestVersion) >= 3;
    }
    render() {
      this.draws.push("render");
    }
    renderSharpened(sharpen: Sharpen): boolean {
      this.draws.push("renderSharpened");
      this.gpuSharpened.push(sharpen);
      return FakeRenderer.gpuSharpens;
    }
    exportPixels(opts: ExportPixelsOptions = {}): ExportPixels | null {
      this.draws.push("exportPixels");
      this.exportOptions.push(opts);
      const next = FakeRenderer.exportTargets.shift();
      const target = next === undefined ? "float32" : next;
      return target && { data: exportCodes.slice(), width: 2, height: 1, target };
    }
    captureFloatFrame() {
      this.draws.push("captureFloatFrame");
      return FakeRenderer.floatCapture;
    }

    dispose() {
      this.disposed = true;
    }
  }
  return {
    FakeRenderer,
    events,
    /** The 8-bit encode steps, in order: "canvasToBlob:<type>", "embedColorProfile". */
    encodes: [] as string[],
    /** What getSettings returns: the persisted Preferences. */
    settings: {} as Record<string, unknown>,
    /** Each CPU output-sharpening pass. */
    cpuSharpened: [] as Sharpen[],
    /** The saved edit a photo id loads, or undefined to make the read fail. */
    edits: new Map<string, DevelopParams>(),
    /** What loading a photo id decodes to; none decodes to null. */
    decoded: new Map<string, DecodedImage>(),
    /** The stage params a photo id's saved edit carries. */
    bags: new Map<string, Record<string, unknown>>(),
    /** Registered export processors, by id. */
    processors: {} as Record<
      string,
      {
        id: string;
        order: number;
        settings?: unknown[];
        process?: (
          b: Blob,
          p: CatalogPhoto,
          s: Record<string, unknown>,
          context: { longEdge: number | null },
        ) => Promise<Blob>;
        processPixels?: (
          frame: ExportFrame,
          p: CatalogPhoto,
          s: Record<string, unknown>,
          context: { longEdge: number | null },
        ) => Promise<ExportFrame | void>;
      }
    >,
  };
});

vi.mock("@/rendering/webgl/renderer", () => ({ WebGLRenderer: h.FakeRenderer }));
vi.mock("@/rendering/render-bridge", () => ({ getStageTextures: () => ({}) }));
vi.mock("@/catalog/load-image", () => ({
  loadPhotoImage: async (photo: CatalogPhoto) => {
    h.events.push(`decode:${photo.id}`);
    return h.decoded.get(photo.id) ?? null;
  },
}));
vi.mock("@/catalog/edit-params", () => ({
  loadSavedEdit: async (id: string) => {
    const params = h.edits.get(id);
    if (!params) throw new Error(`no edit for ${id}`);
    return { params, paramBag: h.bags.get(id) ?? {} };
  },
}));
vi.mock("@/extensions/pipelines", () => ({
  resolveDefaultPipeline: () => "default-pipeline",
  resolvePipelineFor: (displayTransform: string | null) => `pipeline:${displayTransform}`,
  setPhotoParams: () => {},
}));
// Only the "t.x" transform derives anything, so the other photos' bags stay as they are.
vi.mock("@/extensions/transform-derive", () => ({
  bagForRender: (pipeline: string, bag: Record<string, unknown>) =>
    pipeline === "pipeline:t.x" ? { ...bag, [`derived:${pipeline}`]: true } : bag,
}));
vi.mock("@/extensions/registry", () => ({
  useRegistry: {
    getState: () => ({
      processingStages: {},
      exportProcessors: h.processors,
      filenameTemplates: {},
    }),
  },
}));
vi.mock("@/extensions/ext-settings", () => ({ getExtSetting: () => 100 }));
vi.mock("@/state/settings-store", () => ({ getSettings: () => h.settings }));
vi.mock("@/rendering/color-space", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/rendering/color-space")>();
  return {
    ...actual,
    embedColorProfile: (blob: Blob, id: ColorSpaceId) => {
      h.encodes.push("embedColorProfile");
      return actual.embedColorProfile(blob, id);
    },
  };
});
vi.mock("./sharpen", () => ({
  applyOutputSharpening: (source: HTMLCanvasElement, amount: number, radius: number) => {
    h.cpuSharpened.push({ amount, radius });
    return source;
  },
}));

import {
  exportPhotos,
  exportStatus,
  getDefaultExportSettings,
  proPhotoAt8Bit,
  renderPhotosToBlobs,
  type ExportResult,
  type ExportSettings,
  type RenderPhotosOptions,
} from "./export-image";

const SETTINGS: ExportSettings = {
  format: "image/jpeg",
  quality: 0.9,
  longEdge: null,
  bundle: false,
  delivery: "files",
};

// An edit with no version predates versions and reads as version 1, so say which.
const CURRENT = normalizeParams({ processVersion: CURRENT_PROCESS_VERSION });
const OLD_PICK = normalizeParams({
  processVersion: LEGACY_PROCESS_VERSION,
  displayTransform: "pick",
});

function photo(id: string): CatalogPhoto {
  return {
    id,
    filename: `${id}.RAF`,
    relPath: `${id}.RAF`,
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

beforeEach(() => {
  h.FakeRenderer.instances = [];
  h.FakeRenderer.prepareError = null;
  h.FakeRenderer.stockError = null;
  h.FakeRenderer.texturesError = null;
  h.FakeRenderer.newestVersion = 3;
  h.FakeRenderer.exportTargets = [];
  h.FakeRenderer.gpuSharpens = true;
  h.FakeRenderer.floatCapture = { data: new Float32Array(8).fill(0.5), width: 2, height: 1 };
  h.cpuSharpened.length = 0;
  h.events.length = 0;
  h.encodes.length = 0;
  h.settings = {};
  h.edits.clear();
  h.decoded.clear();
  h.bags.clear();
  for (const id of Object.keys(h.processors)) delete h.processors[id];
  vi.stubGlobal("document", { createElement: () => ({}) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A driver that can't build the stock program can't build anything on it either. */
function driverFails(error: Error) {
  h.FakeRenderer.prepareError = error;
  h.FakeRenderer.stockError = error;
}

describe("a batch's develop program", () => {
  it("is built for the first photo's version and transform before any decode", async () => {
    h.edits.set("a", OLD_PICK);
    h.edits.set("b", CURRENT);
    await renderPhotosToBlobs([photo("a"), photo("b")], SETTINGS);

    const [renderer] = h.FakeRenderer.instances;
    expect(renderer.prepared).toEqual([
      { version: LEGACY_PROCESS_VERSION, pipeline: "pipeline:pick" },
    ]);
    expect(h.events).toEqual([`prepare:${LEGACY_PROCESS_VERSION}`, "decode:a", "decode:b"]);
    expect(renderer.disposed).toBe(true);
  });

  it("fails a rendered batch up front, undecoded, when the stock program can't build", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.edits.set("a", CURRENT);
    h.edits.set("b", CURRENT);
    driverFails(new Error("Shader compile failed: boom"));
    const progress = vi.fn();
    const out = await renderPhotosToBlobs([photo("a"), photo("b")], SETTINGS, progress);

    expect(out.map((r) => r.blob)).toEqual([null, null]);
    expect(h.events).toEqual([
      `prepare:${CURRENT_PROCESS_VERSION}`,
      `stock:${CURRENT_PROCESS_VERSION}`,
    ]);
    expect(progress).not.toHaveBeenCalled();
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0].join(" ")).toContain("Shader compile failed: boom");
  });

  it("fails an exported batch up front, undecoded, when the stock program can't", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.edits.set("a", CURRENT);
    h.edits.set("b", CURRENT);
    driverFails(new Error("Shader compile failed: boom"));
    const progress = vi.fn();
    const result = await exportPhotos([photo("a"), photo("b")], SETTINGS, progress);

    expect(result).toEqual({
      exported: 0,
      failed: ["a.RAF", "b.RAF"],
      degradedTo8Bit: 0,
      reducedPrecision: 0,
    });
    expect(h.events).toEqual([
      `prepare:${CURRENT_PROCESS_VERSION}`,
      `stock:${CURRENT_PROCESS_VERSION}`,
    ]);
    expect(progress).not.toHaveBeenCalled();
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);
  });

  // Stages or a transform that can't be built are no reason to refuse the batch: the
  // stock program builds, the reason is logged once, and each photo fails (or not,
  // if its edit doesn't use them) at its own frame, as it always did.
  it("goes on photo by photo, logging once, when only the stages can't build", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.edits.set("a", CURRENT);
    h.edits.set("b", CURRENT);
    h.FakeRenderer.prepareError = new Error("Shader compile failed: stages");
    const progress = vi.fn();
    await renderPhotosToBlobs([photo("a"), photo("b")], SETTINGS, progress);

    expect(h.events).toEqual([
      `prepare:${CURRENT_PROCESS_VERSION}`,
      `stock:${CURRENT_PROCESS_VERSION}`,
      "decode:a",
      "decode:b",
    ]);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0].join(" ")).toContain("Shader compile failed: stages");
  });

  it("is not built for an empty batch", async () => {
    expect(await renderPhotosToBlobs([], SETTINGS)).toEqual([]);
    expect(h.FakeRenderer.instances[0].prepared).toEqual([]);
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);
  });

  // An unreadable edit fails its own photo when that photo is rendered; it is not
  // a reason to stop the rest of the batch.
  it("is skipped, and the batch goes on, when the first photo's edit is unreadable", async () => {
    h.edits.set("b", CURRENT);
    const progress = vi.fn();
    const out = await renderPhotosToBlobs([photo("a"), photo("b")], SETTINGS, progress);

    expect(h.FakeRenderer.instances[0].prepared).toEqual([]);
    expect(out.map((r) => r.blob)).toEqual([null, null]);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(h.events).toEqual(["decode:b"]);
  });
});

describe("a photo whose original can't be read", () => {
  // Its stored preview already shows its edit: rendered again, the edit would apply twice.
  function editedPreviewOnly(id: string): ReturnType<typeof vi.fn> {
    const close = vi.fn();
    const bitmap = { width: 768, height: 512, close } as unknown as ImageBitmap;
    h.decoded.set(id, {
      kind: "bitmap",
      bitmap,
      fallback: { from: "stored-edited", offline: true, unsupported: false, timedOut: false },
    });
    return close;
  }

  it("fails its export, saying the original isn't available, with nothing rendered", async () => {
    h.edits.set("a", CURRENT);
    const close = editedPreviewOnly("a");

    const result = await exportPhotos([photo("a")], SETTINGS);

    expect(result).toMatchObject({
      exported: 0,
      failed: ["a.RAF"],
      failures: [{ filename: "a.RAF", reason: "The original isn't available." }],
    });
    expect(h.events).not.toContain("setImage");
    expect(close).toHaveBeenCalled();
  });

  it("renders nothing for it in a batch rendered to blobs", async () => {
    h.edits.set("a", CURRENT);
    editedPreviewOnly("a");

    const out = await renderPhotosToBlobs([photo("a")], SETTINGS);

    expect(out.map((r) => r.blob)).toEqual([null]);
    expect(h.events).not.toContain("setImage");
  });
});

// What a headless render takes beyond the export settings, and what a batch
// leaves behind: a stage-param patch merged over each photo's own, no export
// processors for a render of the same photo that one of its processors started
// (they would run again, the caller included, without end) while other batches
// still run theirs, and no WebGL context once it ends.
describe("a rendered batch", () => {
  const lose = vi.fn();
  const written: string[] = [];
  const canvas = {
    width: 600,
    height: 400,
    toBlob: (done: BlobCallback) => done(new Blob(["jpeg"], { type: "image/jpeg" })),
    getContext: () => ({
      getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext: lose } : null),
    }),
  };
  const folder = {
    getFileHandle: async (name: string) => {
      written.push(name);
      return { createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) };
    },
  } as unknown as FileSystemDirectoryHandle;
  const FOLDER: ExportSettings = { ...SETTINGS, delivery: "folder" };

  beforeEach(() => {
    lose.mockClear();
    written.length = 0;
    vi.stubGlobal("document", { createElement: () => canvas });
    h.edits.set("a", CURRENT);
    h.decoded.set("a", { kind: "bitmap", bitmap: { width: 600, height: 400, close: () => undefined } as unknown as ImageBitmap });
    h.bags.set("a", { "own.stage.x": 1, "own.stage.mode": 0 });
  });

  it("merges a stage-param patch over each photo's own", async () => {
    const [out] = await renderPhotosToBlobs([photo("a")], SETTINGS, undefined, { paramBag: { "own.stage.mode": 1 } });
    expect(out.blob).not.toBeNull();
    expect(h.FakeRenderer.instances[0].contributed).toEqual([{ "own.stage.x": 1, "own.stage.mode": 1 }]);
  });

  it("renders a photo's own params without a patch", async () => {
    await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(h.FakeRenderer.instances[0].contributed).toEqual([{ "own.stage.x": 1, "own.stage.mode": 0 }]);
  });

  it("adds the derived uniforms of the photo's transform to the bag it renders with", async () => {
    h.edits.set("a", { ...CURRENT, displayTransform: "t.x" });
    await renderPhotosToBlobs([photo("a")], SETTINGS, undefined, { paramBag: { "own.stage.mode": 1 } });
    expect(h.FakeRenderer.instances[0].contributed).toEqual([
      { "own.stage.x": 1, "own.stage.mode": 1, "derived:pipeline:t.x": true },
    ]);
  });

  it("runs no processors for a render a processor started", async () => {
    let calls = 0;
    h.processors.nest = {
      id: "nest",
      order: 0,
      process: async (blob, p) => {
        calls++;
        if (calls > 3) throw new Error("processors recursed");
        await renderPhotosToBlobs([p], SETTINGS, undefined, { paramBag: { "own.stage.mode": 1 } });
        return blob;
      },
    };
    const [out] = await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(calls).toBe(1);
    expect(out.blob).not.toBeNull();
  });

  // A gallery publish beside a user export: one batch waits inside a processor
  // while another renders other photos, and that one's processors still run.
  it("runs its processors while another batch is inside its own", async () => {
    h.edits.set("b", CURRENT);
    h.decoded.set("b", { kind: "bitmap", bitmap: { width: 600, height: 400, close: () => undefined } as unknown as ImageBitmap });
    let entered!: () => void;
    const aIsInside = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.processors.mark = {
      id: "mark",
      order: 0,
      process: async (_blob, p) => {
        if (p.id === "a") {
          entered();
          await gate;
        }
        return new Blob([`done:${p.id}`]);
      },
    };

    const first = renderPhotosToBlobs([photo("a")], SETTINGS);
    await aIsInside;
    const [second] = await renderPhotosToBlobs([photo("b")], SETTINGS);
    release();
    const [firstOut] = await first;

    expect(await second.blob?.text()).toBe("done:b");
    expect(await firstOut.blob?.text()).toBe("done:a");
  });

  it("runs a processor again for a photo after the processor threw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    h.processors.flaky = {
      id: "flaky",
      order: 0,
      process: async (blob) => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return blob;
      },
    };
    await renderPhotosToBlobs([photo("a")], SETTINGS);
    await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(calls).toBe(2);
  });

  it("runs processors for a photo again after they failed to start", async () => {
    h.processors.broken = {
      id: "broken",
      order: 0,
      settings: {} as unknown as unknown[],
      process: async (blob) => blob,
    };
    const [failed] = await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(failed.blob).toBeNull();

    delete h.processors.broken;
    let calls = 0;
    h.processors.ok = {
      id: "ok",
      order: 0,
      process: async (blob) => {
        calls++;
        return blob;
      },
    };
    await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(calls).toBe(1);
  });

  it("renders with its own params when a JS caller passes null options", async () => {
    const [out] = await renderPhotosToBlobs(
      [photo("a")],
      SETTINGS,
      undefined,
      null as unknown as RenderPhotosOptions,
    );
    expect(out.blob).not.toBeNull();
    expect(h.FakeRenderer.instances[0].contributed).toEqual([{ "own.stage.x": 1, "own.stage.mode": 0 }]);
  });

  it("frees its WebGL context when it ends", async () => {
    await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(lose).toHaveBeenCalledTimes(1);
    await exportPhotos([photo("a")], FOLDER, undefined, folder);
    expect(lose).toHaveBeenCalledTimes(2);
  });

  it("frees its WebGL context when no program can be built", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    driverFails(new Error("Shader compile failed: boom"));
    const [out] = await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(out.blob).toBeNull();
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);
    expect(lose).toHaveBeenCalledTimes(1);
  });

  it("frees its WebGL context when the renderer can't take its stage textures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.FakeRenderer.texturesError = new Error("texture upload failed");
    const [out] = await renderPhotosToBlobs([photo("a")], SETTINGS);
    expect(out.blob).toBeNull();
    expect(h.FakeRenderer.instances[0].disposed).toBe(true);
    expect(lose).toHaveBeenCalledTimes(1);
  });

  it("tells a processor the export's long-edge setting", async () => {
    const seen: unknown[] = [];
    h.processors.watch = {
      id: "watch",
      order: 0,
      process: async (blob, _photo, _settings, context) => {
        seen.push(context);
        return blob;
      },
    };
    await renderPhotosToBlobs([photo("a")], { ...SETTINGS, longEdge: 1500 });
    await renderPhotosToBlobs([photo("a")], { ...SETTINGS, longEdge: null });
    expect(seen).toEqual([{ longEdge: 1500 }, { longEdge: null }]);
  });

  it("names a file by the type a processor turned it into", async () => {
    h.processors.avif = {
      id: "avif",
      order: 0,
      process: async () => new Blob(["avif"], { type: "image/avif" }),
    };
    await exportPhotos([photo("a")], FOLDER, undefined, folder);
    expect(written).toEqual(["a.avif"]);
  });
});

// A 16-bit TIFF's RGB samples, read from the pixel strip that ends the file.
async function tiffSamples(blob: Blob | null, width: number, height: number): Promise<number[]> {
  if (!blob) throw new Error("no TIFF was rendered");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const strip = new DataView(bytes.buffer, bytes.length - width * height * 6);
  return Array.from({ length: width * height * 3 }, (_, i) => strip.getUint16(i * 2, true));
}

// A PNG's chunk types in order, IHDR's bit depth, and the samples of a
// one-row image (its only row is unfiltered), inflated from the IDAT.
async function pngContents(blob: Blob | null): Promise<{ chunks: string[]; bitDepth: number; samples: number[] }> {
  if (!blob) throw new Error("no PNG was rendered");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const chunks: string[] = [];
  let bitDepth = 0;
  let idat = new Uint8Array(0);
  for (let at = 8; at < bytes.length; at += 12 + view.getUint32(at)) {
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + view.getUint32(at));
    chunks.push(type);
    if (type === "IHDR") bitDepth = data[8];
    if (type === "IDAT") idat = data.slice();
  }
  const row = new Uint8Array(
    await new Response(new Blob([idat]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer(),
  );
  const rowView = new DataView(row.buffer, 1);
  const samples = Array.from({ length: (row.length - 1) / 2 }, (_, i) => rowView.getUint16(i * 2));
  return { chunks, bitDepth, samples };
}

// A version 3 photo exports through the renderer's own draws: its 16 bits from
// a true 16-bit target, sharpened there when asked, and an 8-bit export
// sharpened on the signed colour where the device can, on the canvas where it
// can't. Versions 1 and 2 take the path they always have, draw for draw. Which
// path a photo takes is the renderer's call, since its version cap can hold a
// version 3 edit to version 2.
describe("an export by process version", () => {
  const V2 = CURRENT;
  const V3 = normalizeParams({ processVersion: 3 });
  const JPEG: ExportSettings = { ...SETTINGS, delivery: "folder" };
  const TIFF16: ExportSettings = { ...JPEG, format: "image/tiff", tiffBitDepth: 16 };
  const SHARPENED = { sharpenAmount: 80, sharpenRadius: 2 };
  const canvas = {
    width: 2,
    height: 1,
    toBlob: (done: BlobCallback, type: string) => {
      h.encodes.push(`canvasToBlob:${type}`);
      done(new Blob(["8-bit"], { type }));
    },
    getContext: (kind: string) =>
      kind === "2d"
        ? {
            drawImage: () => undefined,
            getImageData: (_x: number, _y: number, w: number, rows: number) => ({
              data: new Uint8ClampedArray(w * rows * 4),
            }),
          }
        : null,
  };
  const folder = {
    getFileHandle: async () => ({
      createWritable: async () => ({ write: async () => undefined, close: async () => undefined }),
    }),
  } as unknown as FileSystemDirectoryHandle;

  beforeEach(() => {
    vi.stubGlobal("document", { createElement: () => canvas });
  });

  function photos(...edits: [id: string, params: DevelopParams][]): CatalogPhoto[] {
    return edits.map(([id, params]) => {
      h.edits.set(id, params);
      h.decoded.set(id, {
        kind: "bitmap",
        bitmap: { width: 2, height: 1, close: () => undefined } as unknown as ImageBitmap,
      });
      return photo(id);
    });
  }

  // Each export makes its own renderer.
  async function exportOne(params: DevelopParams, settings: ExportSettings) {
    const [out] = await renderPhotosToBlobs(photos(["p", params]), settings);
    const renderer = h.FakeRenderer.instances[h.FakeRenderer.instances.length - 1];
    return { blob: out.blob, renderer };
  }

  it("draws a version 3 photo's 16-bit TIFF into a 16-bit target, sharpened there when asked", async () => {
    const plain = await exportOne(V3, TIFF16);
    expect(plain.renderer.draws).toEqual(["exportPixels"]);
    expect(plain.renderer.exportOptions).toEqual([{}]);
    expect(await tiffSamples(plain.blob, 2, 1)).toEqual([1, 2, 3, 40000, 50000, 65535]);

    const sharpened = await exportOne(V3, { ...TIFF16, ...SHARPENED });
    expect(sharpened.renderer.draws).toEqual(["exportPixels"]);
    expect(sharpened.renderer.exportOptions).toEqual([{ sharpen: { amount: 80, radius: 2 } }]);
    expect(h.cpuSharpened).toEqual([]);
  });

  it("sharpens a version 3 photo's 8-bit export on the GPU, and on the canvas where it can't", async () => {
    const gpu = await exportOne(V3, { ...JPEG, sharpenAmount: 50 });
    expect(gpu.blob).not.toBeNull();
    expect(gpu.renderer.draws).toEqual(["renderSharpened"]);
    expect(gpu.renderer.gpuSharpened).toEqual([{ amount: 50, radius: 1 }]);
    expect(h.cpuSharpened).toEqual([]);

    h.FakeRenderer.gpuSharpens = false;
    const cpu = await exportOne(V3, { ...JPEG, ...SHARPENED });
    expect(cpu.blob).not.toBeNull();
    expect(cpu.renderer.draws).toEqual(["renderSharpened", "render"]);
    expect(h.cpuSharpened).toEqual([{ amount: 80, radius: 2 }]);
  });

  it("renders a version 3 photo's unsharpened 8-bit export as before", async () => {
    const { blob, renderer } = await exportOne(V3, { ...JPEG, sharpenAmount: 0 });
    expect(blob).not.toBeNull();
    expect(renderer.draws).toEqual(["render"]);
    expect(h.cpuSharpened).toEqual([]);
  });

  // The 8-bit export after a refused 16-bit one still gets the GPU sharpening.
  it("sharpens a version 3 photo's 8-bit fallback on the GPU when its 16-bit frame is refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.FakeRenderer.exportTargets = [null];
    const { blob, renderer } = await exportOne(V3, { ...TIFF16, ...SHARPENED });
    expect(blob?.type).toBe("image/tiff");
    expect(renderer.draws).toEqual(["exportPixels", "renderSharpened"]);
    expect(h.cpuSharpened).toEqual([]);
  });

  it("exports a version 2 photo as it always has", async () => {
    const tiff = await exportOne(V2, { ...TIFF16, ...SHARPENED });
    expect(tiff.renderer.draws).toEqual(["captureFloatFrame"]);
    expect(h.cpuSharpened).toEqual([]);

    const jpeg = await exportOne(V2, { ...JPEG, ...SHARPENED });
    expect(jpeg.renderer.draws).toEqual(["render"]);
    expect(h.cpuSharpened).toEqual([{ amount: 80, radius: 2 }]);
  });

  it("exports a version 3 edit the renderer holds to version 2 as version 2", async () => {
    h.FakeRenderer.newestVersion = 2;
    expect((await exportOne(V3, TIFF16)).renderer.draws).toEqual(["captureFloatFrame"]);
    expect((await exportOne(V3, { ...JPEG, ...SHARPENED })).renderer.draws).toEqual(["render"]);
    expect(h.cpuSharpened).toEqual([{ amount: 80, radius: 2 }]);
  });

  it("quantises a version 2 photo's 16-bit capture as it always has", async () => {
    // RGB per pixel, alpha opaque: the range's ends, past both, and code midpoints.
    const rgb = [0, 1, -0.25, 1.5, 0.5, 0.25, 0.5 / 65535, 1.5 / 65535, 0.75, 1 - 0.5 / 65535, -0, 2 ** -20];
    const width = rgb.length / 3;
    const data = new Float32Array(width * 4).fill(1);
    rgb.forEach((v, i) => {
      data[i + Math.floor(i / 3)] = v;
    });
    h.FakeRenderer.floatCapture = { data, width, height: 1 };
    const before = (v: number) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535));

    const { blob } = await exportOne(V2, TIFF16);
    expect(await tiffSamples(blob, width, 1)).toEqual(rgb.map((_, i) => before(data[i + Math.floor(i / 3)])));
  });

  it("counts the photos that fell to 8-bit and those at reduced 16-bit precision", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // norm16 is a true 16-bit target (ANGLE's D3D11 lands there), never reduced.
    h.FakeRenderer.exportTargets = ["float16", null, "norm16"];
    h.FakeRenderer.floatCapture = null;
    const batch = photos(["half", V3], ["none", V3], ["noFloat", V2], ["norm", V3], ["full", V3]);
    const result = await exportPhotos(batch, TIFF16, undefined, folder);

    expect(result).toMatchObject({ exported: 5, failed: [], degradedTo8Bit: 2, reducedPrecision: 1 });
    expect(h.FakeRenderer.instances[0].draws).toEqual([
      "exportPixels",
      "exportPixels",
      "render",
      "captureFloatFrame",
      "render",
      "exportPixels",
      "exportPixels",
    ]);
    expect(warned.mock.calls.map((call) => call.join(" "))).toEqual([
      expect.stringMatching(/16-bit TIFF export requested.*"none\.RAF" exported as 8-bit/),
      expect.stringMatching(/16-bit TIFF export requested.*"noFloat\.RAF" exported as 8-bit/),
    ]);
  });

  // A 16-bit PNG is asked for on its own: the TIFF's depth, a Preference that
  // defaults to 16, says nothing about it, so a PNG nobody asked to be 16-bit
  // (a headless render with the default settings included) stays 8-bit.
  describe("as a PNG", () => {
    const PNG: ExportSettings = { ...JPEG, format: "image/png" };
    const PNG16: ExportSettings = { ...PNG, pngBitDepth: 16 };
    const PATH_8_BIT = ["canvasToBlob:image/png", "embedColorProfile"];

    it("draws a version 3 photo's 16-bit PNG into a 16-bit target, not the canvas", async () => {
      const { blob, renderer } = await exportOne(V3, PNG16);
      expect(renderer.draws).toEqual(["exportPixels"]);
      expect(renderer.exportOptions).toEqual([{}]);
      expect(h.encodes).toEqual([]);
      expect(await pngContents(blob)).toEqual({
        chunks: ["IHDR", "IDAT", "IEND"],
        bitDepth: 16,
        samples: [1, 2, 3, 40000, 50000, 65535],
      });
    });

    it("quantises a version 2 photo's 16-bit PNG from its float capture, as its TIFF is", async () => {
      const { blob, renderer } = await exportOne(V2, { ...PNG16, ...SHARPENED });
      expect(renderer.draws).toEqual(["captureFloatFrame"]);
      expect(h.encodes).toEqual([]);
      expect(h.cpuSharpened).toEqual([]);
      const png = await pngContents(blob);
      expect(png.bitDepth).toBe(16);
      expect(png.samples).toEqual(Array(6).fill(32768));
    });

    it("keeps an 8-bit PNG on the canvas path it has always taken", async () => {
      for (const settings of [PNG, { ...PNG, pngBitDepth: 8 as const }]) {
        for (const params of [V2, V3]) {
          h.encodes.length = 0;
          const { blob, renderer } = await exportOne(params, settings);
          expect(renderer.draws).toEqual(["render"]);
          expect(h.encodes).toEqual(PATH_8_BIT);
          expect(blob?.type).toBe("image/png");
        }
      }
    });

    // What Preferences hold, as the store's defaults have them: TIFF at 16, PNG at 8.
    const PREFERENCES = {
      exportFormat: "image/tiff",
      exportQuality: 90,
      exportLongEdge: null,
      exportColorSpace: "srgb",
      exportTiffBitDepth: 16,
      exportPngBitDepth: 8,
      exportIncludeMetadata: false,
      exportIncludeLocation: false,
    };

    it("keeps a headless render's PNG at 8 bits with the default settings, whose TIFF depth is 16", async () => {
      h.settings = PREFERENCES;
      const settings: ExportSettings = { ...getDefaultExportSettings(), format: "image/png" };
      expect(settings.tiffBitDepth).toBe(16);
      expect(settings.pngBitDepth).toBe(8);

      const { blob, renderer } = await exportOne(V3, settings);
      expect(renderer.draws).toEqual(["render"]);
      expect(h.encodes).toEqual(PATH_8_BIT);
      expect(blob?.type).toBe("image/png");
    });

    it("carries the PNG Preference into the default settings", async () => {
      for (const depth of [8, 16] as const) {
        h.settings = { ...PREFERENCES, exportPngBitDepth: depth };
        expect(getDefaultExportSettings().pngBitDepth).toBe(depth);
      }
    });

    it("draws a 16-bit PNG from default settings only once the Preference says 16", async () => {
      h.settings = { ...PREFERENCES, exportPngBitDepth: 16 };
      const settings: ExportSettings = { ...getDefaultExportSettings(), format: "image/png" };

      const { blob, renderer } = await exportOne(V3, settings);
      expect(renderer.draws).toEqual(["exportPixels"]);
      expect((await pngContents(blob)).bitDepth).toBe(16);
    });

    it("tags a 16-bit PNG with its space's profile and its EXIF ahead of the pixels", async () => {
      const { blob } = await exportOne(V3, { ...PNG16, colorSpace: "prophoto-rgb", includeMetadata: true });
      expect(h.encodes).toEqual([]);
      expect((await pngContents(blob)).chunks).toEqual(["IHDR", "iCCP", "eXIf", "IDAT", "IEND"]);
    });

    it("counts a 16-bit PNG that fell to 8-bit and one at reduced precision", async () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      h.FakeRenderer.exportTargets = [null, "float16"];
      h.FakeRenderer.floatCapture = null;
      const batch = photos(["none", V3], ["half", V3], ["noFloat", V2]);
      const result = await exportPhotos(batch, PNG16, undefined, folder);

      expect(result).toMatchObject({ exported: 3, failed: [], degradedTo8Bit: 2, reducedPrecision: 1 });
      expect(h.FakeRenderer.instances[0].draws).toEqual([
        "exportPixels",
        "render",
        "exportPixels",
        "captureFloatFrame",
        "render",
      ]);
      expect(h.encodes).toEqual([...PATH_8_BIT, ...PATH_8_BIT]);
      expect(warned.mock.calls.map((call) => call.join(" "))).toEqual([
        expect.stringMatching(/16-bit PNG export requested.*"none\.RAF" exported as 8-bit/),
        expect.stringMatching(/16-bit PNG export requested.*"noFloat\.RAF" exported as 8-bit/),
      ]);
    });
  });
});

// A TIFF's size, bit depth, embedded profile, Exif pixel dimensions and RGB
// samples, read from its directories.
async function readTiff(blob: Blob | null) {
  if (!blob) throw new Error("no TIFF was rendered");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const directory = (at: number) => {
    const tags = new Map<number, { count: number; value: number }>();
    for (let i = 0; i < view.getUint16(at, true); i++) {
      const entry = at + 2 + i * 12;
      tags.set(view.getUint16(entry, true), {
        count: view.getUint32(entry + 4, true),
        value: view.getUint32(entry + 8, true),
      });
    }
    return tags;
  };
  const ifd0 = directory(view.getUint32(4, true));
  const value = (tag: number) => ifd0.get(tag)?.value ?? 0;
  const bitDepth = view.getUint16(value(258), true);
  const icc = ifd0.get(34675);
  const exif = directory(value(0x8769));
  const strip = bytes.subarray(value(273), value(273) + value(279));
  const samples =
    bitDepth === 8
      ? Array.from(strip)
      : Array.from({ length: strip.length / 2 }, (_, i) => view.getUint16(value(273) + i * 2, true));
  return {
    width: value(256),
    height: value(257),
    bitDepth,
    icc: icc ? bytes.slice(icc.value, icc.value + icc.count) : null,
    exifSize: [exif.get(0xa002)?.value, exif.get(0xa003)?.value],
    samples,
  };
}

// A processor's pixel hook gets the export's pixels after mapping and
// sharpening, before quantisation and encode, as 16-bit codes at either depth,
// and what it hands back is what the file holds. An 8-bit export reads its
// canvas back for the hook only when a processor declares one.
describe("an export's pixel hooks", () => {
  const V2 = CURRENT;
  const V3 = normalizeParams({ processVersion: 3 });
  const JPEG: ExportSettings = { ...SETTINGS, delivery: "folder" };
  const TIFF8: ExportSettings = {
    ...JPEG,
    format: "image/tiff",
    tiffBitDepth: 8,
    colorSpace: "adobe-rgb",
    includeMetadata: true,
  };
  const TIFF16: ExportSettings = { ...TIFF8, tiffBitDepth: 16 };
  const PNG16: ExportSettings = { ...JPEG, format: "image/png", pngBitDepth: 16 };
  /** The codes the renderer's version 3 16-bit draw makes: 2×1, RGBA. */
  const CODES = [1, 2, 3, 65535, 40000, 50000, 65535, 65535];

  /** What the renderer's canvas shows once it has drawn the photo. */
  let drawn: { width: number; height: number; pixels: number[] };
  /** Each 2D-context call, in order, across the canvases an export makes. */
  const calls: string[] = [];
  /** The canvases an export makes, the renderer's own first. */
  const canvases: FakeCanvas[] = [];

  // A canvas whose 2D context reads and writes its own pixels, and whose
  // toBlob writes its size and pixels, so a test reads what an encode took.
  // An export's first canvas is the renderer's, showing the photo; any other
  // starts blank, as a new canvas does, so it holds only what was put on it.
  class FakeCanvas {
    width = canvases.length === 0 ? drawn.width : 0;
    height = canvases.length === 0 ? drawn.height : 0;
    pixels = new Uint8ClampedArray(canvases.length === 0 ? drawn.pixels : []);
    getContext(kind: string) {
      if (kind !== "2d") return null;
      return {
        drawImage: (source: FakeCanvas) => {
          calls.push("drawImage");
          this.pixels = source.pixels.slice();
        },
        getImageData: (_x: number, _y: number, w: number, rows: number) => {
          calls.push("getImageData");
          return { data: this.pixels.slice(0, w * rows * 4) };
        },
        putImageData: (image: FakeImageData) => {
          calls.push("putImageData");
          this.pixels = image.data.slice();
        },
      };
    }
    toBlob(done: BlobCallback, type: string) {
      h.encodes.push(`canvasToBlob:${type}`);
      const { width, height } = this;
      done(new Blob([JSON.stringify({ width, height, pixels: Array.from(this.pixels) })], { type }));
    }
  }

  // The node project has no ImageData.
  class FakeImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  }

  beforeEach(() => {
    drawn = { width: 2, height: 1, pixels: [10, 20, 30, 255, 200, 100, 0, 255] };
    vi.stubGlobal("ImageData", FakeImageData);
    vi.stubGlobal("document", {
      createElement: () => {
        const canvas = new FakeCanvas();
        canvases.push(canvas);
        return canvas;
      },
    });
  });

  // Each export makes its own renderer and canvases.
  async function renderOne(params: DevelopParams, settings: ExportSettings) {
    calls.length = 0;
    canvases.length = 0;
    h.encodes.length = 0;
    h.edits.set("p", params);
    h.decoded.set("p", {
      kind: "bitmap",
      bitmap: { width: 2, height: 1, close: () => undefined } as unknown as ImageBitmap,
    });
    const [out] = await renderPhotosToBlobs([photo("p")], settings);
    return out;
  }

  async function exportOne(params: DevelopParams, settings: ExportSettings) {
    return (await renderOne(params, settings)).blob;
  }

  async function jpegContents(blob: Blob | null): Promise<{ width: number; height: number; pixels: number[] }> {
    if (!blob) throw new Error("no JPEG was rendered");
    return JSON.parse(await blob.text());
  }

  // A 10-pixel white mat around the frame, as a print mat makes.
  function matted(frame: ExportFrame): ExportFrame {
    const width = frame.width + 20;
    const height = frame.height + 20;
    const data = new Uint16Array(width * height * 4).fill(65535);
    for (let y = 0; y < frame.height; y++) {
      const row = frame.data.subarray(y * frame.width * 4, (y + 1) * frame.width * 4);
      data.set(row, ((y + 10) * width + 10) * 4);
    }
    return { ...frame, data, width, height };
  }

  // The RGB at (x, y) of an RGB strip `width` wide.
  const rgbAt = (samples: number[], width: number, x: number, y: number) =>
    samples.slice((y * width + x) * 3, (y * width + x) * 3 + 3);

  it("hands each hook the export's pixels as 16-bit codes, with its space, profile and depth", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: ExportFrame[] = [];
    h.processors.look = {
      id: "look",
      order: 0,
      processPixels: async (frame) => {
        seen.push({ ...frame, data: frame.data.slice() });
      },
    };
    await exportOne(V3, TIFF8);
    await exportOne(V3, TIFF16);
    await exportOne(V2, { ...TIFF16, colorSpace: "srgb" });
    await exportOne(V2, JPEG);
    // A 16-bit TIFF the device can't render is written at 8 bits.
    h.FakeRenderer.exportTargets = [null];
    await exportOne(V3, TIFF16);

    const icc = buildIccProfile("adobe-rgb");
    const frame = { width: 2, height: 1 };
    const drawnCodes = new Uint16Array(drawn.pixels.map((v) => v * 257));
    expect(seen).toEqual([
      { ...frame, data: drawnCodes, colorSpace: "adobe-rgb", icc, bitDepth: 8 },
      { ...frame, data: new Uint16Array(CODES), colorSpace: "adobe-rgb", icc, bitDepth: 16 },
      { ...frame, data: new Uint16Array(8).fill(32768), colorSpace: "srgb", icc: null, bitDepth: 16 },
      { ...frame, data: drawnCodes, colorSpace: "srgb", icc: null, bitDepth: 8 },
      { ...frame, data: drawnCodes, colorSpace: "adobe-rgb", icc, bitDepth: 8 },
    ]);
  });

  it("encodes a matted frame at its new size, with the export's profile and EXIF", async () => {
    const plain8 = await readTiff(await exportOne(V3, TIFF8));
    const plain16 = await readTiff(await exportOne(V3, TIFF16));
    h.processors.mat = { id: "mat", order: 0, processPixels: async (frame) => matted(frame) };

    const mat8 = await readTiff(await exportOne(V3, TIFF8));
    expect(mat8).toMatchObject({ width: 22, height: 21, bitDepth: 8, exifSize: [22, 21] });
    expect(mat8.icc).toEqual(buildIccProfile("adobe-rgb"));
    expect(mat8.icc).toEqual(plain8.icc);
    expect(rgbAt(mat8.samples, 22, 0, 0)).toEqual([255, 255, 255]);
    expect(rgbAt(mat8.samples, 22, 10, 10)).toEqual([10, 20, 30]);
    expect(rgbAt(mat8.samples, 22, 11, 10)).toEqual([200, 100, 0]);

    const mat16 = await readTiff(await exportOne(V3, TIFF16));
    expect(mat16).toMatchObject({ width: 22, height: 21, bitDepth: 16, exifSize: [22, 21] });
    expect(mat16.icc).toEqual(plain16.icc);
    expect(rgbAt(mat16.samples, 22, 0, 0)).toEqual([65535, 65535, 65535]);
    expect(rgbAt(mat16.samples, 22, 10, 10)).toEqual([1, 2, 3]);
    expect(rgbAt(mat16.samples, 22, 11, 10)).toEqual([40000, 50000, 65535]);

    const jpeg = await jpegContents(await exportOne(V3, JPEG));
    expect(jpeg).toMatchObject({ width: 22, height: 21 });
    expect(jpeg.pixels.slice(0, 4)).toEqual([255, 255, 255, 255]);
    expect(jpeg.pixels.slice((10 * 22 + 10) * 4, (10 * 22 + 12) * 4)).toEqual(drawn.pixels);
    expect(h.encodes).toEqual(["canvasToBlob:image/jpeg", "embedColorProfile"]);

    // A headless render reports the file's size, not the renderer canvas's.
    for (const settings of [TIFF8, TIFF16, JPEG]) {
      const { width, height } = await renderOne(V3, settings);
      expect([width, height], `${settings.format} at ${settings.tiffBitDepth ?? 8} bits`).toEqual([22, 21]);
    }
  });

  it("encodes the pixels a hook changed in place and returned nothing for", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    h.processors.invert = {
      id: "invert",
      order: 0,
      processPixels: async (frame) => {
        for (let i = 0; i < frame.data.length; i++) if (i % 4 !== 3) frame.data[i] = 65535 - frame.data[i];
      },
    };
    expect((await pngContents(await exportOne(V3, PNG16))).samples).toEqual([65534, 65533, 65532, 25535, 15535, 0]);
    expect((await readTiff(await exportOne(V3, TIFF8))).samples).toEqual([245, 235, 225, 55, 155, 255]);
    expect(logged).not.toHaveBeenCalled();
  });

  it("narrows a hook's codes to the nearest 8-bit value", async () => {
    h.processors.codes = {
      id: "codes",
      order: 0,
      processPixels: async (frame) => ({ ...frame, data: new Uint16Array([0, 128, 129, 65535, 25900, 32767, 32768, 65535]) }),
    };
    expect((await readTiff(await exportOne(V3, TIFF8))).samples).toEqual([0, 0, 1, 101, 127, 128]);
  });

  it("runs every pixel hook in processor order, with its settings, before any process(blob)", async () => {
    const ran: string[] = [];
    h.processors.last = {
      id: "last",
      order: 2,
      process: async (blob) => {
        ran.push("process:last");
        return blob;
      },
    };
    h.processors.second = {
      id: "second",
      order: 1,
      processPixels: async () => {
        ran.push("pixels:second");
      },
    };
    h.processors.first = {
      id: "first",
      order: 0,
      settings: [{ key: "border", label: "Border", type: "number", default: 10 }],
      processPixels: async (_frame, _photo, settings, context) => {
        ran.push(`pixels:first ${JSON.stringify(settings)} ${JSON.stringify(context)}`);
      },
      process: async (blob) => {
        ran.push("process:first");
        return blob;
      },
    };
    for (const settings of [JPEG, TIFF8, TIFF16, PNG16]) {
      ran.length = 0;
      await exportOne(V3, { ...settings, longEdge: 1200, processorSettings: { first: { colour: "white" } } });
      expect(ran, settings.format).toEqual([
        'pixels:first {"border":10,"colour":"white"} {"longEdge":1200}',
        "pixels:second",
        "process:first",
        "process:last",
      ]);
    }
  });

  // A plain-JS hook can hand back anything: an array of the right length but
  // the wrong type, a size no file can have, or no frame at all.
  it("logs and skips a hook that throws or returns a frame the encoders can't take, keeping the frame before it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const handed: number[][] = [];
    const returning = (order: number, make: (frame: ExportFrame) => unknown) => ({
      id: `returns-${order}`,
      order,
      processPixels: async (frame: ExportFrame) => make(frame) as ExportFrame,
    });
    h.processors.boom = {
      id: "boom",
      order: 0,
      processPixels: async () => {
        throw new Error("hook failed");
      },
    };
    const bad: ((frame: ExportFrame) => unknown)[] = [
      (frame) => ({ ...frame, data: frame.data.subarray(4) }),
      (frame) => ({ ...frame, data: new Uint8ClampedArray(8) }),
      (frame) => ({ ...frame, data: new Float32Array(8) }),
      (frame) => ({ ...frame, data: new Uint16Array(0), width: 0, height: 1 }),
      (frame) => ({ ...frame, data: new Uint16Array(0), width: 2, height: 0 }),
      (frame) => ({ ...frame, width: 0.5, height: 4 }),
      (frame) => ({ ...frame, width: 4, height: 0.5 }),
      (frame) => ({ ...frame, width: -2, height: -1 }),
      () => ({}),
      () => 5,
      (frame) => ({ ...frame, data: null }),
      (frame) => ({ ...frame, data: Object.create(null) }),
    ];
    bad.forEach((make, i) => (h.processors[`returns-${i + 1}`] = returning(i + 1, make)));
    h.processors.watch = {
      id: "watch",
      order: 99,
      processPixels: async (frame) => {
        handed.push([frame.width, frame.height, ...frame.data]);
      },
    };

    const tiff16 = await readTiff(await exportOne(V3, TIFF16));
    const tiff8 = await readTiff(await exportOne(V3, TIFF8));

    expect(handed).toEqual([
      [2, 1, ...CODES],
      [2, 1, ...drawn.pixels.map((v) => v * 257)],
    ]);
    expect(tiff16).toMatchObject({ width: 2, height: 1, samples: [1, 2, 3, 40000, 50000, 65535] });
    expect(tiff8).toMatchObject({ width: 2, height: 1, samples: [10, 20, 30, 200, 100, 0] });
    const perExport = [
      expect.stringMatching(/"boom" threw.*hook failed/),
      expect.stringMatching(/"returns-1" returned a frame the encoders can't take: 2×1 with a Uint16Array of 4 values/),
      expect.stringMatching(/"returns-2" .* 2×1 with a Uint8ClampedArray of 8 values/),
      expect.stringMatching(/"returns-3" .* 2×1 with a Float32Array of 8 values/),
      expect.stringMatching(/"returns-4" .* 0×1 with a Uint16Array of 0 values/),
      expect.stringMatching(/"returns-5" .* 2×0 with a Uint16Array of 0 values/),
      expect.stringMatching(/"returns-6" .* 0\.5×4 with a Uint16Array of 8 values/),
      expect.stringMatching(/"returns-7" .* 4×0\.5 with a Uint16Array of 8 values/),
      expect.stringMatching(/"returns-8" .* -2×-1 with a Uint16Array of 8 values/),
      expect.stringMatching(/"returns-9" returned a frame the encoders can't take: undefined×undefined with data undefined/),
      expect.stringMatching(/"returns-10" .* undefined×undefined with data undefined/),
      expect.stringMatching(/"returns-11" .* 2×1 with data null/),
      expect.stringMatching(/"returns-12" .* 2×1 with a prototype-less object,/),
    ];
    expect(logged.mock.calls.map((call) => call.join(" "))).toEqual([...perExport, ...perExport]);
  });

  it("keeps the export's space, profile and depth whatever a hook does to the frame's", async () => {
    const after: Pick<ExportFrame, "colorSpace" | "bitDepth">[] = [];
    h.processors.scribble = {
      id: "scribble",
      order: 0,
      processPixels: async (frame) => {
        frame.icc?.fill(0);
        return { ...frame, icc: new Uint8Array(4), colorSpace: "srgb", bitDepth: 8 };
      },
    };
    h.processors.watch = {
      id: "watch",
      order: 1,
      processPixels: async ({ colorSpace, bitDepth }) => {
        after.push({ colorSpace, bitDepth });
      },
    };
    const first = await readTiff(await exportOne(V3, TIFF16));
    const second = await readTiff(await exportOne(V3, TIFF8));
    expect(first).toMatchObject({ bitDepth: 16, icc: buildIccProfile("adobe-rgb") });
    expect(second).toMatchObject({ bitDepth: 8, icc: buildIccProfile("adobe-rgb") });
    expect(after).toEqual([
      { colorSpace: "adobe-rgb", bitDepth: 16 },
      { colorSpace: "adobe-rgb", bitDepth: 8 },
    ]);
    // 'acsp', the signature every ICC profile carries: the cached profile is whole.
    expect(Array.from(buildIccProfile("adobe-rgb").subarray(36, 40))).toEqual([0x61, 0x63, 0x73, 0x70]);
  });

  it("reads an 8-bit export's canvas back only for a pixel hook", async () => {
    h.processors.fileOnly = { id: "fileOnly", order: 0, process: async (blob) => blob };
    await exportOne(V3, JPEG);
    expect(canvases).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(h.encodes).toEqual(["canvasToBlob:image/jpeg", "embedColorProfile"]);

    // An 8-bit TIFF reads its canvas back once to encode it, as it always has.
    await exportOne(V3, TIFF8);
    expect(canvases).toHaveLength(2);
    expect(calls).toEqual(["drawImage", "getImageData"]);

    await exportOne(V2, TIFF16);
    expect(canvases).toHaveLength(1);
    expect(calls).toEqual([]);

    // With a hook: one readback, then a canvas to encode from, which a TIFF,
    // written from the bytes, doesn't need.
    h.processors.look = { id: "look", order: 1, processPixels: async () => undefined };
    await exportOne(V3, JPEG);
    expect(canvases).toHaveLength(3);
    expect(calls).toEqual(["drawImage", "getImageData", "putImageData"]);
    expect(h.encodes).toEqual(["canvasToBlob:image/jpeg", "embedColorProfile"]);

    await exportOne(V3, TIFF8);
    expect(canvases).toHaveLength(2);
    expect(calls).toEqual(["drawImage", "getImageData"]);
  });

  it("hands back an 8-bit frame a hook returns unchanged byte for byte", async () => {
    // Every byte value in each channel.
    const pixels = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 67) % 256, 255]).flat();
    drawn = { width: 256, height: 1, pixels };
    for (const settings of [JPEG, TIFF8]) {
      delete h.processors.same;
      const plain = new Uint8Array(await (await exportOne(V3, settings))!.arrayBuffer());
      let runs = 0;
      h.processors.same = {
        id: "same",
        order: 0,
        processPixels: async (frame) => {
          runs++;
          return { ...frame, data: frame.data.slice() };
        },
      };
      const hooked = new Uint8Array(await (await exportOne(V3, settings))!.arrayBuffer());
      expect(runs, settings.format).toBe(1);
      expect(hooked, settings.format).toEqual(plain);
    }
  });

  it("runs no processors for a render a pixel hook started, and the photo's own still run", async () => {
    const ran: string[] = [];
    h.processors.nest = {
      id: "nest",
      order: 0,
      processPixels: async (_frame, p) => {
        ran.push("pixels");
        if (ran.length > 3) throw new Error("processors recursed");
        await renderPhotosToBlobs([p], TIFF8);
        await renderPhotosToBlobs([p], TIFF8);
      },
      process: async (blob) => {
        ran.push("process");
        return blob;
      },
    };
    expect(await exportOne(V3, JPEG)).not.toBeNull();
    expect(ran).toEqual(["pixels", "process"]);
  });

  it("runs a processor with only a pixel hook", async () => {
    let runs = 0;
    h.processors.only = {
      id: "only",
      order: 0,
      processPixels: async () => {
        runs++;
      },
    };
    expect(await exportOne(V3, JPEG)).not.toBeNull();
    expect(runs).toBe(1);
  });
});

// ProPhoto's gamut spreads 8 bits thin enough to band a smooth gradient, so the
// Export panel warns when a ProPhoto export would be written at 8 bits.
describe("a ProPhoto export at 8 bits", () => {
  const JPEG = "image/jpeg";
  const PNG = "image/png";
  const TIFF = "image/tiff";

  it("is what JPEG, WebP, and PNG or TIFF at 8 bits write", () => {
    const at8Bit: Pick<ExportSettings, "format" | "tiffBitDepth" | "pngBitDepth">[] = [
      { format: JPEG },
      { format: JPEG, tiffBitDepth: 16, pngBitDepth: 16 },
      { format: "image/webp" },
      { format: PNG },
      { format: PNG, pngBitDepth: 8, tiffBitDepth: 16 },
      { format: TIFF },
      { format: TIFF, tiffBitDepth: 8, pngBitDepth: 16 },
    ];
    for (const settings of at8Bit) {
      expect(proPhotoAt8Bit({ ...settings, colorSpace: "prophoto-rgb" }), settings.format).toBe(true);
    }
  });

  it("is not a 16-bit TIFF or PNG, nor any export in another space", () => {
    expect(proPhotoAt8Bit({ format: TIFF, tiffBitDepth: 16, colorSpace: "prophoto-rgb" })).toBe(false);
    expect(proPhotoAt8Bit({ format: PNG, pngBitDepth: 16, colorSpace: "prophoto-rgb" })).toBe(false);
    for (const colorSpace of [undefined, "srgb", "display-p3", "adobe-rgb"] as const) {
      expect(proPhotoAt8Bit({ format: JPEG, colorSpace }), colorSpace).toBe(false);
      expect(proPhotoAt8Bit({ format: PNG, colorSpace }), colorSpace).toBe(false);
    }
  });
});

describe("the export status line", () => {
  const result = (counts: Partial<ExportResult>): ExportResult => ({
    exported: 3,
    failed: [],
    degradedTo8Bit: 0,
    reducedPrecision: 0,
    ...counts,
  });

  it("reads as it always has without reduced precision", () => {
    expect(exportStatus(result({}))).toBe("Exported 3 photos.");
    expect(exportStatus(result({ exported: 1 }))).toBe("Exported 1 photo.");
    expect(exportStatus(result({ exported: 2, failed: ["c.RAF"] }))).toBe("Exported 2; 1 could not be exported.");
    expect(exportStatus(result({ degradedTo8Bit: 2 }))).toBe(
      "Exported 3 photos. 2 exported as 8-bit (device can't render 16-bit).",
    );
    expect(exportStatus(result({ zipFellBack: true }))).toBe(
      "Exported 3 photos. ZIP exceeded 4 GiB; delivered as individual files.",
    );
  });

  it("names the photos at reduced 16-bit precision beside those at 8-bit", () => {
    expect(exportStatus(result({ degradedTo8Bit: 1, reducedPrecision: 2, zipFellBack: true }))).toBe(
      "Exported 3 photos. 1 exported as 8-bit (device can't render 16-bit). " +
        "2 exported at reduced 16-bit precision (device can't render full precision). " +
        "ZIP exceeded 4 GiB; delivered as individual files.",
    );
  });
});
