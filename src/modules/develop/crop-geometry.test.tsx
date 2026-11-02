// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Core's half of cropping, as the real DevelopCanvas runs it: frames sized
// from the geometry stage's region, the region each frame carries, the overlay
// mapping through it, and a canvas tool's view of the edit (crop mode draws the
// whole photo past the crop). Crop & Straighten itself is an extension; here a
// test tool stands in for its crop mode, and its stage is core's vendored copy
// (essential-stages.fixtures.ts). The render worker sizes each frame the way
// the renderer does (renderer.resize: the region's pixels capped at the long
// edge, or the zoom window at the size asked for, never more pixels than the
// window holds), and answers only when a test lets it, as a slow GPU does.
// Issue #172 (Linux, Mesa): crops of another shape than the photo came out
// stretched, Free was very slow, and the box could leave the picture.
//
// The photo is 4000×3000 (4:3) in a 1000×800 frame.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { CatalogPhoto, CropRect, DevelopParams, EditSnapshot } from "@/catalog/types";
import { DEFAULT_CROP, DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { useDevelopOverlay, type DevelopOverlayState, type OverlayRect } from "@/extensions/develop-host";
import { registerProcessingStage, registerSlot, unregisterExtension, unregisterSlot } from "@/extensions/registry";
import { WHOLE_IMAGE, regionOutputSize } from "@/rendering/geometry";
import { disposeRenderBridge } from "@/rendering/render-bridge";
import type { WorkerRequest, WorkerResponse } from "@/rendering/render-protocol";
import { essentialStages } from "@/rendering/webgl/essential-stages.fixtures";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
import type { ImageWindow } from "@/ui/viewport-view";
import { setCanvasTool, useCanvasToolStore } from "./canvas-tool";
import { DevelopCanvas } from "./DevelopCanvas";

vi.mock("libraw-wasm", () => ({ default: class {} }));

type Render = Extract<WorkerRequest, { cmd: "render" }>;
type Frame = Extract<WorkerResponse, { type: "frame" }>;

const SOURCE = { width: 4000, height: 3000 };
const FRAME = { w: 1000, h: 800 };
const MAX_EDGE = 4096;

const CROP_STAGE = essentialStages().find((s) => s.id === "safelight.crop.geometry")!;
const REGION = "safelight.crop.geometry.uCrop";

class FakeBitmap {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  close() {}
}

/** What a frame was drawn from: the region the worker held and the window asked for. */
interface Drawn {
  crop: CropRect;
  roi: ImageWindow | null;
  width: number;
  height: number;
}

const regionOf = (v: unknown): CropRect =>
  Array.isArray(v) ? { x: v[0], y: v[1], width: v[2], height: v[3] } : WHOLE_IMAGE;

// The develop worker with its source resident on the GPU: every bindSource hits.
class SizingWorker {
  static instances: SizingWorker[] = [];
  posted: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  /** Each frame answered, in order. The canvas shows the last once the view is idle. */
  frames: Drawn[] = [];
  private derived: Record<string, unknown> = {};
  private viewport: { roi: ImageWindow | null; outW?: number; outH?: number } = { roi: null };
  private pending = new Map<number, Drawn>();

  constructor() {
    SizingWorker.instances.push(this);
  }

  postMessage(msg: WorkerRequest) {
    this.posted.push(msg);
    switch (msg.cmd) {
      case "init":
        queueMicrotask(() => this.reply({ type: "ready", pipelineFloat: true }));
        break;
      case "bindSource":
        queueMicrotask(() => this.reply({ type: "sourceBound", reqId: msg.reqId, hit: true }));
        break;
      case "setParams":
      case "setDerived":
        this.derived = msg.derived;
        break;
      case "patchParams":
        if (msg.derived) this.derived = msg.derived;
        break;
      case "setViewport":
        this.viewport = { roi: msg.roi, outW: msg.outW, outH: msg.outH };
        break;
      case "render":
        this.pending.set(msg.seq, this.size());
        break;
    }
  }

  // renderer.resize(), for the state the worker holds as the render reaches it.
  private size(): Drawn {
    const crop = regionOf(this.derived[REGION]);
    const cw = SOURCE.width * crop.width;
    const ch = SOURCE.height * crop.height;
    const { roi, outW, outH } = this.viewport;
    if (roi && outW && outH) {
      return {
        crop,
        roi,
        width: Math.min(Math.max(1, Math.round(outW)), Math.max(1, Math.round(cw * roi.w))),
        height: Math.min(Math.max(1, Math.round(outH)), Math.max(1, Math.round(ch * roi.h))),
      };
    }
    return { crop, roi: null, ...regionOutputSize(SOURCE.width, SOURCE.height, crop, MAX_EDGE) };
  }

  inFlight(): Render | undefined {
    return this.posted.find((m): m is Render => m.cmd === "render" && this.pending.has(m.seq));
  }

  answer(request: Render) {
    const drawn = this.pending.get(request.seq);
    if (!drawn) throw new Error(`render ${request.seq} isn't waiting`);
    this.pending.delete(request.seq);
    this.frames.push(drawn);
    const whole = regionOutputSize(SOURCE.width, SOURCE.height, drawn.crop, MAX_EDGE);
    const frame: Frame = {
      type: "frame",
      seq: request.seq,
      bitmap: new FakeBitmap(drawn.width, drawn.height) as unknown as ImageBitmap,
      width: drawn.width,
      height: drawn.height,
      sourceWidth: SOURCE.width,
      sourceHeight: SOURCE.height,
      sourceGen: 1,
      roi: drawn.roi,
      wholeWidth: whole.width,
      wholeHeight: whole.height,
      crop: drawn.crop,
    };
    this.reply(frame);
  }

  terminate() {}

  private reply(msg: WorkerResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

class FixedFrameObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: FRAME.w, height: FRAME.h } }] as never, this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const PHOTO: CatalogPhoto = {
  id: "p",
  filename: "p.orf",
  relPath: "p.orf",
  folder: "",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: SOURCE.width,
  height: SOURCE.height,
  fileSize: 1000,
  mimeType: "image/x-olympus-orf",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 0,
  dateImported: 0,
  exif: {},
} as CatalogPhoto;

