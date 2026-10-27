// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The crop tool as a user drives it: the Crop & Straighten panel beside the real
// DevelopCanvas, over a render worker that sizes each frame the way the renderer
// does (renderer.resize: the drawn crop's pixels capped at the long edge, or the
// zoom window at the size asked for, never more pixels than the window holds). The
// worker answers only when a test lets it, as a slow GPU does. Issue #172 (Linux,
// Mesa): crops of another shape than the photo came out stretched, Free was very
// slow and could leave the box small and unusable, and the overlay grids didn't show.
//
// The photo is 4000×3000 (4:3) in a 1000×800 frame.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { CatalogPhoto, CropRect, DevelopParams, EditSnapshot } from "@/catalog/types";
import { DEFAULT_CROP, DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { useDevelopOverlay, type DevelopOverlayState } from "@/extensions/develop-host";
import { registerSlot, unregisterSlot } from "@/extensions/registry";
import { cropOutputSize } from "@/rendering/crop-transform";
import { disposeRenderBridge } from "@/rendering/render-bridge";
import type { WorkerRequest, WorkerResponse } from "@/rendering/render-worker";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
import type { ImageWindow } from "@/ui/viewport-view";
import { CROP_GUIDES, guideShapes } from "./crop-guides";
import { DevelopCanvas } from "./DevelopCanvas";
import { CropPanel } from "./panels/CropPanel";

vi.mock("libraw-wasm", () => ({ default: class {} }));

type Render = Extract<WorkerRequest, { cmd: "render" }>;
type Frame = Extract<WorkerResponse, { type: "frame" }>;

const SOURCE = { width: 4000, height: 3000 };
const FRAME = { w: 1000, h: 800 };
const MAX_EDGE = 4096;

class FakeBitmap {
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  close() {}
}

/** What a frame was drawn from: the crop the worker held and the window asked for. */
interface Drawn {
  crop: CropRect;
  roi: ImageWindow | null;
  width: number;
  height: number;
}

// The develop worker with its source resident on the GPU: every bindSource hits.
class SizingWorker {
  static instances: SizingWorker[] = [];
  posted: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  /** Each frame answered, in order. The canvas shows the last once the view is idle. */
  frames: Drawn[] = [];
  private params: DevelopParams | null = null;
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
        this.params = msg.params;
        break;
      case "patchParams":
        if (this.params) this.params = { ...this.params, ...msg.set } as DevelopParams;
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
    const crop = this.params?.crop ?? DEFAULT_CROP;
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
    return { crop, roi: null, ...cropOutputSize(SOURCE.width, SOURCE.height, crop, MAX_EDGE) };
  }

  inFlight(): Render | undefined {
    return this.posted.find((m): m is Render => m.cmd === "render" && this.pending.has(m.seq));
  }

  answer(request: Render) {
    const drawn = this.pending.get(request.seq);
    if (!drawn) throw new Error(`render ${request.seq} isn't waiting`);
    this.pending.delete(request.seq);
    this.frames.push(drawn);
    const whole = cropOutputSize(SOURCE.width, SOURCE.height, drawn.crop, MAX_EDGE);
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

function Develop() {
  const [zoom, setZoom] = useState<number | null>(null);
  return (
    <>
      <CropPanel />
      <DevelopCanvas photo={PHOTO} zoom={zoom} onZoomChange={setZoom} />
    </>
  );
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
  // Saving the edit and rebuilding its thumbnail aren't the crop tool's; each commit
  // is recorded instead.
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
    cropping: false,
    cropAspect: -1,
    constrainCrop: true,
    cropGuide: "thirds",
    cropGuideFlip: 0,
    commitEdit,
  });
  localStorage.clear();
});

afterEach(async () => {
  useDevelopStore.setState({ cropping: false, commitEdit: STORE_COMMIT });
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

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

async function startCropping(worker: SizingWorker) {
  await click("Crop & Straighten");
  await click("Crop");
  await idle(worker);
}

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
  const m = /translate\((\S+)px, (\S+)px\) scale\(([^,)]+)(?:, ([^)]+))?\)/.exec(
    canvas.style.transform,
  );
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

