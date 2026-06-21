import type { DevelopParams, UprightMode } from "@/catalog/types";
import type { UprightResult } from "./upright";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { resolveActivePipeline, usePipelineStore } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import type { HistogramData } from "./histogram";
import type { WorkerRequest, WorkerResponse } from "./render-worker";
import { getSettings, useSettings } from "@/state/settings-store";

export interface FrameResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  histogram?: HistogramData;
}

export interface ThumbnailResult {
  requestId: string;
  blob: Blob;
}

type FrameCallback = (frame: FrameResult) => void;
type HistogramCallback = (histogram: HistogramData) => void;
type ThumbnailCallback = (result: ThumbnailResult) => void;
type UprightCallback = (result: UprightResult) => void;
type ErrorCallback = (message: string) => void;

export class RenderBridge {
  private worker: Worker;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;
  private onFrame: FrameCallback | null = null;
  private onHistogram: HistogramCallback | null = null;
  private onThumbnail: ThumbnailCallback | null = null;
  private onUpright: UprightCallback | null = null;
  private onError: ErrorCallback | null = null;
  private disposed = false;
  // Resolves with the rendered blob, or null when the worker reports a cache miss
  // (the caller then decodes + uploads + retries).
  private thumbResolvers = new Map<string, (blob: Blob | null) => void>();
  private uprightResolve: ((result: UprightResult) => void) | null = null;
  private sourceBoundResolvers = new Map<number, (hit: boolean) => void>();
  private hasSourceResolvers = new Map<number, (has: boolean) => void>();
  private captureResolvers = new Map<number, (bitmap: ImageBitmap) => void>();
  private reqIdSeq = 0;

  constructor() {
    this.worker = new Worker(
      new URL("./render-worker.ts", import.meta.url),
      { type: "module" },
    );
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.worker.onmessage = this.handleMessage;
    this.worker.onerror = (e) => {
      this.onError?.(e.message ?? "Worker error");
    };
  }

