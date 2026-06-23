// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams, UprightMode } from "@/catalog/types";
import type { ResolvedProfile } from "@/lens-profiles/types";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { BUILTIN_RESOLVED } from "@/extensions/pipelines";
import { WebGLRenderer } from "./webgl/renderer";
import type { HistogramData } from "./histogram";
import { detectLines, computeUprightCorrection, type UprightResult } from "./upright";

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
  | { cmd: "setContributedParams"; bag: Record<string, unknown> }
  | { cmd: "setStageTextures"; bag: Record<string, StageTextureData> }
  // Render one frame with `params` to an ImageBitmap returned out-of-band (NOT
  // blitted to the display) so an extension can grab a "before" frame at the
  // current source + viewport without disturbing the live view. The live params
  // are restored afterwards. See render-bridge.capture().
  | { cmd: "capture"; reqId: number; params: DevelopParams }
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
  | { cmd: "setOutsideColor"; rgb: [number, number, number] }
  | { cmd: "setMaskViz"; index: number; color: [number, number, number]; strength: number }
  | { cmd: "setSharpenViz"; mode: number }
  | { cmd: "computeHistogram"; wantExtended?: boolean }
  | { cmd: "setStages"; stages: ProcessingStageContribution[] }
  | { cmd: "setPipeline"; pipeline: ResolvedPipeline }
  | { cmd: "analyzeUpright"; mode: UprightMode }
  // ── GPU source cache ──
  | { cmd: "bindSource"; reqId: number; key: string }
  | {
      cmd: "uploadSource";
      target: "main" | "thumb";
      key: string;
      image:
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "srgb16"; data: Uint16Array; width: number; height: number }
        | { kind: "bitmap"; bitmap: ImageBitmap };
      maxEdge?: number;
      isFallbackPreview?: boolean;
      baseCurveForBitmap?: boolean;
      bind?: boolean;
    }
  | { cmd: "hasSource"; reqId: number; target: "main" | "thumb"; key: string }
  | { cmd: "setCacheBudget"; bytes: number }
  | { cmd: "setViewport"; roi: { x: number; y: number; w: number; h: number } | null; outW?: number; outH?: number }
  | {
      cmd: "renderThumbnailFromSource";
      requestId: string;
      key: string;
      params: DevelopParams;
      asShotTemperature: number;
      maxEdge: number;
      quality?: number;
    }
  | { cmd: "dispose" };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "frame"; bitmap: ImageBitmap; width: number; height: number; histogram?: HistogramData }
  | { type: "histogram"; histogram: HistogramData }
  | { type: "thumbnail"; requestId: string; blob: Blob }
  | { type: "thumbnailMiss"; requestId: string; key: string }
  // A thumbnail render failed (threw, or convertToBlob rejected). Carries the
  // requestId so the bridge can settle THAT pending promise — without this a
  // failure falls through to the generic "error" response, which isn't tied to a
  // request, so renderThumbnailAsync hangs forever and wedges the caller.
  | { type: "thumbnailError"; requestId: string; message: string }
  | { type: "sourceBound"; reqId: number; hit: boolean }
  | { type: "captured"; reqId: number; bitmap: ImageBitmap }
  | { type: "hasSource"; reqId: number; has: boolean }
  | { type: "upright"; result: UprightResult }
  // The downscaled 8-bit heal source, forwarded so the main thread's
  // findHealSource/healColorOffset (in the develop overlay) has pixels to search.
  | { type: "healSource"; data: Uint8ClampedArray; width: number; height: number }
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
// Generic param bag for extension-contributed stage uniforms. Persisted so a
// newly-created thumb renderer inherits it; the renderer keeps its own copy.
let latestParamBag: Record<string, unknown> = {};
// Stage textures (e.g. baked LUT atlases), keyed by qualified key. Persisted so a
// newly-created thumb renderer inherits them.
let latestStageTextures: Record<string, StageTextureData> = {};
// The last params pushed to the develop renderer. A `capture` swaps in override
// params, renders, then restores these so a later display render (e.g. from a
// viewport or clipping change that doesn't re-send params) isn't left showing
// the captured frame's look.
let lastParams: DevelopParams | null = null;
// Mirrors the gpuSourceCacheBytes preference. The develop renderer gets the full
// budget (full-res sources are large); the thumb renderer caches tiny sources, so
// a quarter holds many. 0 until the first setCacheBudget message.
let cacheBudgetBytes = 0;

// Forward the develop renderer's downscaled heal source to the main thread so the
// overlay's findHealSource/healColorOffset can search it (they run main-thread, in
// a separate module instance where setHealSourceImage is never called otherwise).
function postHealSource() {
  if (!renderer) return;
  const hs = renderer.healSourceData();
  if (hs) respond({ type: "healSource", data: hs.data, width: hs.w, height: hs.h }, [hs.data.buffer]);
}

