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

const h = vi.hoisted(() => {
  /** What happened, in order: "prepare:<version>", "stock:<version>", "decode:<photo id>". */
  const events: string[] = [];
  class FakeRenderer {
    static instances: FakeRenderer[] = [];
    static prepareError: Error | null = null;
    static stockError: Error | null = null;

    pipeline: unknown = null;
    /** Each prepareProgram call: its version, and the pipeline the renderer held. */
    prepared: { version: number; pipeline: unknown }[] = [];
    disposed = false;

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

    setStageTextures() {}
    setOutputColorSpace() {}
    setAsShotTemperature() {}
    setHslStyle() {}
    setImage() {
      events.push("setImage");
    }

    dispose() {
      this.disposed = true;
    }
  }
  return {
    FakeRenderer,
    events,
    /** The saved edit a photo id loads, or undefined to make the read fail. */
    edits: new Map<string, DevelopParams>(),
    /** What loading a photo id decodes to; none decodes to null. */
    decoded: new Map<string, DecodedImage>(),
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
    return { params, paramBag: {} };
  },
}));
vi.mock("@/extensions/pipelines", () => ({
  resolveDefaultPipeline: () => "default-pipeline",
  resolvePipelineFor: (displayTransform: string | null) => `pipeline:${displayTransform}`,
  setPhotoParams: () => {},
}));
vi.mock("@/extensions/registry", () => ({
  useRegistry: {
    getState: () => ({ processingStages: {}, exportProcessors: {}, filenameTemplates: {} }),
  },
}));
vi.mock("@/extensions/ext-settings", () => ({ getExtSetting: () => 100 }));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({}) }));

import { exportPhotos, renderPhotosToBlobs, type ExportSettings } from "./export-image";

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
  h.events.length = 0;
  h.edits.clear();
  h.decoded.clear();
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

    expect(result).toEqual({ exported: 0, failed: ["a.RAF", "b.RAF"], degradedTo8Bit: 0 });
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
