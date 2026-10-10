// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Opening a photo in Develop shows its stored preview at once and swaps in the
// decoded source when it arrives. An edited photo's stored preview already has
// the edit in it (state/edited-thumbnail.ts), so it is drawn as it is, never
// rendered through the edit a second time: that double edit clipped every
// channel, which the histogram drew as white bars cut off at the top until the
// real source settled it. Nothing the worker renders before the photo's own
// source and edit are in place may reach the canvas or the histogram.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import type { CatalogPhoto, DevelopParams, EditSnapshot, Mask } from "@/catalog/types";
import { DEFAULT_DEVELOP_PARAMS, defaultMaskAdjustments } from "@/catalog/types";
import { editFingerprint } from "@/catalog/edit-fingerprint";
import type { HistogramData } from "@/rendering/histogram";
import { denoiseBag } from "@/rendering/webgl/builtin-denoise";
import { disposeRenderBridge, getRenderBridge } from "@/rendering/render-bridge";
import type { WorkerRequest, WorkerResponse } from "@/rendering/render-worker";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useSettings } from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import { registerGridFilter, useRegistry } from "@/extensions/registry";
import { NO_FILTER } from "@/modules/library/visible-photos";
import {
  loadPhotoImage,
  photoSourceKey,
  type DecodedImage,
  type Fallback,
} from "@/catalog/load-image";
import {
  acquireInstance,
  decodePoolSize,
  disposeDecodePool,
  releaseInstance,
  warmDecodePool,
} from "@/raw/decode-pool";
import { transformedViewCrop } from "@/rendering/crop-transform";
import { buildForwardTransform } from "@/rendering/transform";
import { ViewportImage, assessMatPx } from "@/ui/ViewportImage";
import { endHandover } from "@/ui/canvas-handover";
import { DevelopCanvas } from "@/modules/develop/DevelopCanvas";
import { useDevelopRenderer, useTierLabel } from "./use-develop-renderer";
import type { DevelopTier } from "./use-develop-renderer";

// Pass-through, so the options each load is asked with can be read back.
vi.mock("@/catalog/load-image", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/catalog/load-image")>();
  return { ...real, loadPhotoImage: vi.fn(real.loadPhotoImage) };
});

// The decode pool's instances are only tokens handed round here.
vi.mock("libraw-wasm", () => ({ default: class {} }));

type Render = Extract<WorkerRequest, { cmd: "render" }>;
type Frame = Extract<WorkerResponse, { type: "frame" }>;
type FrameSource = Pick<Frame, "sourceWidth" | "sourceHeight" | "sourceGen">;
type SourceImage = Extract<WorkerRequest, { cmd: "setImage" }>["image"];

// Like the worker, answers frameSkipped, in the order posted, to each render it has
// nothing to draw from: after clearSource, until a source is set, uploaded and bound,
// or bound from the cache. The renders it could draw are the test's to answer, and the
// bridge sends the next only once the one in flight is answered. `holding` keeps the
// worker's own answers back until `release()`. Each source it is handed gets the next
// number, and a render it could draw is drawn from the source it holds when it comes.
// A source it can't take is numbered too, answered sourceError, and leaves it nothing
// to draw from. Like the renderer, after an upload that doesn't bind (a neighbour decoded
// ahead) it binds back only a source it held under a key: one set with setImage leaves
// the upload bound in its place, and frames draw from that.
class FakeWorker {
  static instances: FakeWorker[] = [];
  /** Whether bindSource finds the photo resident; the test's sourceBound reply agrees. */
  static hits = false;
  /** The size of the photo's resident source. */
  static residentSize = { width: 0, height: 0 };
  /** The ways of handing over a source that fail, as an upload that throws does. */
  static failing = new Set<"setImage" | "uploadSource">();
  /** When set, the GPU source cache by key, in place of `hits`: a main upload puts its
   *  key in, and bindSource finds what was put in. */
  static cache: Set<string> | null = null;
  /** Under `cache`, whether each bindSource found its key, by reqId. */
  readonly bindHits = new Map<number, boolean>();
  posted: WorkerRequest[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  holding = false;
  private bound = false;
  /** The key the bound source is held under; null for one set with setImage. */
  private boundKey: string | null = null;
  private held: WorkerResponse[] = [];
  private answered = new Set<number>();
  private source: FrameSource = { sourceWidth: 0, sourceHeight: 0, sourceGen: 0 };
  private drawnFrom = new Map<number, FrameSource>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: WorkerRequest) {
    this.posted.push(msg);
    if (msg.cmd === "clearSource") this.bound = false;
    if (msg.cmd === "setImage") this.take(msg.cmd, msg.image, null);
    if (msg.cmd === "uploadSource" && msg.target === "main" && msg.bind !== false) {
      this.take(msg.cmd, msg.image, msg.key);
    }
    if (msg.cmd === "uploadSource" && msg.target === "main" && msg.bind === false) {
      if (this.boundKey === null) this.slipIn(msg.image);
    }
    if (msg.cmd === "uploadSource" && msg.target === "main" && !FakeWorker.failing.has(msg.cmd)) {
      FakeWorker.cache?.add(msg.key);
    }
    // A bitmap posted to a worker is transferred: the main thread holds it no longer.
    if ((msg.cmd === "setImage" || msg.cmd === "uploadSource") && msg.image.kind === "bitmap") {
      msg.image.bitmap.close();
    }
    if (msg.cmd === "bindSource") {
      const hit = FakeWorker.cache ? FakeWorker.cache.has(msg.key) : FakeWorker.hits;
      this.bindHits.set(msg.reqId, hit);
      if (hit) {
        this.hold(FakeWorker.residentSize);
        this.boundKey = msg.key;
      }
    }
    if (msg.cmd === "render") {
      if (this.bound) this.drawnFrom.set(msg.seq, this.source);
      else this.skip(msg.seq);
    }
  }

  private take(cmd: "setImage" | "uploadSource", image: SourceImage, key: string | null) {
    if (!FakeWorker.failing.has(cmd)) {
      this.hold(image);
      this.boundKey = key;
      return;
    }
    this.bound = false;
    this.source = { ...this.source, sourceGen: this.source.sourceGen + 1 };
    const { sourceGen } = this.source;
    this.answer({ type: "sourceError", sourceGen, message: "texImage2D failed" });
  }

  /** A non-binding upload over a source held under no key stays bound: frames draw from it,
   *  numbered as the source before, since nothing told the bridge. */
  private slipIn(image: SourceImage) {
    const size = image.kind === "bitmap" ? image.bitmap : image;
    this.source = { ...this.source, sourceWidth: size.width, sourceHeight: size.height };
  }

  private hold(image: SourceImage | { width: number; height: number }) {
    const size = "kind" in image && image.kind === "bitmap" ? image.bitmap : image;
    this.bound = true;
    this.source = {
      sourceWidth: size.width,
      sourceHeight: size.height,
      sourceGen: this.source.sourceGen + 1,
    };
  }

  /** What the frame answering render `seq` says it was drawn from. */
  sourceOf(seq: number): FrameSource {
    return this.drawnFrom.get(seq) ?? { sourceWidth: 0, sourceHeight: 0, sourceGen: 0 };
  }

  private skip(seq: number) {
    this.answered.add(seq);
    this.answer({ type: "frameSkipped", seq });
  }

  private answer(msg: WorkerResponse) {
    if (this.holding) this.held.push(msg);
    else queueMicrotask(() => this.reply(msg));
  }

  /** Sends the answers held back. */
  release() {
    const held = this.held;
    this.held = [];
    for (const answer of held) this.reply(answer);
  }

  /** The render it could draw that no answer has gone to yet. */
  inFlight(): Render | undefined {
    return this.posted.find((m): m is Render => m.cmd === "render" && !this.answered.has(m.seq));
  }

  terminate() {}

  reply(msg: WorkerResponse) {
    if (msg.type === "frame" || msg.type === "frameSkipped" || msg.type === "renderError") {
      this.answered.add(msg.seq);
    }
    this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>);
  }
}

class FakeBitmap {
  /** Every bitmap made in the test; each must end up closed (or transferred). */
  static made: FakeBitmap[] = [];
  readonly width: number;
  readonly height: number;
  closed = false;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    FakeBitmap.made.push(this);
  }

  close() {
    this.closed = true;
  }
}

const THUMB = new Blob(["stored preview"], { type: "image/jpeg" });
// The stored preview decodes small; the photo's own source, its original, decodes at
// full size.
const PREVIEW_SIZE = { width: 640, height: 427 };
const SOURCE_SIZE = { width: 6000, height: 4000 };

/** A readable original named `name`. */
function original(name: string): FileSystemFileHandle {
  const file = new File(["original"], name);
  return { kind: "file", name, getFile: async () => file } as FileSystemFileHandle;
}

let decoded: FakeBitmap[];
let holdSource: Promise<void> | null;
/** What was drawn on the develop canvas, in order (not the fade overlay's copies). */
let drawn: unknown[];
/** A draw or clear on a canvas, with the canvas's CSS width and pixel width then. */
interface Paint {
  canvas: HTMLCanvasElement;
  op: "draw" | "clear";
  image?: unknown;
  box: string;
  width: number;
}
/** Every draw and clear on any canvas, in order. */
let paints: Paint[];
let canvasContext: PropertyDescriptor | undefined;

function photo(over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  return {
    id: "next",
    filename: "next.jpg",
    relPath: "next.jpg",
    folder: "",
    directoryHandle: null,
    fileHandle: original("next.jpg"),
    thumbnailBlob: THUMB,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1000,
    mimeType: "image/jpeg",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    // The stored preview shows the edit the store holds for the photo (beforeEach).
    previewEdit: editFingerprint(edit(0.5), {}),
    ...over,
  };
}

let status: ReturnType<typeof useDevelopRenderer> | null = null;

function Develop({ subject }: { subject: CatalogPhoto }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fade = useRef<HTMLCanvasElement>(null);
  status = useDevelopRenderer(canvas, subject, fade);
  return (
    <>
      <canvas ref={canvas} />
      <canvas ref={fade} data-fade="" />
    </>
  );
}

const fadeCanvas = (): HTMLCanvasElement | null => document.querySelector("canvas[data-fade]");

