// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams, UprightMode } from "@/catalog/types";
import type { UprightResult } from "./upright";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
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
type HealSourceCallback = (src: { data: Uint8ClampedArray; width: number; height: number }) => void;

export class RenderBridge {
  private worker: Worker;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;
  // Whether the worker's WebGL2 context has renderable float color buffers. Set
  // from the "ready" message; governs the pipeline's working precision (see
  // WebGLRenderer.colorBufferFloat). Undefined until ready resolves.
  pipelineFloat: boolean | undefined;
  private onFrame: FrameCallback | null = null;
  private onHistogram: HistogramCallback | null = null;
  private onThumbnail: ThumbnailCallback | null = null;
  private onUpright: UprightCallback | null = null;
  private onError: ErrorCallback | null = null;
  private onHealSource: HealSourceCallback | null = null;
  private disposed = false;
  // Resolves with the rendered blob, or null when the worker reports a cache miss
  // (the caller then decodes + uploads + retries).
  private thumbResolvers = new Map<string, (blob: Blob | null) => void>();
  private uprightResolvers = new Map<number, (result: UprightResult) => void>();
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
        this.pipelineFloat = msg.pipelineFloat;
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
      case "thumbnailError": {
        // Reject the pending request (resolver(null) -> renderThumbnailAsync
        // rejects) so the caller stops awaiting and can retry on the next edit,
        // then surface the underlying cause for diagnosis.
        const resolver = this.thumbResolvers.get(msg.requestId);
        if (resolver) {
          this.thumbResolvers.delete(msg.requestId);
          resolver(null);
        }
        this.onError?.(`thumbnail render failed: ${msg.message}`);
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
      case "upright": {
        const resolver = this.uprightResolvers.get(msg.reqId);
        if (resolver) {
          this.uprightResolvers.delete(msg.reqId);
          resolver(msg.result);
        }
        this.onUpright?.(msg.result);
        break;
      }
      case "uprightError": {
        // Settle the pending computeUpright with a zero (no-op) result so the
        // awaiting caller unblocks instead of hanging, then surface the cause.
        const resolver = this.uprightResolvers.get(msg.reqId);
        if (resolver) {
          this.uprightResolvers.delete(msg.reqId);
          resolver({ straighten: 0, perspectiveV: 0, perspectiveH: 0 });
        }
        this.onError?.(`upright analysis failed: ${msg.message}`);
        break;
      }
      case "healSource":
        this.onHealSource?.({ data: msg.data, width: msg.width, height: msg.height });
        break;
      case "error":
        // Not tied to a request, so per-request resolvers can't be settled from
        // here; each request path posts its own settling response on failure.
        this.onError?.(msg.message);
        break;
    }
  };

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  init(width: number, height: number) {
    // The worker's settings-store can't reach localStorage, so read the
    // High-bit-depth preference here (main thread) and hand it across.
    this.post({ cmd: "init", width, height, highBitDepth: getSettings().highBitDepth });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // terminate() tears down the worker (and its GL context) synchronously; a
    // "dispose" message would be preempted by it, so don't bother sending one.
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
  setOnHealSource(cb: HealSourceCallback | null) { this.onHealSource = cb; }

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
    // Per-render extension-stage params; the thumb renderer applies these for
    // this render only, so a photo other than the live develop one renders with
    // its own stage params rather than the active photo's.
    contributedParams?: Record<string, unknown>;
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
  setStageTextures(bag: Record<string, StageTextureData>) {
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

  setAsShotTemperature(kelvin: number) {
    this.post({ cmd: "setAsShotTemperature", kelvin });
  }

  /** Global HSL band shaping (Preferences ▸ HSL): range scales band widths,
   *  smooth blends the falloff. Applies to the live develop renderer. */
  setHslStyle(range: number, smooth: number) {
    this.post({ cmd: "setHslStyle", range, smooth });
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
    contributedParams?: Record<string, unknown>;
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
    contributedParams?: Record<string, unknown>;
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

  // Colour (display-space, 0..1) for out-of-image crop-mode margins, so the
  // develop view frames the photo in the canvas surround rather than black.
  setOutsideColor(rgb: [number, number, number]) {
    this.post({ cmd: "setOutsideColor", rgb });
  }

  // Coverage overlay: tint the given mask index (or -1 = off) in `color` at
  // `strength` (animated fade).
  setMaskViz(index: number, color: [number, number, number], strength: number) {
    this.post({ cmd: "setMaskViz", index, color, strength });
  }

  // Sharpening preview (Alt/Ctrl-drag): 0 = off, 1 = masking, 2 = detail, 3 = luma.
  setSharpenViz(mode: number) {
    this.post({ cmd: "setSharpenViz", mode });
  }

  computeHistogram(wantExtended?: boolean) {
    this.post({ cmd: "computeHistogram", wantExtended });
  }

  computeUpright(mode: UprightMode): Promise<UprightResult> {
    return new Promise<UprightResult>((resolve) => {
      const reqId = ++this.reqIdSeq;
      this.uprightResolvers.set(reqId, resolve);
      this.post({ cmd: "analyzeUpright", reqId, mode });
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
let unsubSettings: (() => void) | null = null;

// Stage textures live here (not in the per-photo param bag — they're bulk static
// data tied to the stage, not the edit). Extensions push via api.setStageTexture;
// the bag is replayed when the bridge (re)initialises.
const stageTextures: Record<string, StageTextureData> = {};

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
  tex: StageTextureData | null,
): void {
  if (tex) stageTextures[qualifiedKey] = tex;
  else delete stageTextures[qualifiedKey];
  singleton?.setStageTextures(stageTextures);
  requestStageRender();
}

/** The current stage-texture bag (qualified key → data). Returned by reference;
 *  callers must not mutate. Used by the export pipeline to seed its own renderer
 *  with the same film LUTs / spectral tables the live renderer has, so stages
 *  that depend on uploaded textures (e.g. Spektrafilm) don't render black. */
export function getStageTextures(): Record<string, StageTextureData> {
  return stageTextures;
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
    unsubSettings = useSettings.subscribe((s) => {
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
        // A pipeline (display-transform) swap is silent like a stage swap:
        // it updates renderer state but isn't param-driven, so force a redraw.
        requestStageRender();
      }
    });
    unsubPipeline = usePipelineStore.subscribe(() => {
      syncPipeline();
      // Switching the active display transform must repaint, else the canvas
      // keeps showing the previous transform until the next interaction.
      requestStageRender();
    });
  }
  return singleton;
}

export function disposeRenderBridge() {
  unsubStages?.();
  unsubStages = null;
  unsubPipeline?.();
  unsubPipeline = null;
  unsubSettings?.();
  unsubSettings = null;
  singleton?.dispose();
  singleton = null;
}
