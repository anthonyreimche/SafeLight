import type { DevelopParams } from "@/catalog/types";
import type { ResolvedProfile } from "@/lens-profiles/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { BUILTIN_RESOLVED } from "@/extensions/pipelines";
import { WebGLRenderer } from "./webgl/renderer";
import type { HistogramData } from "./histogram";

// ---------------------------------------------------------------------------
// Message types (worker ↔ main thread)
// ---------------------------------------------------------------------------

export type WorkerRequest =
  | { cmd: "init"; width: number; height: number }
  | {
      cmd: "setImage";
      image:
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
        | { kind: "bitmap"; bitmap: ImageBitmap };
      maxEdge?: number;
      isFallbackPreview?: boolean;
      baseCurveForBitmap?: boolean;
    }
  | { cmd: "setParams"; params: DevelopParams }
  | { cmd: "setLensProfile"; profile: ResolvedProfile | null }
  | { cmd: "setAsShotTemperature"; kelvin: number }
  | { cmd: "render"; wantHistogram?: boolean; wantExtended?: boolean }
  | {
      cmd: "renderThumbnail";
      requestId: string;
      image:
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
        | { kind: "bitmap"; bitmap: ImageBitmap };
      params: DevelopParams;
      asShotTemperature: number;
      maxEdge: number;
      quality?: number;
    }
  | { cmd: "setShowClipping"; mode: number }
  | { cmd: "computeHistogram"; wantExtended?: boolean }
  | { cmd: "setStages"; stages: ProcessingStageContribution[] }
  | { cmd: "setPipeline"; pipeline: ResolvedPipeline }
  | { cmd: "dispose" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "frame"; bitmap: ImageBitmap; width: number; height: number; histogram?: HistogramData }
  | { type: "histogram"; histogram: HistogramData }
  | { type: "thumbnail"; requestId: string; blob: Blob }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let canvas: OffscreenCanvas | null = null;
let renderer: WebGLRenderer | null = null;

// Separate offscreen canvas + renderer for thumbnails so a thumbnail render
// doesn't clobber the develop canvas mid-frame.
let thumbCanvas: OffscreenCanvas | null = null;
let thumbRenderer: WebGLRenderer | null = null;

let latestStages: ProcessingStageContribution[] = [];
let latestPipeline: ResolvedPipeline = BUILTIN_RESOLVED;

function ensureThumbRenderer(): WebGLRenderer {
  if (thumbRenderer) return thumbRenderer;
  thumbCanvas = new OffscreenCanvas(512, 512);
  thumbRenderer = new WebGLRenderer(thumbCanvas, {
    highBitDepth: false,
    pipeline: latestPipeline,
    stages: latestStages,
  });
  return thumbRenderer;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.cmd) {
      case "init": {
        canvas = new OffscreenCanvas(msg.width, msg.height);
        renderer = new WebGLRenderer(canvas, {
          highBitDepth: true,
          pipeline: BUILTIN_RESOLVED,
          stages: [],
        });
        respond({ type: "ready" });
        break;
      }

      case "setImage": {
        if (!renderer) break;
        const img = msg.image;
        if (img.kind === "bitmap") {
          renderer.setImage(
            img.bitmap,
            msg.maxEdge,
            msg.isFallbackPreview,
            msg.baseCurveForBitmap,
          );
        } else {
          renderer.setImage(img, msg.maxEdge, msg.isFallbackPreview);
        }
        break;
      }

      case "setParams": {
        if (!renderer) break;
        renderer.setParams(msg.params);
        break;
      }

      case "setLensProfile": {
        if (!renderer) break;
        renderer.setLensProfile(msg.profile);
        break;
      }

      case "setAsShotTemperature": {
        if (!renderer) break;
        renderer.setAsShotTemperature(msg.kelvin);
        break;
      }

      case "render": {
        if (!renderer || !canvas) break;
        renderer.render();
        const bitmap = canvas.transferToImageBitmap();
        const resp: WorkerResponse = {
          type: "frame",
          bitmap,
          width: renderer.bufferWidth,
          height: renderer.bufferHeight,
        };
        if (msg.wantHistogram) {
          resp.histogram = renderer.computeHistogram(!!msg.wantExtended);
        }
        respond(resp, [bitmap]);
        break;
      }

      case "renderThumbnail": {
        const tr = ensureThumbRenderer();
        const img = msg.image;
        if (img.kind === "bitmap") {
          tr.setImage(img.bitmap, msg.maxEdge);
        } else {
          tr.setImage(img, msg.maxEdge);
        }
        tr.setAsShotTemperature(msg.asShotTemperature);
        tr.setParams(msg.params);
        tr.render();
        if (!thumbCanvas) break;
        const quality = msg.quality ?? 0.8;
        thumbCanvas.convertToBlob({ type: "image/jpeg", quality }).then(
          (blob) => {
            respond({ type: "thumbnail", requestId: msg.requestId, blob });
          },
        );
        break;
      }

      case "setShowClipping": {
        if (renderer) renderer.setShowClipping(msg.mode);
        break;
      }

      case "computeHistogram": {
        if (!renderer) break;
        const histogram = renderer.computeHistogram(!!msg.wantExtended);
        respond({ type: "histogram", histogram });
        break;
      }

      case "setStages": {
        latestStages = msg.stages;
        if (renderer) renderer.setStages(msg.stages);
        if (thumbRenderer) thumbRenderer.setStages(msg.stages);
        break;
      }

      case "setPipeline": {
        latestPipeline = msg.pipeline;
        if (renderer) renderer.setActivePipeline(msg.pipeline);
        if (thumbRenderer) thumbRenderer.setActivePipeline(msg.pipeline);
        break;
      }

      case "dispose": {
        renderer?.dispose();
        renderer = null;
        canvas = null;
        thumbRenderer?.dispose();
        thumbRenderer = null;
        thumbCanvas = null;
        break;
      }
    }
  } catch (err) {
    respond({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

const workerScope = self as unknown as {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  postMessage(msg: unknown): void;
};

function respond(msg: WorkerResponse, transfer?: Transferable[]) {
  if (transfer) {
    workerScope.postMessage(msg, transfer);
  } else {
    workerScope.postMessage(msg);
  }
}
