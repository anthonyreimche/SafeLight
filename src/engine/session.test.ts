// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSavedEdit } from "@/catalog/edit-params";
import { photoSourceKey, type DecodedImage } from "@/catalog/load-image";
import type { CatalogStorage } from "@/catalog/storage";
import { freshParams, type CatalogPhoto, type DevelopParams, type EditState } from "@/catalog/types";
import type { ExportSettings, RenderedPhoto } from "@/modules/export/export-image";
import type { FrameResult, RenderBridge } from "@/rendering/render-bridge";
import { useCatalogStore } from "@/state/catalog-store";
import type { EngineEvent, ProjectWire } from "./protocol";
import type { PortMessage, RequestOut } from "./rpc";
import { EngineSession, READ_RECORDS, exportSettingsFor, type SessionDeps } from "./session";

const variants = vi.hoisted(() => ({
  need: (_bag: Record<string, unknown>, _needs?: { worker?: boolean }): Promise<{ failure: string | null; release(): void }> | null =>
    null,
}));

vi.mock("@/rendering/render-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/rendering/render-bridge")>()),
  needStageVariants: (bag: Record<string, unknown>, needs?: { worker?: boolean }) => variants.need(bag, needs),
}));

const PROJECT: ProjectWire = { root: "D:\\shoot", workingDir: "D:\\shoot\\.safelight", location: "in-folder" };

function photo(id: string): CatalogPhoto {
  return {
    id,
    filename: `${id}.ARW`,
    relPath: `day1/${id}.ARW`,
    folder: "day1",
    directoryHandle: null,
    fileHandle: { kind: "file", name: `${id}.ARW` } as unknown as FileSystemFileHandle,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 8,
    mimeType: "image/x-sony-arw",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: { colorTemperature: 5200 },
  };
}

function editOf(id: string, params: Partial<DevelopParams>, paramBag: Record<string, unknown> = {}): EditState {
  const original = freshParams(5200);
  return {
    photoId: id,
    stack: [
      { timestamp: 1, label: "Original", params: original, paramBag: {} },
      { timestamp: 2, label: "Exposure", params: { ...original, ...params }, paramBag },
    ],
    currentIndex: 1,
  };
}

/** A project whose storage counts every write, and whose previews are `previews`. */
function fakeProject(photos: CatalogPhoto[], edits: EditState[], previews: Record<string, Blob> = {}) {
  const writes = {
    putPhoto: vi.fn(async () => {}),
    putPhotos: vi.fn(async () => {}),
    deletePhotos: vi.fn(async () => {}),
    putEditState: vi.fn(async () => {}),
    putEditStates: vi.fn(async () => {}),
    putPhotoBlob: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  };
  const storage: CatalogStorage = {
    ...writes,
    getEditState: async (id) => edits.find((e) => e.photoId === id),
    close: vi.fn(),
  };
  const readPreview = vi.fn(async (id: string) => previews[id] ?? null);
  const openProject = vi.fn(async () => ({ photos, storage, readPreview }));
  const wrote = () => Object.values(writes).reduce((n, fn) => n + fn.mock.calls.length, 0);
  return { storage, openProject, wrote };
}

const fakeBitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

/** The render bridge as the session drives it: frames follow render(true),
 *  then the histogram, unless `prepassFrames` frames come first without one. */