  private handleMessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    switch (msg.type) {
      case "ready":
        this.readyResolve?.();
        this.readyResolve = null;
        break;
      case "frame":
        this.onFrame?.({
          bitmap: msg.bitmap,
          width: msg.width,
          height: msg.height,
          histogram: msg.histogram,
        });
        break;
      case "histogram":
        this.onHistogram?.(msg.histogram);
        break;
      case "thumbnail": {
        const resolver = this.thumbResolvers.get(msg.requestId);
        if (resolver) {
          this.thumbResolvers.delete(msg.requestId);
          resolver(msg.blob);
        }
        this.onThumbnail?.({ requestId: msg.requestId, blob: msg.blob });
        break;
      }
      case "thumbnailMiss": {
        const resolver = this.thumbResolvers.get(msg.requestId);
        if (resolver) {
          this.thumbResolvers.delete(msg.requestId);
          resolver(null);
        }
        break;
      }
      case "sourceBound": {
        const resolver = this.sourceBoundResolvers.get(msg.reqId);
        if (resolver) {
          this.sourceBoundResolvers.delete(msg.reqId);
          resolver(msg.hit);
        }
        break;
      }
      case "hasSource": {
        const resolver = this.hasSourceResolvers.get(msg.reqId);
        if (resolver) {
          this.hasSourceResolvers.delete(msg.reqId);
          resolver(msg.has);
        }
        break;
      }
      case "captured": {
        const resolver = this.captureResolvers.get(msg.reqId);
        if (resolver) {
          this.captureResolvers.delete(msg.reqId);
          resolver(msg.bitmap);
        }
        break;
      }
      case "upright":
        if (this.uprightResolve) {
          this.uprightResolve(msg.result);
          this.uprightResolve = null;
        }
        this.onUpright?.(msg.result);
        break;
      case "error":
        this.onError?.(msg.message);
        break;
    }
  };

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  init(width: number, height: number) {
    this.post({ cmd: "init", width, height });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.post({ cmd: "dispose" });
    this.worker.terminate();
  }

  // ------------------------------------------------------------------
  // Callbacks
  // ------------------------------------------------------------------

  setOnFrame(cb: FrameCallback | null) { this.onFrame = cb; }
  setOnHistogram(cb: HistogramCallback | null) { this.onHistogram = cb; }
  setOnThumbnail(cb: ThumbnailCallback | null) { this.onThumbnail = cb; }
  setOnUpright(cb: UprightCallback | null) { this.onUpright = cb; }
  setOnError(cb: ErrorCallback | null) { this.onError = cb; }

  // ------------------------------------------------------------------
  // Image data
  // ------------------------------------------------------------------

  setImage(
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap },
    maxEdge?: number,
    isFallbackPreview?: boolean,
    baseCurveForBitmap?: boolean,
  ) {
    const transfer: Transferable[] = [];
    if (image.kind === "float") {
      transfer.push(image.data.buffer);
    } else if (image.kind === "srgb16") {
      transfer.push(image.data.buffer);
    } else {
      transfer.push(image.bitmap);
    }
    this.post(
      { cmd: "setImage", image, maxEdge, isFallbackPreview, baseCurveForBitmap },
      transfer,
    );
  }

  // ------------------------------------------------------------------
  // GPU source cache
  // ------------------------------------------------------------------

  /** Bind a resident source as the develop renderer's active image. Resolves
   *  true on a cache hit, false if the caller must decode + uploadSource. */
  bindSource(key: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.sourceBoundResolvers.set(reqId, resolve);
      this.post({ cmd: "bindSource", reqId, key });
    });
  }

  uploadSource(
    target: "main" | "thumb",
    key: string,
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap },
    maxEdge?: number,
    isFallbackPreview?: boolean,
    baseCurveForBitmap?: boolean,
    // false = upload into the cache without changing the active source (prefetch).
    bind = true,
  ) {
    const transfer: Transferable[] = [];
    if (image.kind === "float") transfer.push(image.data.buffer);
    else if (image.kind === "srgb16") transfer.push(image.data.buffer);
    else transfer.push(image.bitmap);
    this.post(
      { cmd: "uploadSource", target, key, image, maxEdge, isFallbackPreview, baseCurveForBitmap, bind },
      transfer,
    );
  }

  /** Is a source already resident in the given renderer's cache? */
  hasSource(target: "main" | "thumb", key: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.hasSourceResolvers.set(reqId, resolve);
      this.post({ cmd: "hasSource", reqId, target, key });
    });
  }

  setCacheBudget(bytes: number) {
    this.post({ cmd: "setCacheBudget", bytes });
  }

  setViewport(
    roi: { x: number; y: number; w: number; h: number } | null,
    outW?: number,
    outH?: number,
  ) {
    this.post({ cmd: "setViewport", roi, outW, outH });
  }

  // Render a thumbnail from a resident source. Resolves null on a cache miss so
  // the caller can decode + uploadSource("thumb", …) and retry.
  renderThumbnailFromSource(opts: {
    requestId: string;
    key: string;
    params: DevelopParams;
    asShotTemperature: number;
    maxEdge: number;
    quality?: number;
  }): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      this.thumbResolvers.set(opts.requestId, resolve);
      this.post({ cmd: "renderThumbnailFromSource", ...opts });
    });
  }

  // ------------------------------------------------------------------
  // Parameters
  // ------------------------------------------------------------------

  setParams(params: DevelopParams) {
    this.post({ cmd: "setParams", params });
  }

  /** Generic param bag for extension-contributed processing-stage uniforms,
   *  keyed by qualified key "{stageId}.{key}". Pushed to both the develop and
   *  thumbnail renderers in the worker. */
  setContributedParams(bag: Record<string, unknown>) {
    this.post({ cmd: "setContributedParams", bag });
  }

  /** Pixel data (baked LUT atlases, etc.) for processing-stage textures, keyed
   *  by qualified key "{stageId}.{key}". Structured-cloned to the worker (not
   *  transferred) so the caller keeps its buffers and can re-push on a swap. */
  setStageTextures(bag: Record<string, import("@/extensions/types").StageTextureData>) {
    this.post({ cmd: "setStageTextures", bag });
  }

  /** Render one frame with `params` (at the current source + viewport) to an
   *  ImageBitmap, without touching the live display. Used to grab a "before"
   *  frame for before/after comparison overlays. The live params are restored
   *  in the worker afterwards. */
  capture(params: DevelopParams): Promise<ImageBitmap> {
    return new Promise<ImageBitmap>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.captureResolvers.set(reqId, resolve);
      this.post({ cmd: "capture", reqId, params });
    });
  }

  setLensProfile(profile: import("@/lens-profiles/types").ResolvedProfile | null) {
    this.post({ cmd: "setLensProfile", profile });
  }

  setAsShotTemperature(kelvin: number) {
    this.post({ cmd: "setAsShotTemperature", kelvin });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  render(wantHistogram?: boolean, wantExtended?: boolean) {
    this.post({ cmd: "render", wantHistogram, wantExtended });
  }

  renderThumbnail(opts: {
    requestId: string;
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap };
    params: DevelopParams;
    asShotTemperature: number;
    maxEdge: number;
    quality?: number;
  }) {
    const transfer: Transferable[] = [];
    if (opts.image.kind === "float") {
      transfer.push(opts.image.data.buffer);
    } else if (opts.image.kind === "srgb16") {
      transfer.push(opts.image.data.buffer);
    } else {
      transfer.push(opts.image.bitmap);
    }
    this.post({ cmd: "renderThumbnail", ...opts }, transfer);
  }

  renderThumbnailAsync(opts: {
    requestId: string;
    image:
      | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
      | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
      | { kind: "bitmap"; bitmap: ImageBitmap };
    params: DevelopParams;
    asShotTemperature: number;
    maxEdge: number;
    quality?: number;
  }): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      this.thumbResolvers.set(opts.requestId, (blob) =>
        blob ? resolve(blob) : reject(new Error("thumbnail render failed")),
      );
      this.renderThumbnail(opts);
    });
  }

  // ------------------------------------------------------------------
  // Display overlays
  // ------------------------------------------------------------------

  setShowClipping(mode: number) {
    this.post({ cmd: "setShowClipping", mode });
  }

  // Coverage overlay: tint the given mask index (or -1 = off) in `color` at
  // `strength` (animated fade).
  setMaskViz(index: number, color: [number, number, number], strength: number) {
    this.post({ cmd: "setMaskViz", index, color, strength });
  }

  computeHistogram(wantExtended?: boolean) {
    this.post({ cmd: "computeHistogram", wantExtended });
  }

  computeUpright(mode: UprightMode): Promise<UprightResult> {
    return new Promise<UprightResult>((resolve) => {
      this.uprightResolve = resolve;
      this.post({ cmd: "analyzeUpright", mode });
    });
  }

  // ------------------------------------------------------------------
  // Extension stages & pipeline
  // ------------------------------------------------------------------

  setStages(stages: ProcessingStageContribution[]) {
    this.post({ cmd: "setStages", stages });
  }

  setPipeline(pipeline: ResolvedPipeline) {
    this.post({ cmd: "setPipeline", pipeline });
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private post(msg: WorkerRequest, transfer?: Transferable[]) {
    if (this.disposed) return;
    if (transfer) {
      this.worker.postMessage(msg, transfer);
    } else {
      this.worker.postMessage(msg);
    }
  }
}