/** The viewport's frame: jsdom lays nothing out, so every frame is 1000×800. */
class FixedFrameObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(): void {
    this.cb([{ contentRect: { width: 1000, height: 800 } }] as never, this as never);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const edit = (exposure: number): DevelopParams => ({ ...DEFAULT_DEVELOP_PARAMS, exposure });

/** The develop store once photo `id`'s edit has loaded: an Original, then `steps`,
 *  with the history cursor on the last. */
function loaded(id: string, ...steps: DevelopParams[]) {
  const snapshot = (label: string, params: DevelopParams): EditSnapshot => ({
    timestamp: 0,
    label,
    params,
    paramBag: {},
  });
  const history = [
    snapshot("Original", DEFAULT_DEVELOP_PARAMS),
    ...steps.map((params) => snapshot("Edit", params)),
  ];
  return {
    photoId: id,
    params: history[history.length - 1].params,
    paramBag: {},
    history,
    historyIndex: history.length - 1,
  };
}

function histogram(): HistogramData {
  const bins = () => new Uint32Array(256).fill(9);
  return { r: bins(), g: bins(), b: bins(), luma: bins() };
}

function renderWorker(): FakeWorker {
  const worker = FakeWorker.instances.find((w) => w.posted.some((m) => m.cmd === "init"));
  if (!worker) throw new Error("no render worker");
  return worker;
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Answers every bindSource the worker hasn't answered yet: with `hit`, or with what
 *  the worker's cache holds when it has one (FakeWorker.cache). */
function answerBinds(worker: FakeWorker, hit: boolean, answered: Set<number>) {
  for (const msg of worker.posted) {
    if (msg.cmd !== "bindSource" || answered.has(msg.reqId)) continue;
    answered.add(msg.reqId);
    const found = FakeWorker.cache ? (worker.bindHits.get(msg.reqId) ?? false) : hit;
    worker.reply({ type: "sourceBound", reqId: msg.reqId, hit: found });
  }
}

/** The worker's frame for `request`, carrying the histogram it asked for. */
function frameFor(request: Render, size = { width: 10, height: 10 }): WorkerResponse {
  return {
    type: "frame",
    seq: request.seq,
    bitmap: new FakeBitmap(size.width, size.height),
    width: size.width,
    height: size.height,
    ...renderWorker().sourceOf(request.seq),
    ...(request.wantHistogram ? { histogram: histogram() } : {}),
  };
}

/** The worker catching up: answers the render in flight with its frame, then each
 *  one the bridge sends after it, until none is left. */
async function answerRenders(worker: FakeWorker, size?: { width: number; height: number }) {
  await act(async () => {
    for (let request = worker.inFlight(); request; request = worker.inFlight()) {
      worker.reply(frameFor(request, size));
      await Promise.resolve();
    }
  });
}

async function open(subject: CatalogPhoto, hit = false, View = Develop, strict = false) {
  FakeWorker.hits = hit;
  const view = render(<View subject={subject} />, strict ? { wrapper: StrictMode } : undefined);
  const worker = renderWorker();
  const answered = new Set<number>();
  const progress = async () => {
    await act(async () => {
      answerBinds(worker, hit, answered);
      await settle();
      answerBinds(worker, hit, answered);
      await settle();
    });
  };
  await act(async () => {
    worker.reply({ type: "ready", pipelineFloat: true });
    await settle();
  });
  await progress();
  return {
    worker,
    progress,
    rerender: view.rerender,
    unmount: view.unmount,
    container: view.container,
  };
}

/** Index of the first message from `from` on that hands the develop renderer a source. */
function sourceIndex(worker: FakeWorker, hit: boolean, from = 0): number {
  return worker.posted.findIndex(
    (m, i) =>
      i >= from &&
      (hit
        ? m.cmd === "bindSource"
        : (m.cmd === "uploadSource" && m.target === "main" && m.bind !== false) ||
          m.cmd === "setImage"),
  );
}

/** The params the worker holds when it handles the message at `index`: the last whole
 *  params posted before it, with the patches posted since merged in. */
function paramsAt(worker: FakeWorker, index: number): DevelopParams | undefined {
  let held: DevelopParams | undefined;
  for (const m of worker.posted.slice(0, index)) {
    if (m.cmd === "setParams") held = m.params;
    if (m.cmd === "patchParams" && held) {
      held = { ...held, ...m.set };
      for (const key of m.remove) Reflect.deleteProperty(held, key);
    }
  }
  return held;
}

/** The stage bag the worker holds when it handles the message at `index`, built the
 *  same way from the whole bags and patches posted before it. */
function bagAt(worker: FakeWorker, index: number): Record<string, unknown> | undefined {
  let held: Record<string, unknown> | undefined;
  for (const m of worker.posted.slice(0, index)) {
    if (m.cmd === "setContributedParams") held = m.bag;
    if (m.cmd === "patchContributedParams") {
      held = { ...held, ...m.set };
      for (const key of m.remove) delete held[key];
    }
  }
  return held;
}

/** The sources handed to the develop renderer, in order: "setImage", or "upload <key>"
 *  with " bind=false" for one that doesn't bind it. */
function sourceMessages(worker: FakeWorker): string[] {
  return worker.posted.flatMap((m) => {
    if (m.cmd === "setImage") return ["setImage"];
    if (m.cmd !== "uploadSource" || m.target !== "main") return [];
    return [`upload ${m.key}${m.bind === false ? " bind=false" : ""}`];
  });
}

/** The keys of the non-binding uploads posted while the develop renderer held a source
 *  under no key, which the renderer leaves bound in that source's place. */
function uploadsOverUnkeyed(worker: FakeWorker): string[] {
  let keyed = true;
  const found: string[] = [];
  for (const m of worker.posted) {
    if (m.cmd === "setImage") keyed = false;
    if (m.cmd === "bindSource" && worker.bindHits.get(m.reqId)) keyed = true;
    if (m.cmd !== "uploadSource" || m.target !== "main") continue;
    if (m.bind !== false) keyed = true;
    else if (!keyed) found.push(m.key);
  }
  return found;
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.hits = false;
  FakeWorker.residentSize = { width: 0, height: 0 };
  FakeWorker.failing = new Set();
  FakeWorker.cache = null;
  vi.mocked(loadPhotoImage).mockClear();
  decoded = [];
  holdSource = null;
  drawn = [];
  paints = [];
  FakeBitmap.made = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("ImageBitmap", FakeBitmap);
  vi.stubGlobal("createImageBitmap", async () => {
    const first = decoded.length === 0;
    if (!first && holdSource) await holdSource;
    const size = first ? PREVIEW_SIZE : SOURCE_SIZE;
    const bitmap = new FakeBitmap(size.width, size.height);
    decoded.push(bitmap);
    return bitmap;
  });
  canvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: function getContext(this: HTMLCanvasElement) {
      const canvas = this;
      const note = (op: "draw" | "clear", image?: unknown) =>
        paints.push({ canvas, op, image, box: canvas.style.width, width: canvas.width });
      return {
        drawImage: (image: unknown) => {
          if (!canvas.hasAttribute("data-fade")) drawn.push(image);
          note("draw", image);
        },
        clearRect: () => note("clear"),
      };
    },
  });
  useDevelopStore.setState({
    ...loaded("next", edit(0.5)),
    histogram: null,
    sourceSize: { width: 0, height: 0 },
  });
});

// Each bitmap holds a decoded image's memory until closed: one the view drops without
// closing stays allocated until garbage collection, a few MB per photo passed.
afterEach(async () => {
  cleanup();
  await settle();
  const leaked = FakeBitmap.made.filter((b) => !b.closed);
  disposeRenderBridge();
  vi.unstubAllGlobals();
  useCatalogStore.setState({ photos: [] });
  useRegistry.setState({ gridFilters: {} });
  if (canvasContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", canvasContext);
  }
  expect(leaked).toEqual([]);
});

describe("useDevelopRenderer opening a photo", () => {
  it("tells the worker the previous source is gone before anything renders", () => {
    render(<Develop subject={photo()} />);
    const cmds = renderWorker().posted.map((m) => m.cmd);
    expect(cmds).toContain("clearSource");
    expect(cmds.slice(0, cmds.indexOf("clearSource"))).not.toContain("render");
  });

  it("draws the stored preview as it is, without rendering the edit into it again", async () => {
    const { worker } = await open(photo());
    expect(drawn[0]).toBe(decoded[0]);
    expect(worker.posted.filter((m) => m.cmd === "setImage")).toEqual([]);
  });

  // The size is the one the frame reports: the renderer's own, which caps what it is sent,
  // and which the drawn transform's aspect comes from.
  it("keeps the photo's own aspect until a frame of its source is drawn", async () => {
    let release = () => {};
    holdSource = new Promise<void>((r) => (release = r));
    const { worker, progress } = await open(photo());
    expect(drawn).toHaveLength(1);
    expect(useDevelopStore.getState().sourceSize).toEqual({ width: 0, height: 0 });

    release();
    await progress();
    expect(useDevelopStore.getState().sourceSize).toEqual({ width: 0, height: 0 });

    await answerRenders(worker);
    expect(useDevelopStore.getState().sourceSize).toEqual(SOURCE_SIZE);
    expect(status).toMatchObject({
      sourceWidth: SOURCE_SIZE.width,
      sourceHeight: SOURCE_SIZE.height,
    });
  });

  it("starts the histogram fresh instead of showing the previous photo's", () => {
    useDevelopStore.setState({ histogram: histogram() });
    render(<Develop subject={photo()} />);
    expect(useDevelopStore.getState().histogram).toBeNull();
  });

  it("ignores a frame and histogram still in flight from the previous photo", async () => {
    render(<Develop subject={photo()} />);
    const worker = renderWorker();
    const stale = new FakeBitmap(10, 10);
    await act(async () => {
      worker.reply({
        type: "frame",
        seq: 0,
        bitmap: stale,
        width: 10,
        height: 10,
        sourceWidth: 3000,
        sourceHeight: 2000,
        sourceGen: 7,
        histogram: histogram(),
      });
      worker.reply({ type: "histogram", histogram: histogram() });
      await settle();
    });
    expect(drawn).not.toContain(stale);
    expect(useDevelopStore.getState().histogram).toBeNull();
    expect(useDevelopStore.getState().sourceSize).toEqual({ width: 0, height: 0 });
    expect(status?.tier).not.toBe("final");
  });

  it("prefetches the neighbours the grid shows, past photos an extension filters out", async () => {
    const shot = (id: string) => photo({ id, filename: `${id}.jpg`, relPath: `${id}.jpg` });
    useCatalogStore.setState({ photos: [shot("a"), shot("b"), shot("c")] });
    useUIStore.setState({
      filter: NO_FILTER,
      sortField: "filename",
      sortDirection: "asc",
      activeFolder: null,
    });
    registerGridFilter("search", { id: "search.text", test: (p) => p.id !== "b" });
    useDevelopStore.setState({ photoId: "a" });

    const { worker } = await open(shot("a"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    const asked = worker.posted.flatMap((m) => (m.cmd === "hasSource" ? [m.key] : []));
    expect(asked[0]).toBe("c:0");
    expect(asked).not.toContain("b:0");
  });

  it("decodes a neighbour as background work, behind any photo being opened", async () => {
    const shot = (id: string) => photo({ id, filename: `${id}.jpg`, relPath: `${id}.jpg` });
    useCatalogStore.setState({ photos: [shot("a"), shot("b")] });
    useUIStore.setState({
      filter: NO_FILTER,
      sortField: "filename",
      sortDirection: "asc",
      activeFolder: null,
    });
    useDevelopStore.setState({ photoId: "a" });

    const { worker } = await open(shot("a"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      for (const m of worker.posted) {
        if (m.cmd === "hasSource") worker.reply({ type: "hasSource", reqId: m.reqId, has: false });
      }
      await settle();
    });
    const loads = vi.mocked(loadPhotoImage).mock.calls;
    const opened = loads.find(([p]) => p.id === "a");
    const neighbour = loads.find(([p]) => p.id === "b");
    expect(opened).toBeDefined();
    expect(neighbour).toBeDefined();
    expect(opened?.[1]?.background).toBeFalsy();
    expect(neighbour?.[1]).toMatchObject({ background: true });
  });

  describe.each([
    ["decoded", false],
    ["already on the GPU", true],
  ])("with its source %s", (_label, hit) => {
    it("renders it with its own edit, not the previous photo's", async () => {
      useDevelopStore.setState({ photoId: "previous", params: edit(3) });
      const { worker, progress } = await open(photo(), hit);

      await act(async () => {
        useDevelopStore.setState({ photoId: "next", params: edit(0.5) });
      });
      await progress();

      const source = sourceIndex(worker, hit);
      expect(source).toBeGreaterThanOrEqual(0);
      const firstRender = worker.posted.findIndex((m, i) => i > source && m.cmd === "render");
      expect(firstRender).toBeGreaterThan(source);
      expect(paramsAt(worker, firstRender)?.exposure).toBe(0.5);
    });
  });
});

// The stored preview is the photo's look only while it shows the edit Develop opens
// with. Paste Settings, Update processing and extensions change a stored edit without
// a new preview, and rebuilding the previews puts one without any edit over an edited
// one. A preview that doesn't show the edit is left out: the decode's own frames come
// soon after, and the image doesn't change look under the user.
describe("useDevelopRenderer drawing the stored preview first", () => {
  const SHOWS_EDIT = editFingerprint(edit(0.5), {});

  afterEach(() => {
    status = null;
  });

  it("draws a preview of the edit the photo opens with", async () => {
    useDevelopStore.setState(loaded("next", edit(0.5)));
    await open(photo({ previewEdit: SHOWS_EDIT }));
    expect(drawn).toEqual([decoded[0]]);
    expect(status?.tier).toBe("stored");
  });

  it("leaves out a preview of the edit before one pasted onto it", async () => {
    useDevelopStore.setState(loaded("next", edit(0.5), edit(1.5)));
    await open(photo({ previewEdit: SHOWS_EDIT }));
    expect(drawn).toEqual([]);
    expect(status?.tier).toBeNull();
  });

  it("leaves out a preview of the same adjustments with other extension settings", async () => {
    useDevelopStore.setState({ ...loaded("next", edit(0.5)), paramBag: { "ext.film.grain": 0.3 } });
    await open(photo({ previewEdit: SHOWS_EDIT }));
    expect(drawn).toEqual([]);
  });

  it("draws a preview without any edit of a photo that has none", async () => {
    useDevelopStore.setState(loaded("next"));
    await open(photo({ previewEdit: undefined }));
    expect(drawn).toEqual([decoded[0]]);
    expect(status?.tier).toBe("stored");
  });

  it("leaves out a preview without any edit of an edited photo", async () => {
    useDevelopStore.setState(loaded("next", edit(0.5)));
    await open(photo({ previewEdit: undefined }));
    expect(drawn).toEqual([]);
    expect(status?.tier).toBeNull();
  });

  it("goes by the photo's own edit, not the one open before it", async () => {
    useDevelopStore.setState(loaded("previous", edit(0.5)));
    await open(photo({ previewEdit: SHOWS_EDIT }));
    expect(drawn).toEqual([]);

    await act(async () => {
      useDevelopStore.setState(loaded("next", edit(0.5), edit(1.5)));
      await settle();
    });
    expect(drawn).toEqual([]);
  });

  it("draws the preview once the photo's own edit has loaded and matches it", async () => {
    useDevelopStore.setState(loaded("previous", edit(3)));
    await open(photo({ previewEdit: SHOWS_EDIT }));
    expect(drawn).toEqual([]);

    await act(async () => {
      useDevelopStore.setState(loaded("next", edit(0.5)));
      await settle();
    });
    expect(drawn).toEqual([decoded[0]]);
    expect(status?.tier).toBe("stored");
  });

  it("still shows the decoded source of a photo whose preview was left out", async () => {
    useDevelopStore.setState(loaded("next", edit(0.5), edit(1.5)));
    const { worker } = await open(photo({ previewEdit: SHOWS_EDIT }));
    await answerRenders(worker);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).not.toBe(decoded[0]);
    expect(status?.tier).toBe("final");
  });
});

// What the canvas shows of the open photo, and the source size the crop and transform
// work from, come from the frames drawn. A source still resident on the GPU is drawn
// without being sent again, so no frame of it reported its size before.
describe("useDevelopRenderer telling what it shows", () => {
  // Stored the sensor's way round; the source on the GPU was decoded upright.
  const RESIDENT = { width: 4000, height: 6000 };
  const CAMERA_PREVIEW = { width: 1620, height: 1080 };

  beforeEach(() => {
    FakeWorker.residentSize = RESIDENT;
  });

  afterEach(() => {
    status = null;
  });

  /** The next load paints the camera's preview, then returns the full image once
   *  `finish` is called. */
  function loadWithCameraPreview(): () => void {
    let finish = () => {};
    const finished = new Promise<void>((r) => (finish = r));
    vi.mocked(loadPhotoImage).mockImplementationOnce(async (_photo, opts) => {
      const { width, height } = CAMERA_PREVIEW;
      opts?.onPreview?.({ kind: "bitmap", bitmap: new FakeBitmap(width, height) });
      await finished;
      return { kind: "bitmap", bitmap: new FakeBitmap(SOURCE_SIZE.width, SOURCE_SIZE.height) };
    });
    return finish;
  }

  it("publishes the size of a source still resident on the GPU", async () => {
    const { worker } = await open(photo(), true);
    await answerRenders(worker);
    expect(useDevelopStore.getState().sourceSize).toEqual(RESIDENT);
    expect(status).toMatchObject({ sourceWidth: RESIDENT.width, sourceHeight: RESIDENT.height });
  });

  it.each([
    ["decoded", false],
    ["already on the GPU", true],
  ])("shows the stored preview, then the source %s", async (_label, hit) => {
    const { worker } = await open(photo(), hit);
    expect(status?.tier).toBe("stored");
    await answerRenders(worker);
    expect(status?.tier).toBe("final");
  });

  it("shows the stored preview, then the camera's preview, then the decoded source", async () => {
    const finish = loadWithCameraPreview();
    const { worker, progress } = await open(photo());
    expect(status?.tier).toBe("stored");

    await answerRenders(worker);
    expect(status?.tier).toBe("preview");
    expect(useDevelopStore.getState().sourceSize).toEqual(CAMERA_PREVIEW);

    await act(async () => finish());
    await progress();
    expect(status?.tier).toBe("preview");

    await answerRenders(worker);
    expect(status?.tier).toBe("final");
    expect(useDevelopStore.getState().sourceSize).toEqual(SOURCE_SIZE);
  });

  it("knows a frame of the camera's preview that comes back after the decoded source went", async () => {
    const finish = loadWithCameraPreview();
    const { worker, progress } = await open(photo());
    const drawingPreview = worker.inFlight();
    if (!drawingPreview) throw new Error("no render in flight");

    await act(async () => finish());
    await progress();
    await act(async () => worker.reply(frameFor(drawingPreview)));
    expect(status?.tier).toBe("preview");
    expect(useDevelopStore.getState().sourceSize).toEqual(CAMERA_PREVIEW);

    await answerRenders(worker);
    expect(status?.tier).toBe("final");
  });

  it("starts over on the next photo, whatever comes back late from the one before", async () => {
    const shot = (id: string) => photo({ id, filename: `${id}.jpg`, relPath: `${id}.jpg` });
    useDevelopStore.setState({ photoId: "a" });
    const { worker, rerender } = await open(shot("a"), true);
    await answerRenders(worker);
    expect(status?.tier).toBe("final");
    act(() => getRenderBridge().render(false));
    const late = worker.inFlight();
    if (!late) throw new Error("no render in flight");
    const answered = new Set(worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])));

    // The next photo has no stored preview, and isn't on the GPU.
    FakeWorker.hits = false;
    const finish = loadWithCameraPreview();
    await act(async () => {
      useDevelopStore.setState({ photoId: "b" });
      rerender(<Develop subject={{ ...shot("b"), thumbnailBlob: null }} />);
      await settle();
    });
    await act(async () => worker.reply(frameFor(late)));
    expect(status?.tier).toBeNull();
    expect(useDevelopStore.getState().sourceSize).toEqual({ width: 0, height: 0 });

    await act(async () => {
      answerBinds(worker, false, answered);
      await settle();
    });
    await answerRenders(worker);
    expect(status?.tier).toBe("preview");
    expect(useDevelopStore.getState().sourceSize).toEqual(CAMERA_PREVIEW);

    await act(async () => {
      finish();
      await settle();
    });
    await answerRenders(worker);
    expect(status?.tier).toBe("final");
    expect(useDevelopStore.getState().sourceSize).toEqual(SOURCE_SIZE);
  });

  // The decode failed or was turned down, and the load settled on the camera's own
  // preview: what shows is still a preview, however long it stays.
  describe("when the load settles on a preview", () => {
    const raw = (id: string) => photo({ id, filename: `${id}.nef`, relPath: `${id}.nef` });

    /** The next load returns the camera's embedded JPEG, as 8-bit, of a RAW the decoder
     *  can't use: the one fallback kept on the GPU under the photo's key. */
    function settlesOnEmbeddedJpeg() {
      vi.mocked(loadPhotoImage).mockImplementationOnce(async () => ({
        kind: "bitmap",
        bitmap: new FakeBitmap(CAMERA_PREVIEW.width, CAMERA_PREVIEW.height),
        fallback: { from: "embedded", offline: false, unsupported: true, timedOut: false },
      }));
    }

    it("calls a preview the decoder handed back as one a preview", async () => {
      vi.mocked(loadPhotoImage).mockImplementationOnce(async () => ({
        kind: "float",
        data: new Float32Array(24),
        width: 3,
        height: 2,
        isFallbackPreview: true,
      }));
      const { worker } = await open(raw("next"));
      await answerRenders(worker);
      expect(status?.tier).toBe("preview");
    });

    it("calls a RAW photo's embedded JPEG a preview", async () => {
      settlesOnEmbeddedJpeg();
      const { worker } = await open(raw("next"));
      await answerRenders(worker);
      expect(status?.tier).toBe("preview");
    });

    it("still calls it a preview when the photo opens again from the GPU", async () => {
      settlesOnEmbeddedJpeg();
      const { worker } = await open(raw("next"));
      await answerRenders(worker);
      const answered = new Set(
        worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
      );

      cleanup();
      FakeWorker.hits = true;
      render(<Develop subject={raw("next")} />);
      await act(async () => {
        await settle();
        answerBinds(worker, true, answered);
        await settle();
      });
      await answerRenders(worker);
      expect(status?.tier).toBe("preview");
    });

    it("still calls it a preview when it was decoded ahead as a neighbour", async () => {
      useCatalogStore.setState({ photos: [raw("a"), raw("b")] });
      useUIStore.setState({
        filter: NO_FILTER,
        sortField: "filename",
        sortDirection: "asc",
        activeFolder: null,
      });
      useDevelopStore.setState({ photoId: "a" });
      vi.mocked(loadPhotoImage).mockImplementationOnce(async () => ({
        kind: "float",
        data: new Float32Array(24),
        width: 3,
        height: 2,
      }));
      settlesOnEmbeddedJpeg();
      const { worker, rerender } = await open(raw("a"));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
        for (const m of worker.posted) {
          if (m.cmd === "hasSource") {
            worker.reply({ type: "hasSource", reqId: m.reqId, has: false });
          }
        }
        await settle();
      });
      expect(vi.mocked(loadPhotoImage).mock.calls.map(([p]) => p.id)).toEqual(["a", "b"]);
      const answered = new Set(
        worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
      );

      FakeWorker.hits = true;
      await act(async () => {
        useDevelopStore.setState({ photoId: "b" });
        rerender(<Develop subject={raw("b")} />);
        await settle();
      });
      await act(async () => {
        answerBinds(worker, true, answered);
        await settle();
      });
      await answerRenders(worker);
      expect(status?.tier).toBe("preview");
    });
  });
});