function fakeBridge(prepassFrames = 0) {
  let gen = 0;
  const calls: { method: string; args: unknown[] }[] = [];
  const frames: ImageBitmap[] = [];
  let onFrame: ((f: FrameResult) => void) | null = null;
  let onHistogram: (() => void) | null = null;
  const note = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
  };
  const frameOf = (bitmap: ImageBitmap): FrameResult => ({
    bitmap,
    width: 40,
    height: 20,
    sourceWidth: 40,
    sourceHeight: 20,
    sourceGen: gen,
    sourceFullWidth: 40,
    sourceFullHeight: 20,
    sourceNative: false,
    roi: null,
    wholeWidth: 40,
    wholeHeight: 20,
    crop: null,
    overflowedStages: [],
    seq: frames.length,
  } as FrameResult);
  const bridge = {
    ready: Promise.resolve(),
    availability: "ready",
    get sourceGen() {
      return gen;
    },
    clearSource: note("clearSource"),
    setViewport: note("setViewport"),
    setMonitorTransform: note("setMonitorTransform"),
    setDisplaySpace: note("setDisplaySpace"),
    bindSource: async () => false,
    uploadSource: (...args: unknown[]) => {
      calls.push({ method: "uploadSource", args });
      gen++;
    },
    setImage: (...args: unknown[]) => {
      calls.push({ method: "setImage", args });
      gen++;
    },
    setAsShotTemperature: note("setAsShotTemperature"),
    setContributedParams: note("setContributedParams"),
    setParams: note("setParams"),
    render: (...args: unknown[]) => {
      calls.push({ method: "render", args });
      setTimeout(() => {
        for (let i = 0; i <= prepassFrames; i++) {
          const bitmap = fakeBitmap(40, 20);
          frames.push(bitmap);
          onFrame?.(frameOf(bitmap));
        }
        onHistogram?.();
      }, 0);
    },
    setOnFrame: (cb: typeof onFrame) => {
      onFrame = cb;
    },
    setOnHistogram: (cb: typeof onHistogram) => {
      onHistogram = cb;
    },
    setOnHistogramError: () => {},
    setOnSourceError: () => {},
    setOnError: () => {},
  };
  const called = (method: string) => calls.filter((c) => c.method === method).map((c) => c.args);
  return { bridge: bridge as unknown as RenderBridge, called, frames };
}

function recordingOut() {
  const sent: PortMessage[] = [];
  let frames = 0;
  const out: RequestOut = {
    emit: (event) => sent.push(event),
    frame: (bytes, announce) => {
      const frame = ++frames;
      sent.push(announce(frame), { frame, bytes });
    },
  };
  const events = () => sent.filter((m): m is EngineEvent => "type" in m);
  return { out, sent, events };
}

const DECODED: DecodedImage = { kind: "float", data: new Float32Array(16), width: 2, height: 2 };

function session(over: Partial<SessionDeps>) {
  return new EngineSession({
    loadImage: vi.fn(async () => DECODED),
    encodeFrame: vi.fn(async (bitmap: ImageBitmap, maxWidth: number, maxHeight: number) => {
      bitmap.close();
      return { bytes: new Uint8Array([maxWidth, maxHeight]), width: maxWidth, height: maxHeight };
    }),
    renderPhotos: vi.fn(async () => []),
    exists: vi.fn(async () => false),
    writeFile: vi.fn(async () => {}),
    ...over,
  });
}