function cropBox(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[class~="border-white/80"]');
}

function boxRect(el: HTMLElement) {
  return {
    x: px(el.style.left),
    y: px(el.style.top),
    w: px(el.style.width),
    h: px(el.style.height),
  };
}

describe("choosing an aspect ratio", () => {
  it.each([
    ["3:2", 3 / 2],
    ["16:9", 16 / 9],
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["Original", 4 / 3],
  ])("draws the crop box at %s on screen", async (label, ratio) => {
    const { worker, container } = await open();
    await startCropping(worker);

    await click(label);
    await idle(worker);

    const box = cropBox(container);
    if (!box) throw new Error("no crop box");
    const { w, h } = boxRect(box);
    expect(w / h).toBeCloseTo(ratio, 2);
  });
});

// Develop opening at 100% (Preferences), as the status bar's zoom also leaves it: the
// renderer draws only the window on screen, so no frame of the whole picture comes
// after Done. Each window's frame says the size of the whole for the view to place it
// by; without it the view kept the shape of the crop-mode frame and stretched any crop
// of another shape. A crop of the photo's own shape (Original, 4:3 here) still matched.
describe("pressing Done while zoomed in", () => {
  beforeEach(() => {
    useSettings.setState({ developOpenZoom: "100" });
  });

  async function cropAndDone(label: string) {
    const view = await open();
    expect(view.worker.frames.at(-1)?.roi).not.toBeNull();
    await startCropping(view.worker);
    await click(label);
    await idle(view.worker);
    await click("Done");
    await idle(view.worker);
    return view;
  }

  /** The picture's shape on screen against the shape of the pixels it holds. */
  function stretch(container: HTMLElement, worker: SizingWorker) {
    const { box, holds } = shown(container, worker);
    const held = (holds.w * SOURCE.width) / (holds.h * SOURCE.height);
    return box.w / box.h / held;
  }

  it.each(["3:2", "16:9", "1:1"])("shows a %s crop unstretched", async (label) => {
    const { worker, container } = await cropAndDone(label);

    expect(worker.frames.at(-1)?.roi).not.toBeNull();
    expect(stretch(container, worker)).toBeCloseTo(1, 2);
  });

  it.each(["Original", "4:3"])(
    "shows a crop of the photo's own shape (%s) unstretched",
    async (label) => {
      const { worker, container } = await cropAndDone(label);

      expect(stretch(container, worker)).toBeCloseTo(1, 2);
    },
  );
});