// The GPU keeps each source it is handed under the photo's key, and a later open of the
// photo binds it from there without loading anything. A fallback kept there would stand
// in for the photo for the rest of the session, so only the photo's own pixels go there,
// and the camera's preview of a RAW the decoder can't use, which nothing would better.
describe("useDevelopRenderer keeping fallbacks out of the GPU's source cache", () => {
  const raw = photo({ filename: "next.nef", relPath: "next.nef" });
  const key = photoSourceKey(raw);

  /** The next load settles on the camera's preview of the RAW, for `why`. */
  function settlesOnCameraPreview(why: Partial<Fallback>) {
    vi.mocked(loadPhotoImage).mockImplementationOnce(async () => ({
      kind: "bitmap",
      bitmap: new FakeBitmap(1620, 1080),
      fallback: { from: "embedded", offline: false, unsupported: false, timedOut: false, ...why },
    }));
  }

  /** The view is closed, and the photo opened again in a new one. */
  async function openAgain(subject: CatalogPhoto, worker: FakeWorker) {
    const answered = new Set(
      worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
    );
    cleanup();
    render(<Develop subject={subject} />);
    await act(async () => {
      await settle();
      answerBinds(worker, false, answered);
      await settle();
    });
    await answerRenders(worker);
  }

  /** Waits out the label's delay (LABEL_DELAY_MS) on the real clock. */
  const labelDue = () => act(() => new Promise((r) => setTimeout(r, 350)));

  beforeEach(() => {
    FakeWorker.cache = new Set();
  });

  it("decodes a RAW again when it opens again after a time-out left it on its preview", async () => {
    settlesOnCameraPreview({ timedOut: true, reason: "no answer in 60 s" });
    settlesOnCameraPreview({ timedOut: true, reason: "no answer in 60 s" });
    const { worker } = await open(raw);
    await answerRenders(worker);
    expect(status?.tier).toBe("preview");
    expect(FakeWorker.cache?.has(key)).toBe(false);

    await openAgain(raw, worker);
    expect(vi.mocked(loadPhotoImage)).toHaveBeenCalledTimes(2);
  });

  it("keeps the preview of a RAW marked unsupported, and opens it from there", async () => {
    settlesOnCameraPreview({ unsupported: true, reason: "Unsupported file format" });
    const { worker } = await open(raw);
    await answerRenders(worker);
    expect(FakeWorker.cache?.has(key)).toBe(true);

    await openAgain(raw, worker);
    expect(vi.mocked(loadPhotoImage)).toHaveBeenCalledTimes(1);
    expect(status?.tier).toBe("preview");
  });

  // The stored preview is rendered again with each edit, so it can't stand for the photo.
  it("keeps the stored thumbnail of a RAW the decoder can't use out of it", async () => {
    vi.mocked(loadPhotoImage).mockImplementationOnce(async () => ({
      kind: "bitmap",
      bitmap: new FakeBitmap(768, 512),
      fallback: { from: "stored", offline: false, unsupported: true, timedOut: false },
    }));
    const { worker } = await open(raw);
    await answerRenders(worker);
    expect(status?.tier).toBe("preview");
    expect(FakeWorker.cache?.has(key)).toBe(false);
  });

  // Before, a photo that isn't a RAW counted as full quality on its stored thumbnail.
  it("calls the stored thumbnail of a photo whose original can't be read a preview", async () => {
    const { worker } = await open(photo({ fileHandle: null, previewEdit: undefined }));
    await answerRenders(worker);
    expect(status?.tier).toBe("preview");
    expect(FakeWorker.cache?.has(photoSourceKey(photo()))).toBe(false);
  });

  it("reads the original once it can be read again", async () => {
    let online = false;
    const file = new File(["original"], "next.jpg");
    const handle = {
      kind: "file",
      name: "next.jpg",
      getFile: async () => {
        if (!online) throw new Error("NotFoundError");
        return file;
      },
    } as FileSystemFileHandle;
    const { worker, progress } = await open(photo({ fileHandle: handle, previewEdit: undefined }));
    await answerRenders(worker);
    expect(status?.tier).toBe("preview");

    online = true;
    act(() => {
      useCatalogStore.setState({ fileAccessNonce: useCatalogStore.getState().fileAccessNonce + 1 });
    });
    await progress();
    await answerRenders(worker);
    expect(vi.mocked(loadPhotoImage)).toHaveBeenCalledTimes(2);
    expect(status?.tier).toBe("final");
  });

  it.each<[string, Partial<Fallback>, string]>([
    ["the decoder can't use it", { unsupported: true }, "Preview (Safelight can't open this RAW yet)"],
    ["its decode took too long", { timedOut: true }, "Preview (this RAW took too long to open)"],
    ["its decode failed for now", { reason: "couldn't read the file" }, "Preview"],
  ])("says why it shows a RAW's camera preview when %s", async (_label, why, said) => {
    settlesOnCameraPreview(why);
    const { worker } = await open(raw);
    await answerRenders(worker);
    await labelDue();
    expect(status?.status).toBe(said);
  });

  describe("decoding the neighbours ahead", () => {
    const shot = (id: string) => photo({ id, filename: `${id}.nef`, relPath: `${id}.nef` });
    const decode = async (): Promise<DecodedImage> => ({
      kind: "float",
      data: new Float32Array(24),
      width: 3,
      height: 2,
    });

    beforeEach(() => {
      useCatalogStore.setState({ photos: [shot("a"), shot("b"), shot("c")] });
      useUIStore.setState({
        filter: NO_FILTER,
        sortField: "filename",
        sortDirection: "asc",
        activeFolder: null,
      });
    });

    /** Opens `id` and lets its neighbours be decoded ahead, none of them on the GPU. */
    async function openAndPrefetch(id: string) {
      useDevelopStore.setState({ photoId: id });
      const view = await open(shot(id));
      const asked = new Set<number>();
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
        for (let round = 0; round < 3; round++) {
          for (const m of view.worker.posted) {
            if (m.cmd !== "hasSource" || asked.has(m.reqId)) continue;
            asked.add(m.reqId);
            view.worker.reply({ type: "hasSource", reqId: m.reqId, has: false });
          }
          await settle();
        }
      });
      return view;
    }

    const loads = () =>
      vi.mocked(loadPhotoImage).mock.calls.map(([p, opts]) => `${p.id}${opts?.background ? " ahead" : ""}`);

    it("keeps one out of it whose decode timed out", async () => {
      vi.mocked(loadPhotoImage).mockImplementationOnce(decode);
      settlesOnCameraPreview({ timedOut: true, reason: "no answer in 60 s" });
      await openAndPrefetch("a");

      expect(loads()).toEqual(["a", "b ahead"]);
      expect(FakeWorker.cache?.has(photoSourceKey(shot("a")))).toBe(true);
      expect(FakeWorker.cache?.has(photoSourceKey(shot("b")))).toBe(false);
    });

    // The decoder passes a background decode over while the file is being decoded for
    // another request (the Cache all pass, say), and the load resolves null.
    it("uploads nothing for one passed over, goes on to the next, and decodes it when opened", async () => {
      vi.mocked(loadPhotoImage).mockImplementationOnce(decode);
      vi.mocked(loadPhotoImage).mockImplementationOnce(async () => null);
      vi.mocked(loadPhotoImage).mockImplementationOnce(decode);
      vi.mocked(loadPhotoImage).mockImplementationOnce(decode);
      const { worker, rerender } = await openAndPrefetch("b");

      expect(loads()).toEqual(["b", "c ahead", "a ahead"]);
      expect(FakeWorker.cache?.has(photoSourceKey(shot("c")))).toBe(false);
      expect(FakeWorker.cache?.has(photoSourceKey(shot("a")))).toBe(true);

      const answered = new Set(
        worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
      );
      await act(async () => {
        useDevelopStore.setState({ photoId: "c" });
        rerender(<Develop subject={shot("c")} />);
        await settle();
      });
      await act(async () => {
        answerBinds(worker, false, answered);
        await settle();
      });
      await answerRenders(worker);
      expect(loads().at(-1)).toBe("c");
      expect(status?.tier).toBe("final");
    });

    // The review's case: the open photo settles on a fallback, and 250 ms on its decoded
    // neighbour goes to the GPU without being bound. A slider drag then drew the
    // neighbour under this photo's edit, and Auto Tone, Auto WB and the crop measured it.
    it("keeps drawing the open photo, settled on a preview, once its neighbour is decoded ahead", async () => {
      settlesOnCameraPreview({ timedOut: true });
      vi.mocked(loadPhotoImage).mockImplementationOnce(decode);
      const { worker } = await openAndPrefetch("a");
      expect(sourceMessages(worker)).toEqual(["upload a:0#fallback", "upload b:0 bind=false"]);

      await answerRenders(worker);
      act(() => getRenderBridge().render(false));
      const after = worker.inFlight();
      if (!after) throw new Error("no render in flight");
      expect(worker.sourceOf(after.seq)).toMatchObject({ sourceWidth: 1620, sourceHeight: 1080 });
    });

    it.each<[string, Partial<Fallback>]>([
      ["the camera's preview after a time-out", { timedOut: true }],
      ["the camera's preview after a failure for now", { reason: "couldn't read the file" }],
      ["a stored preview with no edit, the original offline", { from: "stored", offline: true }],
    ])("never uploads a neighbour over a source held under no key: %s", async (_label, why) => {
      settlesOnCameraPreview(why);
      vi.mocked(loadPhotoImage).mockImplementationOnce(decode);
      const { worker } = await openAndPrefetch("a");

      expect(loads()).toEqual(["a", "b ahead"]);
      expect(uploadsOverUnkeyed(worker)).toEqual([]);
    });
  });

  it("still says why when it opens the preview of a RAW it can't decode from the GPU", async () => {
    settlesOnCameraPreview({ unsupported: true });
    const { worker } = await open(raw);
    await answerRenders(worker);

    await openAgain(raw, worker);
    await labelDue();
    expect(status?.status).toBe("Preview (Safelight can't open this RAW yet)");
  });

  // An edited photo's stored preview is rendered with its edit (previewEdit). With the
  // original out of reach and no decode cache, rendering the edit over it applied the
  // edit twice: a +1 EV edit showed about +2 EV.
  describe("when the original isn't available and the stored preview shows an edit", () => {
    const offline = photo({ fileHandle: null });

    it("shows it as it is, and hands the renderer nothing to draw an edit over", async () => {
      const { worker } = await open(offline);
      await labelDue();

      expect(sourceMessages(worker)).toEqual([]);
      expect(status?.tier).toBe("stored");
      expect(drawn).not.toEqual([]);
      expect(status?.status).toBe("Preview (the original isn't available)");
    });

    it("shows no picture, and says why, when it shows another edit than the one open", async () => {
      useDevelopStore.setState(loaded("next", edit(1)));
      const { worker } = await open(offline);

      expect(sourceMessages(worker)).toEqual([]);
      expect(drawn).toEqual([]);
      expect(status?.tier).toBeNull();
      expect(status?.status).toBe("The original isn't available.");
    });

    // The stored preview shows the edit it was rendered with, not the one being made.
    it("lets the picture go, and says why, once an edit moves off the stored one", async () => {
      const { worker } = await open(offline);
      expect(status?.tier).toBe("stored");

      act(() => useDevelopStore.setState({ params: edit(1) }));

      expect(status?.tier).toBeNull();
      expect(status?.width).toBe(0);
      expect(status?.status).toBe("The original isn't available.");
      expect(sourceMessages(worker)).toEqual([]);
    });

    it("shows the picture again when the edit is undone back to the stored one", async () => {
      await open(offline);
      act(() => useDevelopStore.setState({ params: edit(1) }));

      await act(async () => {
        useDevelopStore.setState({ params: edit(0.5) });
        await settle();
      });
      await labelDue();

      expect(status?.tier).toBe("stored");
      expect(status?.width).toBeGreaterThan(0);
      expect(status?.status).toBe("Preview (the original isn't available)");
    });

    it("renders the edit over a stored preview that shows none, as before", async () => {
      useDevelopStore.setState(loaded("next", edit(1)));
      const { worker } = await open(photo({ fileHandle: null, previewEdit: undefined }));
      await answerRenders(worker);
      await labelDue();

      expect(sourceMessages(worker)).toEqual(["upload next:0#fallback"]);
      expect(status?.tier).toBe("preview");
      expect(status?.status).toBe("Preview (the original isn't available)");
    });
  });
});