beforeEach(() => {
  useCatalogStore.getState().replaceCatalog([]);
});

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("a preview", () => {
  it("draws the photo's current step, with the request's look over it, at the size asked", async () => {
    const project = fakeProject([photo("a"), photo("b")], [editOf("a", { exposure: 1, contrast: 10 })]);
    const { bridge, called } = fakeBridge();
    const engine = session({ openProject: project.openProject, bridge: () => bridge });
    const { out, sent } = recordingOut();

    await engine.preview(
      { id: 7, type: "preview", project: PROJECT, photoId: "a", width: 120, height: 80, encoding: "rgba", overrides: { params: { exposure: 0.5 } } },
      out,
    );

    expect(project.openProject).toHaveBeenCalledWith(PROJECT.root, READ_RECORDS);
    expect(useCatalogStore.getState().photos.map((p) => p.id)).toEqual(["a", "b"]);
    expect(called("setDisplaySpace")).toEqual([["srgb"]]);
    expect(called("setViewport")).toEqual([[null]]);
    expect(called("uploadSource")[0].slice(0, 2)).toEqual(["main", photoSourceKey(photo("a"))]);
    const drawn = called("setParams")[0][0] as DevelopParams;
    expect(drawn.exposure).toBe(0.5);
    expect(drawn.contrast).toBe(10);
    expect(called("setAsShotTemperature")).toEqual([[5200]]);
    expect(called("render")).toEqual([[true]]);
    expect(sent).toEqual([
      { id: 7, type: "frame", frame: 1, width: 120, height: 80, encoding: "rgba" },
      { frame: 1, bytes: new Uint8Array([120, 80]) },
    ]);
    expect(project.wrote()).toBe(0);
  });

  // SafeLight #278: a variant made on demand (a photo's own per-photo texture)
  // is had before the frame, as an export's is, or the frame draws without it.
  it("draws once the stage texture variants the photo's bag names are held, and lets go after", async () => {
    const project = fakeProject([photo("a")], []);
    const { bridge, called } = fakeBridge();
    const engine = session({ openProject: project.openProject, bridge: () => bridge });
    const events: string[] = [];
    let held!: () => void;
    variants.need = (_bag, needs) => {
      events.push(`asked, worker ${needs?.worker === true}`);
      return new Promise((done) => {
        held = () => done({ failure: null, release: () => events.push(`released after ${called("render").length} render`) });
      });
    };
    try {
      const shown = engine.preview({ id: 1, type: "preview", project: PROJECT, photoId: "a", width: 40, height: 20, encoding: "rgba" }, recordingOut().out);
      await vi.waitFor(() => expect(events).toEqual(["asked, worker true"]));
      expect(called("render")).toEqual([]);
      held();
      await shown;
    } finally {
      variants.need = () => null;
    }
    expect(events).toEqual(["asked, worker true", "released after 1 render"]);
  });

  it("draws only the region asked, at the size asked, and the whole photo again without one", async () => {
    const project = fakeProject([photo("a")], []);
    const { bridge, called } = fakeBridge();
    const engine = session({ openProject: project.openProject, bridge: () => bridge });
    const req = { id: 1, type: "preview" as const, project: PROJECT, photoId: "a", width: 800, height: 600, encoding: "png" as const };

    await engine.preview({ ...req, region: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 } }, recordingOut().out);
    await engine.preview(req, recordingOut().out);

    expect(called("setViewport")).toEqual([[{ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 800, 600], [null]]);
  });

  it("reads the project again when the catalogue's stamp changed since it read it, and not otherwise", async () => {
    const project = fakeProject([photo("a")], []);
    const { bridge } = fakeBridge();
    const engine = session({ openProject: project.openProject, bridge: () => bridge });
    const req = { id: 1, type: "preview" as const, project: PROJECT, photoId: "a", width: 40, height: 20, encoding: "png" as const };

    await engine.preview({ ...req, catalogue: "1:10" }, recordingOut().out);
    await engine.preview({ ...req, catalogue: "1:10" }, recordingOut().out);
    await engine.preview(req, recordingOut().out);
    await engine.preview({ ...req, catalogue: "2:12" }, recordingOut().out);

    expect(project.openProject).toHaveBeenCalledTimes(2);
    expect(project.storage.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the last frame when the first put its prepasses off", async () => {
    const project = fakeProject([photo("a")], []);
    const { bridge, frames } = fakeBridge(1);
    const encodeFrame = vi.fn(async (bitmap: ImageBitmap) => ({ bytes: new Uint8Array(), width: bitmap.width, height: bitmap.height }));
    const engine = session({ openProject: project.openProject, bridge: () => bridge, encodeFrame });

    await engine.preview({ id: 1, type: "preview", project: PROJECT, photoId: "a", width: 40, height: 20, encoding: "png" }, recordingOut().out);

    expect(frames).toHaveLength(2);
    expect(encodeFrame.mock.calls[0][0]).toBe(frames[1]);
    expect(frames[0].close).toHaveBeenCalled();
  });

  it("opens a never-edited photo on its untouched look, at its as-shot white balance", async () => {
    const project = fakeProject([photo("a")], []);
    const { bridge, called } = fakeBridge();
    const engine = session({ openProject: project.openProject, bridge: () => bridge });

    await engine.preview({ id: 1, type: "preview", project: PROJECT, photoId: "a", width: 40, height: 20, encoding: "png" }, recordingOut().out);

    expect((called("setParams")[0][0] as DevelopParams).temperature).toBe(5200);
    expect(project.wrote()).toBe(0);
  });

  it("fails as a decode error when the photo can't be read, and for a photo not in the catalogue", async () => {
    const project = fakeProject([photo("a")], []);
    const { bridge } = fakeBridge();
    const engine = session({ openProject: project.openProject, bridge: () => bridge, loadImage: vi.fn(async () => null) });
    const req = { id: 1, type: "preview" as const, project: PROJECT, width: 40, height: 20, encoding: "png" as const };

    await expect(engine.preview({ ...req, photoId: "a" }, recordingOut().out)).rejects.toMatchObject({ code: "decode" });
    await expect(engine.preview({ ...req, photoId: "zz" }, recordingOut().out)).rejects.toMatchObject({ code: "project" });
  });
});

describe("what the engine opens", () => {
  it("opens a project to read its records only, and never to write them", () => {
    expect(READ_RECORDS).toEqual({ recordsOnly: true, readOnly: true });
  });

  it("reads the project again, read-only, after an import wrote it", async () => {
    const project = fakeProject([photo("a")], []);
    const { bridge } = fakeBridge();
    const importProject = vi.fn(async () => {
      expect(useCatalogStore.getState().photos).toEqual([]);
    });
    const engine = session({ openProject: project.openProject, bridge: () => bridge, importProject });
    const req = { id: 1, type: "preview" as const, project: PROJECT, photoId: "a", width: 40, height: 20, encoding: "png" as const };
    const signal = new AbortController().signal;

    await engine.preview(req, recordingOut().out, signal);
    await engine.import({ id: 2, type: "import", project: { root: PROJECT.root }, scope: { kind: "all" }, metadata: true, keepBackup: true }, recordingOut().out, signal);
    await engine.preview(req, recordingOut().out, signal);

    expect(importProject).toHaveBeenCalledTimes(1);
    expect(project.storage.close).toHaveBeenCalled();
    expect(project.openProject.mock.calls).toEqual([
      [PROJECT.root, READ_RECORDS],
      [PROJECT.root, READ_RECORDS],
    ]);
  });
});

describe("thumbs", () => {
  const jpeg = (n: number) => new Blob([new Uint8Array([n])], { type: "image/jpeg" });

  it("sends each photo's stored preview as a frame, fitted to the edge asked, and says which photos have none", async () => {
    const project = fakeProject([photo("a"), photo("b"), photo("c")], [], { a: jpeg(1), c: jpeg(3) });
    const decoded: Blob[] = [];
    const decodePreview = vi.fn(async (blob: Blob) => {
      decoded.push(blob);
      return fakeBitmap(300, 200);
    });
    const engine = session({ openProject: project.openProject, decodePreview });
    const { out, sent } = recordingOut();

    await engine.thumbs({ id: 4, type: "thumbs", project: PROJECT, photoIds: ["a", "b", "zz", "c"], edge: 96, encoding: "rgba" }, out, new AbortController().signal);

    expect(project.openProject).toHaveBeenCalledWith(PROJECT.root, READ_RECORDS);
    expect(decoded).toEqual([jpeg(1), jpeg(3)]);
    expect(sent).toEqual([
      { id: 4, type: "frame", frame: 1, width: 96, height: 96, encoding: "rgba", photoId: "a" },
      { frame: 1, bytes: new Uint8Array([96, 96]) },
      { id: 4, type: "error", code: "decode", message: "b.ARW has no preview yet.", photoId: "b" },
      { id: 4, type: "error", code: "project", message: "This photo isn't in the catalogue.", photoId: "zz" },
      { id: 4, type: "frame", frame: 2, width: 96, height: 96, encoding: "rgba", photoId: "c" },
      { frame: 2, bytes: new Uint8Array([96, 96]) },
    ]);
    expect(project.wrote()).toBe(0);
  });

  it("stops at a cancel, after the frame it was on", async () => {
    const project = fakeProject([photo("a"), photo("b")], [], { a: jpeg(1), b: jpeg(2) });
    const stop = new AbortController();
    const decodePreview = vi.fn(async () => {
      stop.abort();
      return fakeBitmap(10, 10);
    });
    const engine = session({ openProject: project.openProject, decodePreview });
    const { out, events } = recordingOut();

    await engine.thumbs({ id: 1, type: "thumbs", project: PROJECT, photoIds: ["a", "b"], edge: 32, encoding: "png" }, out, stop.signal);

    expect(decodePreview).toHaveBeenCalledTimes(1);
    expect(events().map((e) => e.type === "frame" && e.photoId)).toEqual(["a"]);
  });
});

describe("export settings", () => {
  const defaults: ExportSettings = {
    format: "image/jpeg",
    quality: 0.8,
    longEdge: 2048,
    bundle: true,
    delivery: "zip",
    colorSpace: "srgb",
    ifExists: "number",
  };

  it("are the GUI's defaults where the request leaves them out", () => {
    expect(exportSettingsFor({}, defaults)).toEqual({ ...defaults, bundle: false, delivery: "folder" });
  });

  it("take each value the request gives", () => {
    expect(
      exportSettingsFor(
        { format: "png", quality: 90, longEdge: "original", colourSpace: "display-p3", bitDepth: 16, nameTemplate: "{filename}-x", existing: "replace" },
        defaults,
      ),
    ).toEqual({
      ...defaults,
      bundle: false,
      delivery: "folder",
      format: "image/png",
      quality: 0.9,
      longEdge: null,
      colorSpace: "display-p3",
      tiffBitDepth: 16,
      pngBitDepth: 16,
      filenameTemplate: "{filename}-x",
      ifExists: "replace",
    });
  });
});

describe("an export", () => {
  const rendered = (photos: CatalogPhoto[], blob: (p: CatalogPhoto) => Blob | null): RenderedPhoto[] =>
    photos.map((p) => {
      const b = blob(p);
      return { photo: p, blob: b, width: b ? 300 : 0, height: b ? 200 : 0 };
    });

  it("renders through the export path with the look asked for, and writes each file into the folder", async () => {
    const project = fakeProject([photo("a"), photo("b")], [editOf("a", { exposure: 1 })]);
    const looks: Record<string, number> = {};
    const renderPhotos = vi.fn(async (photos: CatalogPhoto[], _settings: ExportSettings) => {
      for (const p of photos) looks[p.id] = (await loadSavedEdit(p.id, p.exif.colorTemperature)).params.exposure;
      return rendered(photos, () => new Blob([new Uint8Array(5)], { type: "image/png" }));
    });
    const exists = vi.fn(async (path: string) => path === "D:\\out\\a.png");
    const writeFile = vi.fn(async (_path: string, _blob: Blob) => {});
    const engine = session({ openProject: project.openProject, renderPhotos, exists, writeFile });
    const { out, events } = recordingOut();

    await engine.export(
      {
        id: 3,
        type: "export",
        project: PROJECT,
        photoIds: ["a", "missing", "b"],
        settings: { format: "png", bitDepth: 8 },
        target: { kind: "dir", dir: "D:\\out" },
        overrides: { params: { contrast: 20 } },
      },
      out,
    );

    expect(project.openProject).toHaveBeenCalledWith(PROJECT.root, READ_RECORDS);
    expect(renderPhotos.mock.calls[0][0].map((p) => p.id)).toEqual(["a", "b"]);
    expect(renderPhotos.mock.calls[0][1]).toMatchObject({ format: "image/png", pngBitDepth: 8, delivery: "folder" });
    expect(looks).toEqual({ a: 1, b: 0 });
    expect(writeFile.mock.calls.map(([path]) => path)).toEqual(["D:\\out\\a (2).png", "D:\\out\\b.png"]);
    expect(events()).toEqual([
      { id: 3, type: "error", code: "project", message: "This photo isn't in the catalogue.", photoId: "missing" },
      { id: 3, type: "exported", photoId: "a", path: "D:\\out\\a (2).png", width: 300, height: 200, colourSpace: "srgb", bytes: 5 },
      { id: 3, type: "progress", done: 2, total: 3, photoId: "a" },
      { id: 3, type: "exported", photoId: "b", path: "D:\\out\\b.png", width: 300, height: 200, colourSpace: "srgb", bytes: 5 },
      { id: 3, type: "progress", done: 3, total: 3, photoId: "b" },
    ]);
    expect(project.wrote()).toBe(0);
  });

  it("applies the request's look over each photo's step", async () => {
    const project = fakeProject([photo("a")], [editOf("a", { exposure: 1 })]);
    let contrast: number | undefined;
    const renderPhotos = vi.fn(async (photos: CatalogPhoto[]) => {
      contrast = (await loadSavedEdit("a", 5200)).params.contrast;
      return rendered(photos, () => null);
    });
    const engine = session({ openProject: project.openProject, renderPhotos });
    const { out, events } = recordingOut();

    await engine.export(
      { id: 1, type: "export", project: PROJECT, photoIds: ["a"], settings: {}, target: { kind: "dir", dir: "/out" }, overrides: { params: { contrast: 20 } } },
      out,
    );

    expect(contrast).toBe(20);
    expect(events()[0]).toEqual({ id: 1, type: "error", code: "render", message: "a.ARW couldn't be rendered.", photoId: "a" });
  });

  it("sends the file's bytes as a frame for stdout", async () => {
    const project = fakeProject([photo("a")], []);
    const renderPhotos = vi.fn(async (photos: CatalogPhoto[]) => rendered(photos, () => new Blob([new Uint8Array([9, 8, 7])])));
    const writeFile = vi.fn(async (_path: string, _blob: Blob) => {});
    const engine = session({ openProject: project.openProject, renderPhotos, writeFile });
    const { out, sent } = recordingOut();

    await engine.export({ id: 2, type: "export", project: PROJECT, photoIds: ["a"], settings: {}, target: { kind: "stdout" } }, out);

    expect(writeFile).not.toHaveBeenCalled();
    expect(sent.slice(0, 2)).toEqual([
      { id: 2, type: "exported", photoId: "a", frame: 1, width: 300, height: 200, colourSpace: expect.any(String), bytes: 3 },
      { frame: 1, bytes: new Uint8Array([9, 8, 7]) },
    ]);
  });

  it("writes a file target under its own name, and never over a photo's original", async () => {
    const project = fakeProject([photo("a")], []);
    const renderPhotos = vi.fn(async (photos: CatalogPhoto[]) => rendered(photos, () => new Blob([new Uint8Array(1)])));
    const writeFile = vi.fn(async (_path: string, _blob: Blob) => {});
    const engine = session({ openProject: project.openProject, renderPhotos, writeFile, exists: vi.fn(async () => true) });

    await engine.export(
      { id: 1, type: "export", project: PROJECT, photoIds: ["a"], settings: { existing: "replace" }, target: { kind: "file", path: "/out/keep.jpg" } },
      recordingOut().out,
    );

    expect(writeFile.mock.calls.map(([path]) => path)).toEqual(["/out/keep.jpg"]);
  });
});