// With Free chosen, as in the report; the default, Original, locks the ratio.
describe("dragging a Free crop box", () => {
  async function freeCrop(worker: SizingWorker) {
    await startCropping(worker);
    await click("Free");
    await idle(worker);
  }

  /** The crop overlay's own element, and the corner handle at the box's bottom right. */
  function corner(container: HTMLElement) {
    const box = cropBox(container);
    const overlay = box?.parentElement;
    if (!box || !overlay) throw new Error("no crop overlay");
    const r = boxRect(box);
    const centre = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    return { overlay, x: r.x + r.w, y: r.y + r.h, centre };
  }

  /** A pointer move over the overlay, with the left button held or not. */
  function move(overlay: HTMLElement, x: number, y: number, held: boolean) {
    fireEvent.pointerMove(overlay, { pointerId: 1, buttons: held ? 1 : 0, clientX: x, clientY: y });
  }

  // Crop mode draws the whole photo whatever the crop, so the picture doesn't change
  // while the box moves. Each step of a drag still sent the worker a render (and
  // with it the histogram's), so a slow GPU fell further behind with every move.
  it("redraws no frame of the photo, which doesn't change", async () => {
    const { worker, container } = await open();
    await freeCrop(worker);
    const { overlay, x, y } = corner(container);
    const from = worker.posted.length;

    fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, clientX: x, clientY: y });
    for (let i = 1; i <= 5; i++) {
      move(overlay, x - 20 * i, y - 15 * i, true);
      await idle(worker);
    }
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: x - 100, clientY: y - 75 });
    await idle(worker);

    expect(crop()).not.toEqual(DEFAULT_CROP);
    expect(renders(worker, from)).toEqual([]);
  });

  // A drag ends without its pointerup when the system takes the pointer: pointercancel,
  // or the capture lost to another window or a desktop gesture. The box went on
  // following the bare cursor with the dragged handle's cursor, and could shrink to
  // the smallest crop as the pointer wandered. Ended, a drag commits what it reached,
  // as a release does.
  it.each([
    ["the pointer is cancelled", (el: HTMLElement) => fireEvent.pointerCancel(el, { pointerId: 1 })],
    ["the capture is lost", (el: HTMLElement) => fireEvent.lostPointerCapture(el, { pointerId: 1 })],
  ])("stops resizing when %s, keeping the crop it reached", async (_label, end) => {
    const { worker, container } = await open();
    await freeCrop(worker);
    const { overlay, x, y } = corner(container);

    fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, clientX: x, clientY: y });
    move(overlay, x - 100, y - 80, true);
    await idle(worker);
    end(overlay);
    await idle(worker);
    const reached = crop();
    expect(reached).not.toEqual(DEFAULT_CROP);
    const { centre } = corner(container);

    move(overlay, centre.x, centre.y, false);
    await idle(worker);

    expect(crop()).toEqual(reached);
    expect(overlay.style.cursor).toBe("move");
    expect(commitEdit).toHaveBeenCalledWith("Crop");
  });

  // The browser lets the capture go after every pointerup, too.
  it("commits a release once, though the capture is let go after it", async () => {
    const { worker, container } = await open();
    await freeCrop(worker);
    const { overlay, x, y } = corner(container);

    fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, clientX: x, clientY: y });
    move(overlay, x - 100, y - 80, true);
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: x - 100, clientY: y - 80 });
    fireEvent.lostPointerCapture(overlay, { pointerId: 1 });
    await idle(worker);

    expect(commitEdit.mock.calls).toEqual([["Crop"]]);
  });
});

// The box is drawn over the picture on screen. Until the worker draws crop mode's
// whole-photo frame, that picture is the cropped one shown before.
describe("opening crop mode on a slow GPU", () => {
  it("never draws the crop box off the picture under it", async () => {
    const { worker, container } = await open();

    await click("Crop & Straighten");
    await click("Crop");
    const before = cropBox(container);
    if (before) {
      const want = onPicture(container, worker, crop());
      const got = boxRect(before);
      expect(got.x).toBeCloseTo(want.x, 0);
      expect(got.y).toBeCloseTo(want.y, 0);
      expect(got.w).toBeCloseTo(want.w, 0);
      expect(got.h).toBeCloseTo(want.h, 0);
    }

    await idle(worker);
    const after = cropBox(container);
    if (!after) throw new Error("no crop box once crop mode's frame is drawn");
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
    await startCropping(worker);
    await click("16:9");
    await idle(worker);

    const map = seen;
    if (!map?.toScreen || !map.toImage || !map.radiusToScreen) throw new Error("no mapping");
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

describe("the overlay grids", () => {
  it.each(CROP_GUIDES.map((g) => [g.label, g.id] as const))(
    "draws %s in the crop box from its button",
    async (label, id) => {
      const { worker, container } = await open();
      await startCropping(worker);

      await click(label);

      const box = cropBox(container);
      if (!box) throw new Error("no crop box");
      const { w, h } = boxRect(box);
      const want = guideShapes(id, w, h);
      expect(box.querySelectorAll("svg line")).toHaveLength(want.lines.length);
      expect(box.querySelectorAll("svg path")).toHaveLength(want.paths.length);
    },
  );
});