// A source the worker can't take (an upload that throws for want of memory, say) leaves
// it nothing to draw the photo from: no frame comes, and the sliders change nothing.
describe("useDevelopRenderer when the worker can't take the photo's source", () => {
  const CAMERA_PREVIEW = { width: 1620, height: 1080 };
  const FAILED = "Can't show this photo.";

  /** The next load hands over the camera's preview once `preview` is called, then
   *  settles on the full image once `full` is. */
  function loadInTwoSteps() {
    let preview = () => {};
    let full = () => {};
    const previewDue = new Promise<void>((r) => (preview = r));
    const fullDue = new Promise<void>((r) => (full = r));
    vi.mocked(loadPhotoImage).mockImplementationOnce(async (_photo, opts) => {
      await previewDue;
      const { width, height } = CAMERA_PREVIEW;
      opts?.onPreview?.({ kind: "bitmap", bitmap: new FakeBitmap(width, height) });
      await fullDue;
      return { kind: "bitmap", bitmap: new FakeBitmap(SOURCE_SIZE.width, SOURCE_SIZE.height) };
    });
    return { preview, full };
  }

  it("says it can't show the photo, over its stored preview", async () => {
    FakeWorker.failing = new Set(["setImage", "uploadSource"]);
    await open(photo());
    expect(status?.tier).toBe("stored");
    expect(status?.status).toBe(FAILED);
  });

  it("starts over when the photo loads again", async () => {
    FakeWorker.failing = new Set(["uploadSource"]);
    const { worker, progress } = await open(photo());
    expect(status?.status).toBe(FAILED);

    FakeWorker.failing = new Set();
    act(() => {
      useCatalogStore.setState({ fileAccessNonce: useCatalogStore.getState().fileAccessNonce + 1 });
    });
    expect(status?.status).not.toBe(FAILED);
    await progress();
    await answerRenders(worker);
    expect(status?.tier).toBe("final");
    expect(status?.status).not.toBe(FAILED);
  });

  it("stops saying so once a later source of the photo is taken", async () => {
    FakeWorker.failing = new Set(["setImage"]);
    const load = loadInTwoSteps();
    const { worker, progress } = await open(photo());
    load.preview();
    await progress();
    expect(status?.status).toBe(FAILED);

    load.full();
    await progress();
    await answerRenders(worker);
    expect(status?.tier).toBe("final");
    expect(status?.status).not.toBe(FAILED);
  });

  it("pays no heed to a source that failed once it has handed over the next", async () => {
    FakeWorker.failing = new Set(["setImage"]);
    const load = loadInTwoSteps();
    const { worker, progress } = await open(photo());
    worker.holding = true;
    load.preview();
    await progress();
    load.full();
    await progress();

    await act(async () => {
      worker.release();
      await settle();
    });
    await answerRenders(worker);
    expect(status?.tier).toBe("final");
    expect(status?.status).not.toBe(FAILED);
  });
});