function ensureThumbRenderer(): WebGLRenderer {
  if (thumbRenderer) return thumbRenderer;
  thumbCanvas = new OffscreenCanvas(512, 512);
  thumbRenderer = new WebGLRenderer(thumbCanvas, {
    highBitDepth: false,
    pipeline: latestPipeline,
    stages: latestStages,
  });
  if (cacheBudgetBytes > 0) thumbRenderer.setCacheBudget(cacheBudgetBytes / 4);
  thumbRenderer.setContributedParams(latestParamBag);
  thumbRenderer.setStageTextures(latestStageTextures);
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
        postHealSource();
        break;
      }

      case "setParams": {
        if (!renderer) break;
        lastParams = msg.params;
        renderer.setParams(msg.params);
        // TEMP: report what the worker actually received, routed to the main
        // console via the error channel (worker console is unreliable here).
        if ((msg.params.retouch ?? []).length > 0) {
          respond({
            type: "error",
            message:
              "[worker setParams] retouch=" +
              JSON.stringify(
                msg.params.retouch.map(
                  (s) => `${s.shape}${s.dabs ? `(${s.dabs.length})` : ""}`,
                ),
              ),
          });
        }
        break;
      }

      case "setContributedParams": {
        latestParamBag = msg.bag;
        renderer?.setContributedParams(msg.bag);
        thumbRenderer?.setContributedParams(msg.bag);
        break;
      }

      case "setStageTextures": {
        latestStageTextures = msg.bag;
        renderer?.setStageTextures(msg.bag);
        thumbRenderer?.setStageTextures(msg.bag);
        break;
      }

      case "capture": {
        // Render `params` to a detached bitmap without touching the display
        // canvas the main thread blits from. transferToImageBitmap() resets the
        // offscreen, so the next live render() repaints it; restoring lastParams
        // keeps the renderer's uniform state in sync with the live view.
        if (!renderer || !canvas) {
          const blank = new OffscreenCanvas(1, 1);
          respond({ type: "captured", reqId: msg.reqId, bitmap: blank.transferToImageBitmap() });
          break;
        }
        renderer.setParams(msg.params);
        renderer.render();
        const captured = canvas.transferToImageBitmap();
        if (lastParams) renderer.setParams(lastParams);
        respond({ type: "captured", reqId: msg.reqId, bitmap: captured }, [captured]);
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
        if (renderer.dbgPrepass) { respond({ type: "error", message: renderer.dbgPrepass }); renderer.dbgPrepass = ""; }
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
        try {
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
          if (!thumbCanvas) throw new Error("thumb canvas unavailable");
          const quality = msg.quality ?? 0.8;
          // Always settle the request — including the convertToBlob rejection path
          // (no catch here previously) — so the caller's promise never hangs.
          thumbCanvas.convertToBlob({ type: "image/jpeg", quality }).then(
            (blob) => respond({ type: "thumbnail", requestId: msg.requestId, blob }),
            (err) => respondThumbError(msg.requestId, err),
          );
        } catch (err) {
          respondThumbError(msg.requestId, err);
        }
        break;
      }

      case "setShowClipping": {
        if (renderer) renderer.setShowClipping(msg.mode);
        break;
      }

      case "setOutsideColor": {
        if (renderer) renderer.setOutsideColor(msg.rgb);
        break;
      }

      case "setMaskViz": {
        if (renderer) renderer.setMaskViz(msg.index, msg.color, msg.strength);
        break;
      }

      case "setSharpenViz": {
        if (renderer) renderer.setSharpenViz(msg.mode);
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

      case "bindSource": {
        const hit = !!renderer && renderer.bindSource(msg.key);
        respond({ type: "sourceBound", reqId: msg.reqId, hit });
        if (hit) postHealSource();
        break;
      }

      case "uploadSource": {
        const target = msg.target === "thumb" ? ensureThumbRenderer() : renderer;
        if (!target) break;
        const img = msg.image;
        const bind = msg.bind ?? true;
        // Cap oversized srgb16 to maxEdge for the thumb renderer so it doesn't hold
        // a full-res source; the main renderer keeps full resolution for zoom.
        const capSrgb16 = msg.target === "thumb";
        if (img.kind === "bitmap") {
          target.uploadSource(msg.key, img.bitmap, msg.maxEdge, msg.isFallbackPreview, msg.baseCurveForBitmap, bind, capSrgb16);
        } else {
          target.uploadSource(msg.key, img, msg.maxEdge, msg.isFallbackPreview, false, bind, capSrgb16);
        }
        // Only a bind into the main renderer changes the active heal source.
        if (bind && msg.target === "main") postHealSource();
        break;
      }

      case "hasSource": {
        const target = msg.target === "thumb" ? thumbRenderer : renderer;
        respond({ type: "hasSource", reqId: msg.reqId, has: !!target && target.hasSource(msg.key) });
        break;
      }

      case "setCacheBudget": {
        cacheBudgetBytes = msg.bytes;
        renderer?.setCacheBudget(msg.bytes);
        thumbRenderer?.setCacheBudget(msg.bytes / 4);
        break;
      }

      case "setViewport": {
        renderer?.setViewport(msg.roi, msg.outW, msg.outH);
        break;
      }

      case "renderThumbnailFromSource": {
        try {
          const tr = ensureThumbRenderer();
          if (!tr.bindSource(msg.key)) {
            respond({ type: "thumbnailMiss", requestId: msg.requestId, key: msg.key });
            break;
          }
          tr.setAsShotTemperature(msg.asShotTemperature);
          tr.setParams(msg.params);
          tr.render();
          if (!thumbCanvas) throw new Error("thumb canvas unavailable");
          const quality = msg.quality ?? 0.8;
          thumbCanvas.convertToBlob({ type: "image/jpeg", quality }).then(
            (blob) => respond({ type: "thumbnail", requestId: msg.requestId, blob }),
            (err) => respondThumbError(msg.requestId, err),
          );
        } catch (err) {
          respondThumbError(msg.requestId, err);
        }
        break;
      }

      case "analyzeUpright": {
        if (!renderer) break;
        const pixels = renderer.readDownscaledPixels(256);
        if (!pixels) break;
        const lines = detectLines(pixels.data, pixels.w, pixels.h);
        const result = computeUprightCorrection(lines, msg.mode, pixels.w, pixels.h);
        respond({ type: "upright", result });
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

// Settle a thumbnail request that failed, so the caller's promise rejects (and
// its in-flight bookkeeping clears) instead of hanging on a lost requestId.
function respondThumbError(requestId: string, err: unknown) {
  respond({
    type: "thumbnailError",
    requestId,
    message: err instanceof Error ? err.message : String(err),
  });
}