// Singleton bridge — shared across all hooks that need rendering.
let singleton: RenderBridge | null = null;
let unsubStages: (() => void) | null = null;
let unsubPipeline: (() => void) | null = null;

// Stage textures live here (not in the per-photo param bag — they're bulk static
// data tied to the stage, not the edit). Extensions push via api.setStageTexture;
// the bag is replayed when the bridge (re)initialises.
const stageTextures: Record<string, import("@/extensions/types").StageTextureData> = {};

// Stage and stage-texture changes don't flow through the param-driven develop
// render effect, so an extension swapping a stage or its textures (e.g. picking
// a film stock) wouldn't repaint until the next interaction. Redraw here,
// rAF-debounced so a swap (re-register + N texture uploads) coalesces into one.
let stageRenderRaf: number | null = null;
function requestStageRender(): void {
  if (!singleton || stageRenderRaf != null) return;
  stageRenderRaf = requestAnimationFrame(() => {
    stageRenderRaf = null;
    singleton?.render(false);
  });
}

/** Set or clear (null) a processing stage's texture by qualified key
 *  "{stageId}.{key}". Forwards the full bag to the worker. */
export function setStageTexture(
  qualifiedKey: string,
  tex: import("@/extensions/types").StageTextureData | null,
): void {
  if (tex) stageTextures[qualifiedKey] = tex;
  else delete stageTextures[qualifiedKey];
  singleton?.setStageTextures(stageTextures);
  requestStageRender();
}

function syncStages() {
  if (!singleton) return;
  const stages = useRegistry.getState().processingStages;
  singleton.setStages(Object.values(stages));
}

function syncPipeline() {
  if (!singleton) return;
  singleton.setPipeline(resolveActivePipeline());
}

export function getRenderBridge(): RenderBridge {
  if (!singleton) {
    singleton = new RenderBridge();
    singleton.init(2560, 2560);

    syncStages();
    syncPipeline();
    // Replay any stage textures registered before the bridge existed.
    if (Object.keys(stageTextures).length > 0) singleton.setStageTextures(stageTextures);

    // Push the GPU source-cache budget now and whenever the preference changes.
    singleton.setCacheBudget(getSettings().gpuSourceCacheBytes);
    let prevBudget = getSettings().gpuSourceCacheBytes;
    useSettings.subscribe((s) => {
      if (s.gpuSourceCacheBytes !== prevBudget) {
        prevBudget = s.gpuSourceCacheBytes;
        singleton?.setCacheBudget(prevBudget);
      }
    });

    let prevStages = useRegistry.getState().processingStages;
    let prevPipelines = useRegistry.getState().pipelines;
    unsubStages = useRegistry.subscribe((s) => {
      if (s.processingStages !== prevStages) {
        prevStages = s.processingStages;
        syncStages();
        requestStageRender();
      }
      if (s.pipelines !== prevPipelines) {
        prevPipelines = s.pipelines;
        syncPipeline();
      }
    });
    unsubPipeline = usePipelineStore.subscribe(() => syncPipeline());
  }
  return singleton;
}

export function disposeRenderBridge() {
  unsubStages?.();
  unsubStages = null;
  unsubPipeline?.();
  unsubPipeline = null;
  singleton?.dispose();
  singleton = null;
}