// Every render and every histogram costs the worker a full pass over the
// source, so one edit asks for one of each. Animation frames are run by hand
// here, so what an edit posts doesn't depend on when jsdom's clock ticks.
describe("useDevelopRenderer during an edit", () => {
  const LIVE_HISTOGRAM = useSettings.getState().liveHistogram;
  let frameQueue: Map<number, FrameRequestCallback>;

  beforeEach(() => {
    frameQueue = new Map();
    let nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      frameQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
  });

  afterEach(() => {
    status = null;
    useSettings.setState({ liveHistogram: LIVE_HISTOGRAM });
    useDevelopStore.setState({ hoveredMaskId: null, selectedMaskId: null });
  });

  /** Runs the animation frames queued so far; the ones they queue wait. */
  async function nextFrame() {
    await act(async () => {
      const due = [...frameQueue.values()];
      frameQueue.clear();
      for (const cb of due) cb(performance.now());
    });
  }

  async function frames(n: number) {
    for (let i = 0; i < n; i++) await nextFrame();
  }

  /** Animation frames run with a worker that keeps up: each render is answered before
   *  the next frame. */
  async function answeredFrames(worker: FakeWorker, n: number) {
    for (let i = 0; i < n; i++) {
      await nextFrame();
      await answerRenders(worker);
    }
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const posts = (worker: FakeWorker, cmd: WorkerRequest["cmd"], from = 0) =>
    worker.posted.slice(from).filter((m) => m.cmd === cmd);

  const lastIndexOf = (worker: FakeWorker, cmd: WorkerRequest["cmd"]) =>
    worker.posted.findLastIndex((m) => m.cmd === cmd);

  /** The worker's frame for the render in flight (seq 0, answering nothing, if none is). */
  function frame(withHistogram = false): WorkerResponse {
    const seq = renderWorker().inFlight()?.seq ?? 0;
    return {
      type: "frame",
      seq,
      bitmap: new FakeBitmap(10, 10),
      width: 10,
      height: 10,
      ...renderWorker().sourceOf(seq),
      ...(withHistogram ? { histogram: histogram() } : {}),
    };
  }

  function mask(id: string): Mask {
    return {
      id,
      name: id,
      visible: true,
      invert: false,
      opacity: 100,
      adj: defaultMaskAdjustments(),
      panels: [],
      components: [],
    };
  }

  function withMasks(...ids: string[]): DevelopParams {
    return { ...edit(0.5), masks: ids.map(mask) };
  }

  function replaceMasks(ids: string[]) {
    const p = useDevelopStore.getState().params;
    const byId = new Map(p.masks.map((m) => [m.id, m]));
    useDevelopStore.setState({
      params: { ...p, masks: ids.map((id) => ({ ...(byId.get(id) ?? mask(id)) })) },
    });
  }

  function vizPosts(worker: FakeWorker, from: number) {
    return worker.posted
      .slice(from)
      .flatMap((m) => (m.cmd === "setMaskViz" ? [{ index: m.index, strength: m.strength }] : []));
  }

  /** The photo open, its first frames drawn, and a moment past the live histogram's
   *  80 ms throttle before the first edit. */
  async function opened(hit = false) {
    const { worker } = await open(photo(), hit);
    await nextFrame();
    await answerRenders(worker);
    await act(async () => {
      await wait(100);
    });
    return worker;
  }

  /** One edit, rendered and answered, its histogram asked for and settled. */
  async function editAndSettle(worker: FakeWorker, exposure: number) {
    await act(async () => {
      useDevelopStore.setState({ params: { ...useDevelopStore.getState().params, exposure } });
    });
    await nextFrame();
    await act(async () => {
      worker.reply(frame());
      await wait(400);
    });
  }

  describe("of the masks", () => {
    it("posts one render while no coverage overlay shows", async () => {
      useDevelopStore.setState({ params: withMasks("a") });
      const worker = await opened();
      const from = worker.posted.length;

      await act(async () => replaceMasks(["a"]));
      await frames(3);
      // A second request would wait behind the first until that one is answered.
      await answerRenders(worker);

      expect(posts(worker, "render", from)).toHaveLength(1);
      expect(posts(worker, "setMaskViz", from)).toEqual([]);
    });

    it("posts one render while the edited mask's overlay shows", async () => {
      useDevelopStore.setState({ params: withMasks("a") });
      const worker = await opened();
      await act(async () => useDevelopStore.setState({ hoveredMaskId: "a" }));
      await answeredFrames(worker, 40);
      const from = worker.posted.length;

      await act(async () => replaceMasks(["a"]));
      await frames(3);
      await answerRenders(worker);

      expect(posts(worker, "render", from)).toHaveLength(1);
      expect(posts(worker, "setMaskViz", from)).toEqual([]);
    });

    it("moves the overlay with its mask when one ahead of it is removed", async () => {
      useDevelopStore.setState({ params: withMasks("a", "b") });
      const worker = await opened();
      await act(async () => useDevelopStore.setState({ hoveredMaskId: "b" }));
      await answeredFrames(worker, 40);
      expect(vizPosts(worker, 0).at(-1)).toEqual({ index: 1, strength: 0.5 });
      const from = worker.posted.length;

      await act(async () => replaceMasks(["b"]));
      await frames(3);
      await answerRenders(worker);

      expect(vizPosts(worker, from)).toEqual([{ index: 0, strength: 0.5 }]);
      expect(lastIndexOf(worker, "render")).toBeGreaterThan(lastIndexOf(worker, "setMaskViz"));
    });
  });

  describe("hovering a mask", () => {
    it("fades the overlay in and out, rendering each step, then stops", async () => {
      useDevelopStore.setState({ params: withMasks("a") });
      const worker = await opened();
      const from = worker.posted.length;

      await act(async () => useDevelopStore.setState({ hoveredMaskId: "a" }));
      await answeredFrames(worker, 40);
      const fadeIn = vizPosts(worker, from);
      expect(fadeIn.length).toBeGreaterThan(3);
      expect(fadeIn.every((v) => v.index === 0)).toBe(true);
      for (let i = 1; i < fadeIn.length; i++) {
        expect(fadeIn[i].strength).toBeGreaterThan(fadeIn[i - 1].strength);
      }
      expect(fadeIn.at(-1)?.strength).toBe(0.5);
      expect(posts(worker, "render", from)).toHaveLength(fadeIn.length);

      const shown = worker.posted.length;
      await frames(5);
      expect(worker.posted.length).toBe(shown);

      await act(async () => useDevelopStore.setState({ hoveredMaskId: null }));
      await answeredFrames(worker, 40);
      const fadeOut = vizPosts(worker, shown);
      expect(fadeOut.length).toBeGreaterThan(3);
      for (let i = 1; i < fadeOut.length; i++) {
        expect(fadeOut[i].strength).toBeLessThan(fadeOut[i - 1].strength);
      }
      expect(fadeOut.at(-1)).toEqual({ index: -1, strength: 0 });
      expect(posts(worker, "render", shown)).toHaveLength(fadeOut.length);

      const hidden = worker.posted.length;
      await frames(5);
      expect(worker.posted.length).toBe(hidden);
    });

    it("clears an overlay the view left showing when it closed", async () => {
      useDevelopStore.setState({ params: withMasks("a") });
      const worker = await opened();
      await act(async () => useDevelopStore.setState({ hoveredMaskId: "a" }));
      await frames(40);
      expect(vizPosts(worker, 0).at(-1)).toEqual({ index: 0, strength: 0.5 });

      cleanup();
      useDevelopStore.setState({ hoveredMaskId: null });
      const from = worker.posted.length;
      render(<Develop subject={photo()} />);
      await nextFrame();

      expect(vizPosts(worker, from)).toEqual([{ index: -1, strength: 0 }]);
    });
  });

  // The renderer caps the source it holds, so its aspect can be a shade off the
  // photo's own: 4096×2731 against 6000×4000. Only the crop overlay draws with it.
  describe("drawing a photo's first decode", () => {
    /** The photo open with its first decode at `size`, the frames the view asked for
     *  before it drawn. Returns where the source was handed over. */
    async function openDecodedAt(size: { width: number; height: number }) {
      let finish = () => {};
      const finished = new Promise<void>((r) => (finish = r));
      vi.mocked(loadPhotoImage).mockImplementationOnce(async () => {
        await finished;
        return { kind: "bitmap", bitmap: new FakeBitmap(size.width, size.height) };
      });
      const { worker, progress } = await open(photo());
      await nextFrame();
      await act(async () => finish());
      await progress();
      const source = sourceIndex(worker, false);
      expect(source).toBeGreaterThanOrEqual(0);
      await answerRenders(worker);
      await answeredFrames(worker, 3);
      await act(async () => {
        await wait(400);
      });
      return { worker, source };
    }

    it("renders and measures it once outside crop mode", async () => {
      const { worker, source } = await openDecodedAt({ width: 4096, height: 2731 });

      expect(status?.sourceWidth).toBe(4096);
      expect(posts(worker, "render", source)).toHaveLength(1);
      expect(posts(worker, "computeHistogram", source)).toEqual([]);
    });

    it("draws the crop again for the source's own aspect in crop mode", async () => {
      useDevelopStore.setState({ cropping: true, params: { ...edit(0.5), straighten: 5 } });
      try {
        const upright = { width: 4000, height: 6000 };
        const { worker, source } = await openDecodedAt(upright);

        const renders = posts(worker, "render", source);
        expect(renders).toHaveLength(2);
        const { straighten, transform } = useDevelopStore.getState().params;
        const aspect = upright.width / upright.height;
        const forward = buildForwardTransform(straighten, transform, aspect);
        expect(paramsAt(worker, worker.posted.indexOf(renders[1]))?.crop).toEqual(
          transformedViewCrop(forward),
        );
      } finally {
        useDevelopStore.setState({ cropping: false });
      }
    });
  });

  describe("asking for the histogram", () => {
    it.each([
      ["decoded", false],
      ["already on the GPU", true],
    ])("asks for none beyond the one a photo's first render carries (%s)", async (_label, hit) => {
      const worker = await opened(hit);

      await act(async () => {
        worker.reply(frame(true));
        worker.reply(frame());
        await wait(400);
      });

      expect(posts(worker, "computeHistogram")).toEqual([]);
      // The clipping readouts need the extended histogram from the first one.
      const carrying = posts(worker, "render").filter((m) => m.cmd === "render" && m.wantHistogram);
      expect(carrying).not.toEqual([]);
      for (const m of carrying) expect(m).toMatchObject({ wantHistogram: true, wantExtended: true });
    });

    it("asks for one after one edit and its frame", async () => {
      const worker = await opened();
      const from = worker.posted.length;

      await editAndSettle(worker, 1);

      expect(posts(worker, "render", from)).toHaveLength(1);
      expect(posts(worker, "computeHistogram", from)).toHaveLength(1);
    });

    it("asks for none after a frame that only moved the view", async () => {
      const worker = await opened();
      await editAndSettle(worker, 1);
      const from = worker.posted.length;

      await act(async () => status?.setViewport({ x: 0, y: 0, w: 0.5, h: 0.5 }, 100, 100));
      await nextFrame();
      await act(async () => {
        worker.reply(frame());
        await wait(400);
      });

      expect(posts(worker, "render", from)).toHaveLength(1);
      expect(posts(worker, "computeHistogram", from)).toEqual([]);
    });

    it("asks for none while the coverage overlay fades", async () => {
      useDevelopStore.setState({ params: withMasks("a") });
      const worker = await opened();
      await editAndSettle(worker, 1);
      const from = worker.posted.length;

      await act(async () => useDevelopStore.setState({ hoveredMaskId: "a" }));
      for (let i = 0; i < 40; i++) {
        await nextFrame();
        await act(async () => worker.reply(frame()));
      }
      await act(async () => {
        await wait(400);
      });

      expect(posts(worker, "setMaskViz", from).length).toBeGreaterThan(0);
      expect(posts(worker, "computeHistogram", from)).toEqual([]);
    });

    // Run twice: the bridge debounces its own repaints in a module-level frame
    // request that outlives it, so a test leaving one queued stops the next.
    it.each(["first", "second"])(
      "asks for one after an extension's stages change (%s time)",
      async () => {
        const worker = await opened();
        await editAndSettle(worker, 1);
        const from = worker.posted.length;
        const stages = useRegistry.getState().processingStages;
        let renders = 0;
        let histograms = 0;

        try {
          await act(async () => useRegistry.setState({ processingStages: { ...stages } }));
          await nextFrame();
          await act(async () => {
            worker.reply(frame());
            await wait(400);
          });
          renders = posts(worker, "render", from).length;
          histograms = posts(worker, "computeHistogram", from).length;
        } finally {
          await act(async () => useRegistry.setState({ processingStages: stages }));
          await nextFrame();
        }

        expect(renders).toBe(1);
        expect(histograms).toBe(1);
      },
    );

    it("with live histogram off, settles into one after the last frame of a drag", async () => {
      useSettings.setState({ liveHistogram: false });
      const worker = await opened();
      const from = worker.posted.length;

      for (let i = 1; i <= 4; i++) {
        await act(async () => {
          useDevelopStore.setState({ params: edit(0.5 + i / 10) });
        });
        await nextFrame();
        await act(async () => {
          worker.reply(frame());
          await wait(40);
        });
      }
      expect(posts(worker, "computeHistogram", from)).toEqual([]);
      await act(async () => {
        await wait(400);
      });

      expect(posts(worker, "render", from)).toHaveLength(4);
      expect(posts(worker, "computeHistogram", from)).toHaveLength(1);
      expect(lastIndexOf(worker, "computeHistogram")).toBeGreaterThan(lastIndexOf(worker, "render"));
    });

    // Auto Tone and Auto WB wait 450 ms for each step's histogram (use-auto-adjust.ts)
    // before measuring again; a slow render must not push it past that.
    it("with live histogram off, settles counted from the edit, not from a slow frame", async () => {
      useSettings.setState({ liveHistogram: false });
      const worker = await opened();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      try {
        const from = worker.posted.length;

        await act(async () => {
          useDevelopStore.setState({ params: edit(1) });
        });
        await nextFrame();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(300);
          worker.reply(frame());
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20);
        });

        expect(posts(worker, "render", from)).toHaveLength(1);
        expect(posts(worker, "computeHistogram", from)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("with live histogram on, measures the last render of a drag", async () => {
      const worker = await opened();
      const from = worker.posted.length;

      await act(async () => {
        useDevelopStore.setState({ params: edit(1) });
      });
      await nextFrame();
      // The histogram this frame schedules is posted while the next edit's
      // render still waits for its animation frame.
      await act(async () => {
        worker.reply(frame());
        useDevelopStore.setState({ params: edit(2) });
      });
      await act(async () => {
        await wait(40);
      });
      expect(posts(worker, "computeHistogram", from)).toHaveLength(1);
      expect(posts(worker, "render", from)).toHaveLength(1);
      const secondEdit = worker.posted.findIndex(
        (m, i) =>
          (m.cmd === "setParams" || m.cmd === "patchParams") &&
          paramsAt(worker, i + 1)?.exposure === 2,
      );
      expect(secondEdit).toBeGreaterThanOrEqual(from);
      expect(secondEdit).toBeLessThan(lastIndexOf(worker, "computeHistogram"));

      await nextFrame();
      await act(async () => {
        worker.reply(frame());
        await wait(400);
      });

      expect(posts(worker, "render", from)).toHaveLength(2);
      expect(posts(worker, "computeHistogram", from)).toHaveLength(2);
      expect(lastIndexOf(worker, "computeHistogram")).toBeGreaterThan(lastIndexOf(worker, "render"));
    });

    // The histogram a frame schedules can come due while the render of the drag's last
    // edit waits its turn in the bridge. Sent on its own then, the worker would measure
    // the render ahead of it, and the last edit would go unmeasured.
    it("with live histogram on, measures the last render of a drag that waited its turn", async () => {
      useSettings.setState({ liveHistogram: true });
      const worker = await opened();
      const from = worker.posted.length;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await act(async () => useDevelopStore.setState({ params: edit(1) }));
        await nextFrame();
        await act(async () => useDevelopStore.setState({ params: edit(2) }));
        await nextFrame();
        // Edit 1's frame: edit 2's render goes, and the frame schedules a histogram.
        await act(async () => worker.reply(frame()));
        // The last edit, whose render waits behind edit 2's while the histogram comes due.
        await act(async () => useDevelopStore.setState({ params: edit(3) }));
        await nextFrame();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
        // Edit 2's frame: the last edit's render goes.
        await act(async () => worker.reply(frame()));

        const sent = worker.posted.slice(from).filter((m): m is Render => m.cmd === "render");
        expect(sent).toHaveLength(3);
        const last = sent[2];
        expect(paramsAt(worker, worker.posted.indexOf(last))?.exposure).toBe(3);
        expect(last).toMatchObject({ wantHistogram: true, wantExtended: true });
        expect(posts(worker, "computeHistogram", from)).toEqual([]);

        const measured = histogram();
        await act(async () => {
          worker.reply({
            type: "frame",
            seq: last.seq,
            bitmap: new FakeBitmap(10, 10),
            width: 10,
            height: 10,
            ...worker.sourceOf(last.seq),
            histogram: measured,
          });
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(useDevelopStore.getState().histogram).toBe(measured);
        expect(posts(worker, "computeHistogram", from)).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // The worker draws renders in the order they come. While it was slower than the
  // display, each render the view asked for queued behind the one it was drawing, and
  // the image kept changing after the user let go.
  describe("while the worker is slower than the display", () => {
    it("posts one render at a time, then only the last edit's", async () => {
      const worker = await opened();
      const from = worker.posted.length;

      for (let i = 1; i <= 5; i++) {
        await act(async () => useDevelopStore.setState({ params: edit(0.5 + i / 10) }));
        await nextFrame();
      }
      expect(posts(worker, "render", from)).toHaveLength(1);

      await act(async () => worker.reply(frame()));
      const sent = posts(worker, "render", from);
      expect(sent).toHaveLength(2);
      expect(paramsAt(worker, worker.posted.indexOf(sent[1]))?.exposure).toBe(1);

      await act(async () => worker.reply(frame()));
      await frames(3);
      expect(posts(worker, "render", from)).toHaveLength(2);
    });

    // Moving to another photo, the render that waited behind the last frame of the
    // photo before goes to a worker with no source yet, which skips it. The next
    // photo's own first render waits behind that one, and the skip must send it.
    it.each([
      ["decoded", false],
      ["already on the GPU", true],
    ])("draws the next photo, %s, once a render waiting at the switch is skipped", async (_label, hit) => {
      const shot = (id: string) => photo({ id, filename: `${id}.jpg`, relPath: `${id}.jpg` });
      useDevelopStore.setState({ photoId: "a", params: edit(0.5) });
      const { worker, rerender } = await open(shot("a"));
      await nextFrame();
      await answerRenders(worker);

      await act(async () => useDevelopStore.setState({ params: edit(1) }));
      await nextFrame();
      await act(async () => useDevelopStore.setState({ params: edit(1.5) }));
      await nextFrame();
      const drawing = worker.inFlight();
      if (!drawing) throw new Error("no render in flight");

      FakeWorker.hits = hit;
      worker.holding = true;
      const switchAt = worker.posted.length;
      act(() => {
        useDevelopStore.setState({ photoId: "b", params: edit(2) });
        rerender(<Develop subject={shot("b")} />);
      });
      // The first photo's frame comes back before the next one's source is asked for.
      const late = new FakeBitmap(10, 10);
      worker.reply({
        type: "frame",
        seq: drawing.seq,
        bitmap: late,
        width: 10,
        height: 10,
        ...worker.sourceOf(drawing.seq),
      });
      const answered = new Set<number>();
      await act(async () => {
        await settle();
        answerBinds(worker, hit, answered);
        await settle();
        answerBinds(worker, hit, answered);
        await settle();
      });

      const source = sourceIndex(worker, hit, switchAt);
      expect(source).toBeGreaterThanOrEqual(switchAt);
      const afterSource = () =>
        worker.posted.slice(source).filter((m): m is Render => m.cmd === "render");
      expect(afterSource()).toEqual([]);

      await act(async () => worker.release());
      const [first] = afterSource();
      expect(afterSource()).toHaveLength(1);
      expect(first).toMatchObject({ wantHistogram: true, wantExtended: true });
      expect(paramsAt(worker, worker.posted.indexOf(first))?.exposure).toBe(2);

      const shown = new FakeBitmap(10, 10);
      const measured = histogram();
      await act(async () => {
        worker.reply({
          type: "frame",
          seq: first.seq,
          bitmap: shown,
          width: 10,
          height: 10,
          ...worker.sourceOf(first.seq),
          histogram: measured,
        });
      });
      expect(drawn).not.toContain(late);
      expect(drawn.at(-1)).toBe(shown);
      expect(useDevelopStore.getState().histogram).toBe(measured);
    });
  });

  // The stage bag the worker draws with: the photo's own, and the built-in denoise
  // stage's entries made from its params.
  describe("the extension stages' params", () => {
    const nr = { ...edit(0.5), luminanceNR: 40 };
    const bag = { "ext.grain.amount": 0.3 };
    const expected = (params: DevelopParams) => ({ ...bag, ...denoiseBag(params) });

    beforeEach(() => {
      useDevelopStore.setState({ ...loaded("next", nr), paramBag: bag });
    });

    it.each([
      ["decoded", false],
      ["already on the GPU", true],
    ])("go with the photo's source %s, and with each edit", async (_label, hit) => {
      const { worker } = await open(photo(), hit);
      const first = worker.inFlight();
      if (!first) throw new Error("no render in flight");
      expect(bagAt(worker, worker.posted.indexOf(first))).toEqual(expected(nr));
      await answerRenders(worker);

      const more = { ...nr, luminanceNR: 60 };
      act(() => useDevelopStore.setState({ params: more }));
      await nextFrame();
      const after = worker.inFlight();
      if (!after) throw new Error("no render for the edit");
      expect(bagAt(worker, worker.posted.indexOf(after))).toEqual(expected(more));
    });
  });
});

// Holding the arrow key through a folder of RAWs asks for a decode of every photo
// passed. Each waits for one of a few decoders, so the photo stopped on would wait
// behind all of them. A photo left gives up its place in the queue.
describe("useDevelopRenderer leaving a photo before its decode starts", () => {
  type Instance = NonNullable<Awaited<ReturnType<typeof acquireInstance>>>;
  const raw = (id: string) => photo({ id, filename: `${id}.nef`, relPath: `${id}.nef` });
  let order: string[];

  /** Takes every decoder, as decodes of other photos would. */
  async function busyDecoders(): Promise<Instance[]> {
    await warmDecodePool();
    const held: Instance[] = [];
    for (let i = 0; i < decodePoolSize(); i++) {
      const inst = await acquireInstance();
      if (!inst) throw new Error("decode pool unavailable");
      held.push(inst);
    }
    return held;
  }

  /** Moves the open view to `next`, which isn't on the GPU. */
  async function moveTo(view: Awaited<ReturnType<typeof open>>, next: CatalogPhoto) {
    const { worker, rerender } = view;
    const answered = new Set(
      worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
    );
    await act(async () => {
      useDevelopStore.setState({ photoId: next.id });
      rerender(<Develop subject={next} />);
      await settle();
    });
    await act(async () => {
      answerBinds(worker, false, answered);
      await settle();
    });
  }

  beforeEach(() => {
    disposeDecodePool();
    order = [];
    // A load waits for a decoder as libraw's does, and gives it back once done.
    vi.mocked(loadPhotoImage).mockImplementation(async (p, opts) => {
      const inst = await acquireInstance({ background: opts?.background, signal: opts?.signal });
      if (!inst) {
        order.push(`${p.id} dropped`);
        return null;
      }
      order.push(p.id);
      releaseInstance(inst);
      return { kind: "float", data: new Float32Array(24), width: 3, height: 2 };
    });
  });

  afterEach(() => {
    vi.mocked(loadPhotoImage).mockReset();
    disposeDecodePool();
    status = null;
  });

  it("drops the decode of the photo left and decodes the next one first", async () => {
    const busy = await busyDecoders();
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(raw("a"));
    expect(order).toEqual([]);

    await moveTo(view, raw("b"));
    await act(async () => {
      releaseInstance(busy[0]);
      await settle();
    });

    expect(order).toEqual(["a dropped", "b"]);
  });

  it("drops its waiting decode when the view closes", async () => {
    const busy = await busyDecoders();
    useDevelopStore.setState({ photoId: "a" });
    await open(raw("a"));

    cleanup();
    await act(async () => {
      releaseInstance(busy[0]);
      await settle();
    });

    expect(order).toEqual(["a dropped"]);
  });

  it("drops a neighbour's waiting decode when moving to another photo", async () => {
    useCatalogStore.setState({ photos: [raw("a"), raw("b"), raw("c")] });
    useUIStore.setState({
      filter: NO_FILTER,
      sortField: "filename",
      sortDirection: "asc",
      activeFolder: null,
    });
    useDevelopStore.setState({ photoId: "b" });
    const view = await open(raw("b"));
    expect(order).toEqual(["b"]);
    const busy = await busyDecoders();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      for (const m of view.worker.posted) {
        if (m.cmd === "hasSource") {
          view.worker.reply({ type: "hasSource", reqId: m.reqId, has: false });
        }
      }
      await settle();
    });
    const prefetch = vi.mocked(loadPhotoImage).mock.calls.find(([p]) => p.id === "c");
    expect(prefetch?.[1]).toMatchObject({ background: true });

    await moveTo(view, raw("a"));
    await act(async () => {
      for (const inst of busy) releaseInstance(inst);
      await settle();
    });

    expect(order).toEqual(["b", "c dropped", "a"]);
  });

  // libraw can't be stopped once it runs; the decode fills the cache all the same.
  it("lets a decode already running finish, and hands nothing of it to the view", async () => {
    let finish = () => {};
    const finished = new Promise<void>((r) => (finish = r));
    vi.mocked(loadPhotoImage).mockImplementationOnce(async (p) => {
      order.push(p.id);
      await finished;
      return { kind: "float", data: new Float32Array(24), width: 3, height: 2 };
    });
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(raw("a"));
    const switchAt = view.worker.posted.length;

    await moveTo(view, raw("b"));
    await act(async () => {
      finish();
      await settle();
    });

    const uploads = view.worker.posted
      .slice(switchAt)
      .flatMap((m) => (m.cmd === "uploadSource" && m.target === "main" ? [m.key] : []));
    expect(order).toEqual(["a", "b"]);
    expect(uploads).toEqual(["b:0"]);
  });
});

// Opening a photo shows its stored preview, then the camera's preview, then the full
// decode. They are the same photo, so each eases into the next; another photo, or
// photos passed in a rush, cut. Animation frames are run by hand.
describe("useDevelopRenderer easing between what it shows of a photo", () => {
  // The shape of the stored preview, so a fade of one into the other lines up.
  const FRAME = { width: 1500, height: 1000 };
  const shot = (id: string, over: Partial<CatalogPhoto> = {}) =>
    photo({ id, filename: `${id}.jpg`, relPath: `${id}.jpg`, ...over });
  let frameQueue: Map<number, FrameRequestCallback>;
  let clock: number;

  beforeEach(() => {
    frameQueue = new Map();
    let nextId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      frameQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frameQueue.delete(id));
    clock = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    FakeWorker.residentSize = SOURCE_SIZE;
  });

  afterEach(() => {
    vi.mocked(performance.now).mockRestore();
    status = null;
  });

  async function frames(n: number) {
    for (let i = 0; i < n; i++) {
      await act(async () => {
        const due = [...frameQueue.values()];
        frameQueue.clear();
        for (const cb of due) cb(0);
      });
    }
  }

  const developCanvas = () => document.querySelector<HTMLCanvasElement>("canvas:not([data-fade])");

  /** The copies the fade overlay took, in order. */
  const copies = () => paints.filter((p) => p.canvas === fadeCanvas() && p.op === "draw");

  /** Moves the open view to `next`, `after` ms after the photo before was opened. */
  async function moveTo(
    view: Awaited<ReturnType<typeof open>>,
    next: CatalogPhoto,
    after: number,
    hit: boolean,
  ) {
    const { worker, rerender } = view;
    const answered = new Set(
      worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
    );
    clock += after;
    FakeWorker.hits = hit;
    await act(async () => {
      useDevelopStore.setState({ photoId: next.id });
      rerender(<Develop subject={next} />);
      await settle();
    });
    await act(async () => {
      answerBinds(worker, hit, answered);
      await settle();
    });
  }

  it.each([
    ["decoded", false],
    ["already on the GPU", true],
  ])("eases the stored preview into the first frame of the source %s", async (_label, hit) => {
    const { worker } = await open(photo(), hit);
    expect(drawn).toEqual([decoded[0]]);

    await answerRenders(worker, FRAME);

    const order = paints
      .filter((p) => p.op === "draw")
      .map((p) => (p.canvas === fadeCanvas() ? "copy" : p.image === decoded[0] ? "stored" : "frame"));
    expect(order).toEqual(["stored", "copy", "frame"]);
    expect(copies()[0].image).toBe(developCanvas());
    const fade = fadeCanvas();
    expect(fade?.style.opacity).toBe("1");

    await frames(2);
    expect(fade?.style.transition).toBe("opacity 150ms ease-out");
    expect(fade?.style.opacity).toBe("0");
  });

  it("eases the camera's preview into the full decode, more slowly", async () => {
    let finish = () => {};
    const finished = new Promise<void>((r) => (finish = r));
    vi.mocked(loadPhotoImage).mockImplementationOnce(async (_photo, opts) => {
      opts?.onPreview?.({ kind: "bitmap", bitmap: new FakeBitmap(FRAME.width, FRAME.height) });
      await finished;
      return { kind: "bitmap", bitmap: new FakeBitmap(SOURCE_SIZE.width, SOURCE_SIZE.height) };
    });
    const { worker, progress } = await open(photo());

    await answerRenders(worker, FRAME);
    expect(status?.tier).toBe("preview");
    await frames(2);
    expect(fadeCanvas()?.style.transition).toBe("opacity 150ms ease-out");

    await act(async () => finish());
    await progress();
    await answerRenders(worker, FRAME);
    expect(status?.tier).toBe("final");
    expect(copies()).toHaveLength(2);
    await frames(2);
    expect(fadeCanvas()?.style.transition).toBe("opacity 220ms ease-out");
  });

  /** Photo "a" open, eased into its source, with nothing left for the worker to draw. */
  async function settledOnA() {
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(shot("a"), true);
    await answerRenders(view.worker, FRAME);
    await frames(2);
    await answerRenders(view.worker, FRAME);
    return view;
  }

  it("cuts from another photo's camera preview to one still on the GPU", async () => {
    vi.mocked(loadPhotoImage).mockImplementationOnce(async (_photo, opts) => {
      opts?.onPreview?.({ kind: "bitmap", bitmap: new FakeBitmap(FRAME.width, FRAME.height) });
      return new Promise<null>(() => {});
    });
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(shot("a"));
    await answerRenders(view.worker, FRAME);
    await frames(2);
    await answerRenders(view.worker, FRAME);
    expect(status?.tier).toBe("preview");
    const before = copies().length;

    await moveTo(view, shot("b", { thumbnailBlob: null }), 1000, true);
    await answerRenders(view.worker, FRAME);

    expect(status?.tier).toBe("final");
    expect(copies()).toHaveLength(before);
    expect(fadeCanvas()?.style.opacity).toBe("0");
  });

  it("cuts from another photo's stored preview to one still on the GPU", async () => {
    holdSource = new Promise<void>(() => {});
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(shot("a"));
    expect(status?.tier).toBe("stored");

    await moveTo(view, shot("b", { thumbnailBlob: null }), 1000, true);
    await answerRenders(view.worker, FRAME);

    expect(status?.tier).toBe("final");
    expect(copies()).toEqual([]);
  });

  // React's StrictMode runs a view's effects twice as it mounts; that is one open.
  it("eases a photo whose view ran its effects twice as it opened", async () => {
    const { worker } = await open(photo(), true, Develop, true);
    expect(status?.tier).toBe("stored");

    await answerRenders(worker, FRAME);

    expect(status?.tier).toBe("final");
    expect(copies()).toHaveLength(1);
  });

  it("cuts to a frame of another shape than the stored preview", async () => {
    const { worker } = await open(photo(), true);
    await answerRenders(worker, { width: 1000, height: 1500 });
    expect(status?.tier).toBe("final");
    expect(copies()).toEqual([]);
  });

  // The overlay is laid out in the canvas's box, which follows the new shape: left
  // showing, the old picture would be stretched into it until the fade ends.
  it("hides a fade still running when a frame of another shape comes", async () => {
    const { worker } = await open(photo(), true);
    await answerRenders(worker, FRAME);
    const fade = fadeCanvas();
    expect(fade?.style.opacity).toBe("1");

    act(() => getRenderBridge().render(false));
    await answerRenders(worker, { width: 1000, height: 1500 });

    expect(developCanvas()?.width).toBe(1000);
    expect(fade?.style.opacity).toBe("0");
    expect(fade?.style.transition).toBe("none");
    await frames(2);
    expect(fade?.style.opacity).toBe("0");
  });

  it.each([
    [100, 0],
    [200, 1],
  ])("opened %i ms after the photo before, eases %i time(s) into its source", async (gap, eases) => {
    const view = await settledOnA();
    const before = copies().length;

    await moveTo(view, shot("b"), gap, true);
    expect(status?.tier).toBe("stored");
    await answerRenders(view.worker, FRAME);

    expect(status?.tier).toBe("final");
    expect(copies().length - before).toBe(eases);
  });

  it("stops a fade still running when it moves to another photo", async () => {
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(shot("a"), true);
    await answerRenders(view.worker, FRAME);
    const fade = fadeCanvas();
    expect(fade?.style.opacity).toBe("1");

    await moveTo(view, shot("b", { thumbnailBlob: null }), 1000, false);
    expect(fade?.style.opacity).toBe("0");
    expect(fade?.style.transition).toBe("none");
    expect(fade?.width).toBe(0);

    await frames(2);
    expect(fade?.style.opacity).toBe("0");
    expect(fade?.style.transition).toBe("none");
  });

  it("cuts when Reduce motion is on", async () => {
    document.documentElement.classList.add("sl-reduce-motion");
    try {
      const { worker } = await open(photo(), true);
      await answerRenders(worker, FRAME);
      await frames(2);
      expect(status?.tier).toBe("final");
      expect(copies()).toEqual([]);
    } finally {
      document.documentElement.classList.remove("sl-reduce-motion");
    }
  });
});

// DevelopView builds a new view per photo, and canvas-handover holds the photo before
// over the new view's blank canvas for a moment (see "DevelopCanvas handing its
// picture" below). A view keeps its picture only while its own photo loads again.
describe("useDevelopRenderer leaving the photo before", () => {
  const shot = (id: string, over: Partial<CatalogPhoto> = {}) =>
    photo({ id, filename: `${id}.jpg`, relPath: `${id}.jpg`, ...over });
  const clears = () => paints.filter((p) => p.op === "clear");

  afterEach(() => {
    vi.useRealTimers();
    status = null;
  });

  // Its folder came back, say: the same photo loads again, and what shows is still it.
  it("keeps the picture of a photo that loads again", async () => {
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(shot("a", { thumbnailBlob: null }), true);
    await answerRenders(view.worker);
    const develop = document.querySelector<HTMLCanvasElement>("canvas:not([data-fade])");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
    await act(async () => {
      useCatalogStore.setState({ fileAccessNonce: useCatalogStore.getState().fileAccessNonce + 1 });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(status?.tier).toBeNull();
    expect(develop?.width).toBe(10);
    expect(status?.width).toBe(10);
    expect(clears()).toEqual([]);
  });

  // Holding the arrow key leaves each photo before its edit has loaded.
  it.each(["closing the view", "moving to another photo"])(
    "lets go of a stored preview decoded for a photo it left before its edit loaded (%s)",
    async (leaving) => {
      useDevelopStore.setState(loaded("previous", edit(0.5)));
      const view = await open(shot("a"));
      expect(decoded).toHaveLength(1);
      expect(decoded[0].closed).toBe(false);

      await act(async () => {
        if (leaving === "closing the view") cleanup();
        else view.rerender(<Develop subject={shot("b")} />);
        await settle();
      });

      expect(decoded[0].closed).toBe(true);
      expect(drawn).not.toContain(decoded[0]);
    },
  );
});

// The canvas's pixels and the box that scales them change together. Drawn ahead of
// its box, a frame of another shape showed stretched to the one before for a frame.
describe("useDevelopRenderer sizing the canvas", () => {
  const LANDSCAPE = { width: 600, height: 400 };
  const PORTRAIT = { width: 400, height: 600 };

  // Each commit where the canvas's box and its pixels disagree, as seen in the layout
  // phase: after React has written the box and before the browser paints.
  let misfits: string[];

  function DevelopInView({ subject }: { subject: CatalogPhoto }) {
    const canvas = useRef<HTMLCanvasElement>(null);
    const fade = useRef<HTMLCanvasElement>(null);
    const [zoom, setZoom] = useState<number | null>(null);
    status = useDevelopRenderer(canvas, subject, fade);
    useLayoutEffect(() => {
      const cv = canvas.current;
      if (!cv || !status || status.width <= 0) return;
      if (cv.style.width !== `${cv.width}px`) misfits.push(`${cv.style.width} vs ${cv.width}px`);
    });
    return (
      <ViewportImage
        canvasRef={canvas}
        fadeCanvasRef={fade}
        bufferWidth={status.width}
        bufferHeight={status.height}
        zoom={zoom}
        onZoomChange={setZoom}
        resetKey={subject.id}
      />
    );
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FixedFrameObserver);
    misfits = [];
  });

  afterEach(() => {
    status = null;
    expect(misfits).toEqual([]);
  });

  /** The frame `request` is answered with, and its bitmap. */
  function frameOf(request: Render, size: { width: number; height: number }) {
    const frame = frameFor(request, size);
    const bitmap = FakeBitmap.made.at(-1);
    if (frame.type !== "frame" || !bitmap) throw new Error("not a frame");
    return { frame, bitmap };
  }

  async function shown(size: { width: number; height: number }) {
    const view = await open(photo({ thumbnailBlob: null }), true, DevelopInView);
    await answerRenders(view.worker, size);
    const develop = view.container.querySelector("canvas");
    if (!develop) throw new Error("no canvas");
    expect(develop.width).toBe(size.width);
    expect(develop.style.width).toBe(`${size.width}px`);
    act(() => getRenderBridge().render(false));
    const next = view.worker.inFlight();
    if (!next) throw new Error("no render in flight");
    return { ...view, develop, next };
  }

  it("draws a frame of another shape in the commit that gives it its box", async () => {
    const { worker, develop, next } = await shown(LANDSCAPE);

    act(() => {
      worker.reply(frameFor(next, PORTRAIT));
      expect(develop.style.width).toBe(`${develop.width}px`);
    });

    expect(develop.width).toBe(PORTRAIT.width);
    expect(develop.style.width).toBe(`${PORTRAIT.width}px`);
    const draws = paints.filter((p) => p.canvas === develop && p.op === "draw");
    expect(draws.length).toBeGreaterThan(1);
    for (const d of draws) expect(d.box).toBe(`${d.width}px`);
  });

  it("draws a frame of the same shape at once, without waiting for a render", async () => {
    const { worker, develop, next } = await shown(LANDSCAPE);
    const before = drawn.length;

    act(() => {
      worker.reply(frameFor(next, LANDSCAPE));
      expect(drawn).toHaveLength(before + 1);
    });
    expect(develop.width).toBe(LANDSCAPE.width);
  });

  it("draws only the newest of two frames of new shapes that come before one commit", async () => {
    const { worker, develop, next } = await shown(LANDSCAPE);
    act(() => getRenderBridge().render(false));
    const square = { width: 500, height: 500 };
    const tall = frameOf(next, PORTRAIT);

    act(() => {
      worker.reply(tall.frame);
      const after = worker.inFlight();
      if (!after) throw new Error("no render in flight");
      worker.reply(frameOf(after, square).frame);
    });

    expect(develop.width).toBe(square.width);
    expect(develop.style.width).toBe(`${square.width}px`);
    expect(drawn).not.toContain(tall.bitmap);
    expect(tall.bitmap.closed).toBe(true);
  });

  it("lets go of a frame still waiting for its box when the view closes", async () => {
    const { worker, next, unmount } = await shown(LANDSCAPE);
    const tall = frameOf(next, PORTRAIT);

    act(() => {
      worker.reply(tall.frame);
      unmount();
    });

    expect(drawn).not.toContain(tall.bitmap);
    expect(tall.bitmap.closed).toBe(true);
  });

  // A frame of the photo before can come after the commit that moves to the next photo
  // and before that commit's effects start the next one. Here it is answered from a
  // layout effect of that commit.
  it("lets go of a frame still waiting for its box when the photo it shows is left", async () => {
    let answerNow: (() => void) | null = null;
    function Moving({ subject }: { subject: CatalogPhoto }) {
      const canvas = useRef<HTMLCanvasElement>(null);
      status = useDevelopRenderer(canvas, subject);
      useLayoutEffect(() => {
        const answer = answerNow;
        answerNow = null;
        answer?.();
      });
      return <canvas ref={canvas} />;
    }
    const a = photo({ id: "a", thumbnailBlob: null });
    const b = photo({ id: "b", thumbnailBlob: null });
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(a, true, Moving);
    await answerRenders(view.worker, LANDSCAPE);
    act(() => getRenderBridge().render(false));
    const next = view.worker.inFlight();
    if (!next) throw new Error("no render in flight");
    const tall = frameOf(next, PORTRAIT);
    answerNow = () => view.worker.reply(tall.frame);

    await act(async () => {
      useDevelopStore.setState({ photoId: "b" });
      view.rerender(<Moving subject={b} />);
    });

    expect(answerNow).toBeNull();
    expect(drawn).not.toContain(tall.bitmap);
    expect(tall.bitmap.closed).toBe(true);
  });

  it("lets go of a frame that comes once the canvas is gone", async () => {
    let withCanvas = true;
    function CanvasGoes({ subject }: { subject: CatalogPhoto }) {
      const canvas = useRef<HTMLCanvasElement>(null);
      status = useDevelopRenderer(canvas, subject);
      return <>{withCanvas && <canvas ref={canvas} />}</>;
    }
    const subject = photo({ thumbnailBlob: null });
    const view = await open(subject, true, CanvasGoes);
    await answerRenders(view.worker, LANDSCAPE);
    withCanvas = false;
    view.rerender(<CanvasGoes subject={subject} />);
    act(() => getRenderBridge().render(false));
    const next = view.worker.inFlight();
    if (!next) throw new Error("no render in flight");
    const late = frameOf(next, LANDSCAPE);

    act(() => view.worker.reply(late.frame));

    expect(drawn).not.toContain(late.bitmap);
    expect(late.bitmap.closed).toBe(true);
  });
});

// DevelopView builds a new DevelopCanvas, with a new display canvas, for every photo.
// The picture the view before showed stays where it was until the next photo's first
// picture, for at most 150 ms, so a switch never shows the bare surround between.
describe("DevelopCanvas handing its picture to the next photo's view", () => {
  const LANDSCAPE = { width: 600, height: 400 };
  const PORTRAIT = { width: 400, height: 600 };
  // A 600×400 picture fitted into the 1000×800 frame.
  const SHOWN_AT = { x: 0, y: (800 - 400 * (1000 / 600)) / 2, w: 1000, h: 400 * (1000 / 600) };
  const shot = (id: string) =>
    photo({ id, filename: `${id}.jpg`, relPath: `${id}.jpg`, thumbnailBlob: null });

  // What each commit that builds or drops a view leaves on screen, as the parent's
  // layout effect sees it after the views' own.
  let commits: { display: HTMLCanvasElement | null; picture: boolean; handover: boolean }[];
  let inDevelop: boolean;

  const display = () =>
    document.querySelector<HTMLCanvasElement>("canvas:not([aria-hidden]):not([data-handover])");
  const handoverCanvas = () => document.querySelector<HTMLCanvasElement>("canvas[data-handover]");
  const showing = (c: HTMLCanvasElement | null) =>
    !!c && c.style.display !== "none" && c.width > 0;
  const drawnOn = (c: HTMLCanvasElement | null) =>
    paints.some((p) => p.canvas === c && p.op === "draw");

  function Viewer({ subject }: { subject: CatalogPhoto }) {
    useLayoutEffect(() => {
      const shown = display();
      commits.push({ display: shown, picture: drawnOn(shown), handover: showing(handoverCanvas()) });
    });
    if (!inDevelop) return <></>;
    return <DevelopCanvas key={subject.id} photo={subject} zoom={null} onZoomChange={() => {}} />;
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FixedFrameObserver);
    commits = [];
    inDevelop = true;
  });

  afterEach(() => {
    endHandover();
    vi.useRealTimers();
    status = null;
  });

  /** Photo "a" open in its view, its picture drawn. From here on the clock moves only
   *  with the fake timers, so the 150 ms cap runs when a test says. */
  async function openA(strict = false) {
    useDevelopStore.setState({ photoId: "a" });
    const view = await open(shot("a"), true, Viewer, strict);
    await answerRenders(view.worker, LANDSCAPE);
    expect(drawnOn(display())).toBe(true);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance"],
      shouldClearNativeTimers: true,
    });
    return view;
  }

  /** Moves to `next`, whose view is built in place of the one before. */
  async function moveTo(view: Awaited<ReturnType<typeof open>>, next: CatalogPhoto, hit = false) {
    FakeWorker.hits = hit;
    const answered = new Set(
      view.worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
    );
    await act(async () => {
      useDevelopStore.setState({ photoId: next.id });
      view.rerender(<Viewer subject={next} />);
    });
    return answered;
  }

  it("shows the photo before where it was, in the commit that builds the next view", async () => {
    const view = await openA();
    const before = display();
    commits = [];

    await moveTo(view, shot("b"));

    const handover = handoverCanvas();
    expect(display()).not.toBe(before);
    expect(commits[0]).toMatchObject({ picture: false, handover: true });
    expect(paints.filter((p) => p.canvas === handover && p.op === "draw").map((p) => p.image))
      .toEqual([before]);
    expect(handover?.width).toBe(LANDSCAPE.width);
    expect(handover?.height).toBe(LANDSCAPE.height);
    expect(parseFloat(handover?.style.left ?? "")).toBeCloseTo(SHOWN_AT.x);
    expect(parseFloat(handover?.style.top ?? "")).toBeCloseTo(SHOWN_AT.y);
    expect(parseFloat(handover?.style.width ?? "")).toBeCloseTo(SHOWN_AT.w);
    expect(parseFloat(handover?.style.height ?? "")).toBeCloseTo(SHOWN_AT.h);
    expect(handover?.style.pointerEvents).toBe("none");
  });

  // Its folder came back, say: the photo loads again, and its last picture stays on
  // screen until the new one, so that is what the next view gets.
  it("hands over the photo's picture while the photo loads again", async () => {
    const view = await openA();
    const a = display();
    await act(async () => {
      useCatalogStore.setState({ fileAccessNonce: useCatalogStore.getState().fileAccessNonce + 1 });
    });

    await moveTo(view, shot("b"));

    const handover = handoverCanvas();
    expect(showing(handover)).toBe(true);
    expect(paints.filter((p) => p.canvas === handover && p.op === "draw").map((p) => p.image))
      .toEqual([a]);
  });

  it("hides it in the commit that draws the next photo's first picture, of any shape", async () => {
    const view = await openA();
    const answered = await moveTo(view, shot("b"), true);
    const handover = handoverCanvas();

    await act(async () => {
      answerBinds(view.worker, true, answered);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(showing(handover)).toBe(true);
    expect(handover?.width).toBe(LANDSCAPE.width);
    await answerRenders(view.worker, PORTRAIT);

    expect(drawnOn(display())).toBe(true);
    expect(display()?.width).toBe(PORTRAIT.width);
    expect(showing(handover)).toBe(false);
    expect(handover?.width).toBe(0);
  });

  it("hides it 150 ms after it was left when the next photo has drawn nothing", async () => {
    const view = await openA();
    await moveTo(view, shot("b"));
    const handover = handoverCanvas();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(showing(handover)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(showing(handover)).toBe(false);
    expect(handover?.width).toBe(0);
  });

  it("still shows it when React runs the new view's effects twice", async () => {
    const view = await openA(true);
    const a = display();
    commits = [];
    await moveTo(view, shot("b"));
    const handover = handoverCanvas();
    expect(commits[0]).toMatchObject({ handover: true });
    expect(showing(handover)).toBe(true);
    const copied = paints.filter((p) => p.canvas === handover && p.op === "draw");
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.every((p) => p.image === a)).toBe(true);
  });

  // It holds a picture still; nothing moves.
  it("shows it under Reduce motion too", async () => {
    document.documentElement.classList.add("sl-reduce-motion");
    try {
      const view = await openA();
      await moveTo(view, shot("b"));
      expect(showing(handoverCanvas())).toBe(true);
    } finally {
      document.documentElement.classList.remove("sl-reduce-motion");
    }
  });

  it("frames it in the colour-assessment mat the photo before had", async () => {
    const assessing = useDevelopStore.getState().colorAssessment;
    useDevelopStore.setState({ colorAssessment: true });
    try {
      const view = await openA();
      await moveTo(view, shot("b"));
      const border = assessMatPx(1000, 800, useSettings.getState().assessBorderPct / 100);
      expect(handoverCanvas()?.style.boxShadow).toContain(`${border}px`);
    } finally {
      useDevelopStore.setState({ colorAssessment: assessing });
    }
  });

  it("shows the last picture through a quick run of views with none, and one at a time", async () => {
    const view = await openA();
    const a = display();
    await moveTo(view, shot("b"));
    const bHandover = handoverCanvas();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    await moveTo(view, shot("c"));
    const cHandover = handoverCanvas();

    expect(cHandover).not.toBe(bHandover);
    expect(bHandover?.width).toBe(0);
    expect(document.querySelectorAll("canvas[data-handover]")).toHaveLength(1);
    expect(showing(cHandover)).toBe(true);
    expect(paints.filter((p) => p.canvas === cHandover && p.op === "draw").map((p) => p.image))
      .toEqual([a]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(89);
    });
    expect(showing(cHandover)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(showing(cHandover)).toBe(false);
  });

  it("lets the picture go when Develop closes, and shows none on the next open", async () => {
    const view = await openA();
    await moveTo(view, shot("b"));
    const handover = handoverCanvas();
    expect(showing(handover)).toBe(true);

    inDevelop = false;
    await act(async () => {
      view.rerender(<Viewer subject={shot("b")} />);
    });
    expect(handover?.width).toBe(0);

    inDevelop = true;
    await act(async () => {
      useDevelopStore.setState({ photoId: "c" });
      view.rerender(<Viewer subject={shot("c")} />);
    });
    expect(showing(handoverCanvas())).toBe(false);
  });
});

describe("useDevelopRenderer labelling what it shows", () => {
  afterEach(() => {
    vi.useRealTimers();
    status = null;
  });

  // Reloading the photo (its folder came back) loads it from the start: its label
  // waits again, and can say Full quality again.
  it("starts the label over when the photo loads again", async () => {
    let release = () => {};
    holdSource = new Promise<void>((r) => (release = r));
    const { worker } = await open(photo());
    expect(status?.tier).toBe("stored");
    // The first open's label waits on the real clock, started as the view opened.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    expect(status?.status).toBe("Preview");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
    const answered = new Set(
      worker.posted.flatMap((m) => (m.cmd === "bindSource" ? [m.reqId] : [])),
    );

    await act(async () => {
      useCatalogStore.setState({ fileAccessNonce: useCatalogStore.getState().fileAccessNonce + 1 });
    });
    expect(status?.tier).toBeNull();
    expect(status?.status).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(status?.status).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(status?.status).toBe("Loading…");

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
      answerBinds(worker, false, answered);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(status?.status).toBe("Preview");
    await answerRenders(worker);
    expect(status?.tier).toBe("final");
    expect(status?.status).toBe("Full quality");
  });
});

// The corner of the canvas says how good what it shows is, once a photo takes long
// enough to open for it to matter.
describe("useTierLabel", () => {
  type Props = { tier: DevelopTier | null; loading: boolean; photoId: string };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function label(initial: Partial<Props> = {}) {
    return renderHook((p: Props) => useTierLabel(p.tier, p.loading, p.photoId), {
      initialProps: { tier: null, loading: true, photoId: "a", ...initial },
    });
  }

  const after = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it("says Preview once a preview has shown for 300 ms", () => {
    const view = label({ tier: "stored" });
    after(299);
    expect(view.result.current).toBeNull();
    after(1);
    expect(view.result.current).toBe("Preview");
    view.rerender({ tier: "preview", loading: true, photoId: "a" });
    expect(view.result.current).toBe("Preview");
  });

  it("says Full quality for about a second when the full image replaces a Preview", () => {
    const view = label({ tier: "stored" });
    after(300);
    view.rerender({ tier: "final", loading: false, photoId: "a" });
    expect(view.result.current).toBe("Full quality");
    after(999);
    expect(view.result.current).toBe("Full quality");
    after(1);
    expect(view.result.current).toBeNull();
  });

  it("says nothing when the full image comes within 300 ms", () => {
    const view = label({ tier: "stored" });
    after(200);
    view.rerender({ tier: "final", loading: false, photoId: "a" });
    expect(view.result.current).toBeNull();
    after(2000);
    expect(view.result.current).toBeNull();
  });

  it("keeps saying Preview when the photo settles on a preview", () => {
    const view = label({ tier: "preview" });
    after(300);
    view.rerender({ tier: "preview", loading: false, photoId: "a" });
    after(5000);
    expect(view.result.current).toBe("Preview");
  });

  it("says Loading… while nothing of the photo shows, and nothing once that load fails", () => {
    const view = label();
    after(300);
    expect(view.result.current).toBe("Loading…");
    view.rerender({ tier: null, loading: false, photoId: "a" });
    expect(view.result.current).toBeNull();
  });

  it("goes from Loading… to Preview, and says Full quality only after a Preview", () => {
    const view = label();
    after(300);
    view.rerender({ tier: "preview", loading: true, photoId: "a" });
    expect(view.result.current).toBe("Preview");

    const quick = label();
    after(300);
    expect(quick.result.current).toBe("Loading…");
    quick.rerender({ tier: "final", loading: false, photoId: "a" });
    expect(quick.result.current).toBeNull();
  });

  it("starts over for the next photo", () => {
    const view = label({ tier: "preview" });
    after(300);
    expect(view.result.current).toBe("Preview");

    view.rerender({ tier: null, loading: true, photoId: "b" });
    expect(view.result.current).toBeNull();
    view.rerender({ tier: "stored", loading: true, photoId: "b" });
    after(299);
    expect(view.result.current).toBeNull();
    after(1);
    expect(view.result.current).toBe("Preview");
  });
});

// What Develop says when it can't show the photo's edits, in plain words.
describe("DevelopCanvas saying why it shows no edits", () => {
  const develop = <DevelopCanvas photo={photo()} zoom={null} onZoomChange={() => {}} />;
  const says = (text: string) => document.body.textContent?.includes(text) ?? false;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FixedFrameObserver);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(console.error).mockRestore();
  });

  it("while it tries again to start drawing", () => {
    render(develop);
    act(() => renderWorker().reply({ type: "initError", message: "WebGL2 not supported" }));
    expect(says("Can't show images right now. Trying again…")).toBe(true);
  });

  it("once it has stopped trying", () => {
    render(develop);
    for (let attempt = 0; attempt < 10; attempt++) {
      act(() => {
        renderWorker().reply({ type: "initError", message: "WebGL2 not supported" });
        vi.advanceTimersByTime(30_000);
      });
    }
    expect(says("Can't show images right now. Restart Safelight.")).toBe(true);
  });

  it("on a computer that can't draw edits", () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });
    render(develop);
    expect(says("Can't show edits on this computer. Showing the unedited preview.")).toBe(true);
  });
});