/** Crop mode's view: the whole photo, padded, whatever the crop. */
const WIDE: CropRect = { x: -0.03, y: -0.03, width: 1.06, height: 1.06 };

/** A stand-in for Crop & Straighten's crop box: the crop drawn over the region
 *  the canvas shows, through the overlay's mapping. */
function Box({ rect }: { rect: OverlayRect }) {
  const crop = useDevelopStore((s) => s.params.crop);
  const { region } = useDevelopOverlay();
  if (!region) return null;
  const x = rect.x + ((crop.x - region.x) / region.width) * rect.w;
  const y = rect.y + ((crop.y - region.y) / region.height) * rect.h;
  return (
    <div
      data-testid="crop-box"
      style={{ left: x, top: y, width: (crop.width / region.width) * rect.w, height: (crop.height / region.height) * rect.h }}
    />
  );
}

const cropMode = () =>
  setCanvasTool("safelight.crop", {
    overlay: Box,
    zoomable: false,
    viewParams: (p: DevelopParams) => ({ ...p, crop: WIDE }),
  });

function Develop() {
  const [zoom, setZoom] = useState<number | null>(null);
  return <DevelopCanvas photo={PHOTO} zoom={zoom} onZoomChange={setZoom} />;
}

let frameQueue: Map<number, FrameRequestCallback>;
let commitEdit: Mock<(label: string) => Promise<void>>;
let canvasContext: PropertyDescriptor | undefined;
const OPEN_ZOOM = useSettings.getState().developOpenZoom;
const STORE_COMMIT = useDevelopStore.getState().commitEdit;

beforeEach(() => {
  SizingWorker.instances = [];
  vi.stubGlobal("Worker", SizingWorker);
  vi.stubGlobal("ResizeObserver", FixedFrameObserver);
  frameQueue = new Map();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    frameQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
  canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage: () => {}, clearRect: () => {} }),
  });
  commitEdit = vi.fn(async (_label: string) => {});
  const original: EditSnapshot = {
    timestamp: 0,
    label: "Original",
    params: DEFAULT_DEVELOP_PARAMS,
    paramBag: {},
  };
  useDevelopStore.setState({
    photoId: PHOTO.id,
    params: DEFAULT_DEVELOP_PARAMS,
    paramBag: {},
    history: [original],
    historyIndex: 0,
    histogram: null,
    sourceSize: { width: 0, height: 0, fullWidth: 0, fullHeight: 0, native: false },
    commitEdit,
  });
  registerProcessingStage("safelight.crop", CROP_STAGE);
  localStorage.clear();
});

afterEach(async () => {
  useCanvasToolStore.setState({ held: null });
  unregisterExtension("safelight.crop");
  useDevelopStore.setState({ commitEdit: STORE_COMMIT });
  useSettings.setState({ developOpenZoom: OPEN_ZOOM });
  disposeRenderBridge();
  vi.unstubAllGlobals();
  if (canvasContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
  }
});

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Runs the animation frames queued so far; the ones they queue wait. */
function runFrames(): number {
  const due = [...frameQueue.values()];
  frameQueue.clear();
  for (const cb of due) cb(performance.now());
  return due.length;
}

