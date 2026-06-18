import type { DevelopParams } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { resolveActivePipeline, usePipelineStore } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import type { HistogramData } from "./histogram";
import type { WorkerRequest, WorkerResponse } from "./render-worker";

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
type ErrorCallback = (message: string) => void;

export class RenderBridge {
  private worker: Worker;
  private readyResolve: (() => void) | null = null;
  readonly ready: Promise<void>;
  private onFrame: FrameCallback | null = null;
  private onHistogram: HistogramCallback | null = null;
  private onThumbnail: ThumbnailCallback | null = null;
  private onError: ErrorCallback | null = null;
  private disposed = false;
  private thumbResolvers = new Map<string, (blob: Blob) => void>();

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
  // Parameters
  // ------------------------------------------------------------------

  setParams(params: DevelopParams) {
    this.post({ cmd: "setParams", params });
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
    return new Promise<Blob>((resolve) => {
      this.thumbResolvers.set(opts.requestId, resolve);
      this.renderThumbnail(opts);
    });
  }

  // ------------------------------------------------------------------
  // Display overlays
  // ------------------------------------------------------------------

  setShowClipping(mode: number) {
    this.post({ cmd: "setShowClipping", mode });
  }

  computeHistogram(wantExtended?: boolean) {
    this.post({ cmd: "computeHistogram", wantExtended });
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

    let prevStages = useRegistry.getState().processingStages;
    let prevPipelines = useRegistry.getState().pipelines;
    unsubStages = useRegistry.subscribe((s) => {
      if (s.processingStages !== prevStages) {
        prevStages = s.processingStages;
        syncStages();
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