/** Animation frames run and the worker keeps up, until nothing more is asked of it. */
async function idle(worker: SizingWorker) {
  for (let i = 0; i < 50; i++) {
    let busy = false;
    await act(async () => {
      busy = runFrames() > 0;
      const request = worker.inFlight();
      if (request) {
        worker.answer(request);
        busy = true;
      }
      await settle();
    });
    if (!busy) return;
  }
  throw new Error("the view never went idle");
}

async function open() {
  const view = render(<Develop />);
  const worker = SizingWorker.instances.find((w) => w.posted.some((m) => m.cmd === "init"));
  if (!worker) throw new Error("no render worker");
  await idle(worker);
  return { ...view, worker };
}

const setCrop = (crop: CropRect) => act(() => useDevelopStore.getState().setParam("crop", crop));

const renders = (worker: SizingWorker, from: number) =>
  worker.posted.slice(from).filter((m) => m.cmd === "render");

const crop = () => useDevelopStore.getState().params.crop;

const px = (v: string) => parseFloat(v);

/** The develop canvas and where it shows the last frame: its box on screen, and the
 *  region of the transformed frame that frame holds. */
function shown(container: HTMLElement, worker: SizingWorker) {
  const canvas = container.querySelector<HTMLCanvasElement>("canvas:not([aria-hidden])");
  const frame = worker.frames.at(-1);
  if (!canvas || !frame) throw new Error("nothing shown");
  const m = /translate\((\S+)px, (\S+)px\) scale\(([^,)]+)(?:, ([^)]+))?\)/.exec(canvas.style.transform);
  if (!m) throw new Error(`not a placement: ${canvas.style.transform}`);
  const sx = Number(m[3]);
  const sy = m[4] === undefined ? sx : Number(m[4]);
  const box = {
    x: Number(m[1]),
    y: Number(m[2]),
    w: px(canvas.style.width) * sx,
    h: px(canvas.style.height) * sy,
  };
  const win = frame.roi ?? { x: 0, y: 0, w: 1, h: 1 };
  const holds = {
    x: frame.crop.x + win.x * frame.crop.width,
    y: frame.crop.y + win.y * frame.crop.height,
    w: win.w * frame.crop.width,
    h: win.h * frame.crop.height,
  };
  return { box, holds };
}

/** Where `rect` (transformed-frame coords) sits on the picture shown. */
function onPicture(container: HTMLElement, worker: SizingWorker, rect: CropRect) {
  const { box, holds } = shown(container, worker);
  return {
    x: box.x + ((rect.x - holds.x) / holds.w) * box.w,
    y: box.y + ((rect.y - holds.y) / holds.h) * box.h,
    w: (rect.width / holds.w) * box.w,
    h: (rect.height / holds.h) * box.h,
  };
}

function boxRect(el: HTMLElement) {
  return { x: px(el.style.left), y: px(el.style.top), w: px(el.style.width), h: px(el.style.height) };
}

// A 16:9 crop of the 4:3 photo, and others.
const SHAPES: [string, CropRect][] = [
  ["16:9", { x: 0.1, y: 0.2, width: 0.8, height: 0.6 }],
  ["3:2", { x: 0.1, y: 0.1, width: 0.6, height: 0.6 * (4 / 3) / 1.5 }],
  ["1:1", { x: 0.2, y: 0.1, width: 0.6, height: 0.8 }],
];

describe("frames of the photo's geometry", () => {
  it("are the region's own pixels, and carry the region", async () => {
    const { worker } = await open();
    await setCrop({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
    await idle(worker);
    expect(worker.frames.at(-1)).toMatchObject({ crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, width: 2000, height: 1500 });
  });

  it("are of the whole image without Crop & Straighten", async () => {
    unregisterExtension("safelight.crop");
    const { worker } = await open();
    await setCrop({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
    await idle(worker);
    expect(worker.frames.at(-1)).toMatchObject({ crop: WHOLE_IMAGE, width: 4000, height: 3000 });
  });
});

// Develop opening at 100% (Preferences), as the status bar's zoom also leaves it: the
// renderer draws only the window on screen, so no frame of the whole picture comes
// after leaving crop mode. Each window's frame says the size of the whole for the view
// to place it by; without it the view kept the shape of the crop-mode frame and
// stretched any crop of another shape.
describe("leaving crop mode while zoomed in", () => {
  beforeEach(() => {
    useSettings.setState({ developOpenZoom: "100" });
  });

  /** The picture's shape on screen against the shape of the pixels it holds. */
  function stretch(container: HTMLElement, worker: SizingWorker) {
    const { box, holds } = shown(container, worker);
    const held = (holds.w * SOURCE.width) / (holds.h * SOURCE.height);
    return box.w / box.h / held;
  }

  it.each(SHAPES)("shows a %s crop unstretched", async (_label, shape) => {
    const { worker, container } = await open();
    expect(worker.frames.at(-1)?.roi).not.toBeNull();
    await act(() => cropMode());
    await idle(worker);
    await setCrop(shape);
    await idle(worker);
    await act(() => setCanvasTool("safelight.crop", null));
    await idle(worker);

    expect(worker.frames.at(-1)?.roi).not.toBeNull();
    expect(stretch(container, worker)).toBeCloseTo(1, 2);
  });
});

// Crop mode draws the whole photo whatever the crop, so the picture doesn't change
// while the box moves. Each step of a drag still sent the worker a render (and with it
// the histogram's), so a slow GPU fell further behind with every move.
describe("moving the crop in crop mode", () => {
  it("redraws no frame of the photo, which doesn't change", async () => {
    const { worker } = await open();
    await act(() => cropMode());
    await idle(worker);
    const from = worker.posted.length;

    for (let i = 1; i <= 5; i++) {
      await setCrop({ x: 0.02 * i, y: 0.02 * i, width: 0.5, height: 0.5 });
      await idle(worker);
    }

    expect(crop()).not.toEqual(DEFAULT_CROP);
    expect(renders(worker, from)).toEqual([]);
  });
});

// A canvas tool's overlay is drawn over the picture on screen. Until the worker draws
// crop mode's whole-photo frame, that picture is the cropped one shown before.
describe("opening crop mode on a slow GPU", () => {
  it("never draws the box off the picture under it", async () => {
    const { worker, container } = await open();
    await setCrop({ x: 0.1, y: 0.1, width: 0.7, height: 0.6 });
    await idle(worker);

    await act(() => cropMode());
    const before = screen.queryByTestId("crop-box");
    if (before) {
      const want = onPicture(container, worker, crop());
      const got = boxRect(before);
      expect(got.x).toBeCloseTo(want.x, 0);
      expect(got.y).toBeCloseTo(want.y, 0);
      expect(got.w).toBeCloseTo(want.w, 0);
      expect(got.h).toBeCloseTo(want.h, 0);
    }

    await idle(worker);
    const after = screen.getByTestId("crop-box");
    expect(worker.frames.at(-1)?.crop).toEqual(WIDE);
    const want = onPicture(container, worker, crop());
    const got = boxRect(after);
    expect(got.x).toBeCloseTo(want.x, 0);
    expect(got.y).toBeCloseTo(want.y, 0);
    expect(got.w).toBeCloseTo(want.w, 0);
    expect(got.h).toBeCloseTo(want.h, 0);
  });
});

// An extension's canvas overlay maps the image to the screen through toScreen and its
// kin. Crop mode shows the whole image past the crop, so mapping through the crop put
// marks drawn on the photo off the picture.
describe("extension overlays in crop mode", () => {
  let seen: DevelopOverlayState | null = null;
  function Marks() {
    seen = useDevelopOverlay();
    return null;
  }

  beforeEach(() => {
    seen = null;
    registerSlot("test.marks", { id: "test.marks", slot: "develop-canvas-overlay", component: Marks });
  });
  afterEach(() => unregisterSlot("test.marks", "test.marks"));

  it("maps the image onto the picture the canvas shows", async () => {
    const { worker, container } = await open();
    await act(() => cropMode());
    await setCrop(SHAPES[0][1]);
    await idle(worker);

    const map = seen;
    if (!map?.toScreen || !map.toImage || !map.radiusToScreen) throw new Error("no mapping");
    expect(map.region).toEqual(WIDE);
    expect(map.imageAspect).toBeCloseTo(4 / 3, 6);
    const want = onPicture(container, worker, DEFAULT_CROP);
    const corner = map.toScreen(1, 1);
    expect(map.toScreen(0, 0).x).toBeCloseTo(want.x, 1);
    expect(map.toScreen(0, 0).y).toBeCloseTo(want.y, 1);
    expect(corner.x).toBeCloseTo(want.x + want.w, 1);
    expect(corner.y).toBeCloseTo(want.y + want.h, 1);
    expect(map.radiusToScreen(1)).toBeCloseTo(want.h, 1);
    const back = map.toImage(corner.x, corner.y);
    expect(back.x).toBeCloseTo(1, 4);
    expect(back.y).toBeCloseTo(1, 4);
  });
});
