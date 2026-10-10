// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { CURRENT_PROCESS_VERSION, type DevelopParams, type UprightMode } from "@/catalog/types";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { BUILTIN_RESOLVED, withPipeline } from "@/extensions/pipelines";
import { WebGLRenderer } from "./webgl/renderer";
import type { HistogramData } from "./histogram";
import { detectLines, computeUprightCorrection, type UprightResult } from "./upright";

// ---------------------------------------------------------------------------
// Message types (worker ↔ main thread)
// ---------------------------------------------------------------------------

export type WorkerRequest =
  | { cmd: "init"; width: number; height: number; highBitDepth: boolean }
  | {
      cmd: "setImage";
      image:
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "float16"; data: Uint16Array; width: number; height: number }
        | { kind: "bitmap"; bitmap: ImageBitmap };
      maxEdge?: number;
      isFallbackPreview?: boolean;
      baseCurveForBitmap?: boolean;
    }
  // The develop view moved to another photo. Until that photo's source is set,
  // uploaded and bound, or bound from the cache, renders are answered frameSkipped
  // and histograms not at all: the bound source still belongs to the previous photo.
  | { cmd: "clearSource" }
  | { cmd: "setParams"; params: DevelopParams }
  // What differs from the params the bridge last posted, whole or by patches: `set` holds
  // the top-level fields that are new or not the same value, `remove` the keys dropped.
  // Every DevelopParams field is required, so only keys a stored edit carries beyond them
  // can be. Never sent before whole params, nor first after an init.
  | { cmd: "patchParams"; set: Partial<DevelopParams>; remove: string[] }
  | { cmd: "setContributedParams"; bag: Record<string, unknown> }
  // What differs from the bag the bridge last posted, whole or by patches: `set` holds
  // the new and changed entries, `remove` the dropped keys (none of them in `set`).
  // Values are untyped like the bag's: extensions define them at runtime.
  | { cmd: "patchContributedParams"; set: Record<string, unknown>; remove: string[] }
  | { cmd: "setStageTextures"; bag: Record<string, StageTextureData> }
  // Render one frame with `params` to an ImageBitmap returned out-of-band (NOT
  // blitted to the display) so an extension can grab a "before" frame at the
  // current source + viewport without disturbing the live view. The live params
  // and pipeline are restored afterwards. See render-bridge.capture().
  | { cmd: "capture"; reqId: number; params: DevelopParams; pipeline: ResolvedPipeline }
  | { cmd: "setAsShotTemperature"; kelvin: number }
  | { cmd: "setHslStyle"; range: number; smooth: number }
  // Answered exactly once, by `seq`: with a frame, frameSkipped or renderError. The
  // bridge sends the next render only once this one is answered.
  | { cmd: "render"; seq: number; wantHistogram?: boolean; wantExtended?: boolean }
  | {
      cmd: "renderThumbnail";
      requestId: string;
      image:
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "float16"; data: Uint16Array; width: number; height: number }
        | { kind: "bitmap"; bitmap: ImageBitmap };
      params: DevelopParams;
      asShotTemperature: number;
      maxEdge: number;
      quality?: number;
      // Per-render extension-stage params. When present, applied to the thumb
      // renderer for THIS render only (then the global bag is restored), so a
      // headless/batch render of a photo other than the live develop one uses its
      // OWN stage params instead of the active photo's.
      contributedParams?: Record<string, unknown>;
      // The rendered photo's display transform, resolved on the main thread
      // (the worker has no registry). Applied for THIS render only.
      pipeline: ResolvedPipeline;
    }
  | { cmd: "setShowClipping"; mode: number }
  | { cmd: "setOutsideColor"; rgb: [number, number, number] }
  | { cmd: "setMaskViz"; index: number; color: [number, number, number]; strength: number }
  | { cmd: "setSharpenViz"; mode: number }
  | { cmd: "computeHistogram"; wantExtended?: boolean }
  | { cmd: "setStages"; stages: ProcessingStageContribution[] }
  | { cmd: "setPipeline"; pipeline: ResolvedPipeline }
  | { cmd: "analyzeUpright"; reqId: number; mode: UprightMode }
  // ── GPU source cache ──
  | { cmd: "bindSource"; reqId: number; key: string }
  | {
      cmd: "uploadSource";
      target: "main" | "thumb";
      key: string;
      image:
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "float16"; data: Uint16Array; width: number; height: number }
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
      // See renderThumbnail.contributedParams.
      contributedParams?: Record<string, unknown>;
      // See renderThumbnail.pipeline.
      pipeline: ResolvedPipeline;
    }
  | { cmd: "dispose" };

export type WorkerResponse =
  | { type: "ready"; pipelineFloat: boolean }
  // The develop renderer could not be created (no WebGL2 context). The bridge
  // retries init on a schedule; see RenderBridge's availability.
  | { type: "initError"; message: string }
  | {
      type: "frame";
      seq: number;
      bitmap: ImageBitmap;
      width: number;
      height: number;
      // The source it was drawn from: its size as the renderer holds it (after the upload
      // cap, 0 before any), and its number, which moves on each time the develop renderer
      // is handed a source (see sourceGen below).
      sourceWidth: number;
      sourceHeight: number;
      sourceGen: number;
      histogram?: HistogramData;
    }
  // Render `seq` had nothing to draw with or from: no renderer, or no source yet for
  // the photo the develop view moved to.
  | { type: "frameSkipped"; seq: number }
  // Drawing render `seq`, or measuring the histogram it asked for, threw.
  | { type: "renderError"; seq: number; message: string }
  // The develop renderer couldn't take source `sourceGen` (see sourceGen below). It holds
  // no picture of the photo then, so renders are answered frameSkipped until the next.
  | { type: "sourceError"; sourceGen: number; message: string }
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
  | { type: "upright"; reqId: number; result: UprightResult }
  // An upright analysis threw. Carries the reqId so the bridge settles THAT
  // pending computeUpright promise; without it a throw falls through to the
  // generic "error" response, which isn't tied to a request, so the awaiting
  // TransformPanel hangs forever.
  | { type: "uprightError"; reqId: number; message: string }
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
// the captured frame's look. Kept while the renderer is null too, so one made by
// an init retry starts from it instead of waiting for a re-post that may not come.
let lastParams: DevelopParams | null = null;
// Set by clearSource, cleared once the develop renderer is handed the next
// photo's source.
let awaitingSource = false;
// The number of the develop renderer's source, carried by every frame: moved on by each
// setImage and each main uploadSource that binds, sent while there is a renderer or not,
// and by each bindSource hit. RenderBridge.sourceGen counts the same messages, so the
// two agree on which source a number names.
let sourceGen = 0;
// Mirrors the gpuSourceCacheBytes preference. The develop renderer gets the full
// budget (full-res sources are large); the thumb renderer caches tiny sources, so
// a quarter holds many. 0 until the first setCacheBudget message.
let cacheBudgetBytes = 0;

// Fraction of the develop cache budget granted to the thumb renderer (its sources
// are downscaled, so a quarter holds many).
const THUMB_CACHE_FRACTION = 0.25;
const DEFAULT_THUMB_JPEG_QUALITY = 0.8;

// Forward the develop renderer's downscaled heal source to the main thread so the
// overlay's findHealSource/healColorOffset can search it (they run main-thread, in
// a separate module instance where setHealSourceImage is never called otherwise).
function postHealSource() {
  if (!renderer) return;
  const hs = renderer.healSourceData();
  if (hs) respond({ type: "healSource", data: hs.data, width: hs.w, height: hs.h }, [hs.data.buffer]);
}

// The develop renderer let go of the source it held before it failed to take this one, so
// nothing is drawn until the next source, and the view is told which one failed.
function sourceFailed(err: unknown) {
  awaitingSource = true;
  respond({
    type: "sourceError",
    sourceGen,
    message: err instanceof Error ? err.message : String(err),
  });
}

// The bag both renderers draw with. Kept, so a renderer created later starts from it.
function applyParamBag(bag: Record<string, unknown>) {
  latestParamBag = bag;
  renderer?.setContributedParams(bag);
  thumbRenderer?.setContributedParams(bag);
}

// Builds the program a new renderer's first frame needs. Stages or a display
// transform that can't be built fail frames, not the renderer, and only until they
// change: that is logged once and the renderer stays. A stock program (the built-in
// transform with Safelight's own stages) that can't be built either means this
// machine can't run Safelight's own shader, so that throws: init answers it with
// initError for the bridge to retry and report, a thumbnail request with
// thumbnailError.
function warmUp(target: WebGLRenderer, processVersion: number): void {
  try {
    target.prepareProgram(processVersion);
  } catch (err) {
    target.prepareStockProgram(processVersion);
    console.error(
      "[render-worker] stages or display transform can't be built; frames fail until they change:",
      err,
    );
  }
}

// Hands a new renderer what arrived while there was none, which the worker only held.
// `ready` is the only word the bridge gets that init finished, and the bridge sends params
// and the bag again after it but never stage textures. So each step is its own try: one
// that throws is logged and must not skip `ready` or the steps after it, or a stage that
// reads a LUT would draw black until some texture changed. The renderer stays.
function seedRenderer(target: WebGLRenderer): void {
  const attempt = (what: string, step: () => void) => {
    try {
      step();
    } catch (err) {
      console.error(
        `[render-worker] the new renderer couldn't take the ${what} that arrived before it:`,
        err,
      );
    }
  };
  attempt("cache budget", () => {
    if (cacheBudgetBytes > 0) target.setCacheBudget(cacheBudgetBytes);
  });
  attempt("stage params", () => target.setContributedParams(latestParamBag));
  attempt("stage textures", () => target.setStageTextures(latestStageTextures));
  attempt("params", () => {
    if (lastParams) target.setParams(lastParams);
  });
}

// `first` is the request that creates the renderer. Its program is built here, with
// that photo's version and display transform, so a renderer that can't build at all
// fails the request and is not kept, instead of failing every frame after it. An
// upload creates one with no photo to go by (`first` is absent): it builds the
// current version under the pipeline and stages the worker holds.
function ensureThumbRenderer(
  first?: Pick<ThumbRenderRequest, "params" | "pipeline">,
): WebGLRenderer {
  if (thumbRenderer) return thumbRenderer;
  const canvas = new OffscreenCanvas(512, 512);
  const created = new WebGLRenderer(canvas, {
    highBitDepth: false,
    pipeline: latestPipeline,
    stages: latestStages,
  });
  try {
    if (first) {
      withPipeline(created, first.pipeline, latestPipeline, () =>
        warmUp(created, first.params.processVersion),
      );
    } else {
      warmUp(created, CURRENT_PROCESS_VERSION);
    }
  } catch (err) {
    created.dispose();
    throw err;
  }
  thumbCanvas = canvas;
  thumbRenderer = created;
  if (cacheBudgetBytes > 0) created.setCacheBudget(cacheBudgetBytes * THUMB_CACHE_FRACTION);
  created.setContributedParams(latestParamBag);
  created.setStageTextures(latestStageTextures);
  return created;
}

interface ThumbRenderRequest {
  requestId: string;
  params: DevelopParams;
  asShotTemperature: number;
  quality?: number;
  contributedParams?: Record<string, unknown>;
  pipeline: ResolvedPipeline;
}

// Shared tail for both thumbnail handlers (after their divergent setImage/bindSource
// preamble): applies params + per-render stage bag and pipeline, renders, restores
// the global bag and live pipeline, and settles the request — including the
// convertToBlob rejection path — so the caller's promise never hangs.
function finishThumbRender(tr: WebGLRenderer, msg: ThumbRenderRequest) {
  tr.setAsShotTemperature(msg.asShotTemperature);
  tr.setParams(msg.params);
  const hadBag = msg.contributedParams !== undefined;
  if (hadBag) tr.setContributedParams(msg.contributedParams!);
  // Restore the global bag even if render() throws, or a failed render leaves the
  // thumb renderer holding this photo's stage params and every later thumbnail
  // renders with the wrong photo's uniforms.
  try {
    withPipeline(tr, msg.pipeline, latestPipeline, () => tr.render());
  } finally {
    if (hadBag) tr.setContributedParams(latestParamBag);
  }
  if (!thumbCanvas) throw new Error("thumb canvas unavailable");
  const quality = msg.quality ?? DEFAULT_THUMB_JPEG_QUALITY;
  thumbCanvas.convertToBlob({ type: "image/jpeg", quality }).then(
    (blob) => respond({ type: "thumbnail", requestId: msg.requestId, blob }),
    (err) => respondThumbError(msg.requestId, err),
  );
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    switch (msg.cmd) {
      case "init": {
        // A context that can't be created — no WebGL2, or the page is inside
        // Chromium's post-GPU-reset refusal of 3D contexts — gets its own
        // response so the bridge can retry instead of waiting for `ready`
        // forever. So does a stock develop program that can't be built: warmUp
        // builds it here, not on the first frame, so it fails the init (retried
        // and reported by the bridge) rather than every frame after it.
        let created: WebGLRenderer | null = null;
        try {
          canvas = new OffscreenCanvas(msg.width, msg.height);
          created = new WebGLRenderer(canvas, {
            // The worker can't read the preference itself (settings-store uses
            // localStorage, unavailable off the main thread), so it arrives here.
            highBitDepth: msg.highBitDepth,
            // A retry (after an earlier initError) may land after setPipeline /
            // setStages messages already updated the latest* state below —
            // seed from them, the same as ensureThumbRenderer, so recovery
            // doesn't silently fall back to the built-in pipeline with no
            // extension stages.
            pipeline: latestPipeline,
            stages: latestStages,
          });
          warmUp(created, lastParams?.processVersion ?? CURRENT_PROCESS_VERSION);
          renderer = created;
        } catch (err) {
          created?.dispose();
          canvas = null;
          renderer = null;
          respond({ type: "initError", message: err instanceof Error ? err.message : String(err) });
          break;
        }
        seedRenderer(renderer);
        respond({ type: "ready", pipelineFloat: renderer.colorBufferFloat });
        break;
      }

      case "clearSource": {
        awaitingSource = true;
        break;
      }

      case "setImage": {
        sourceGen++;
        if (!renderer) break;
        const img = msg.image;
        try {
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
        } catch (err) {
          sourceFailed(err);
          break;
        }
        awaitingSource = false;
        postHealSource();
        break;
      }

      case "setParams": {
        lastParams = msg.params;
        if (!renderer) break;
        renderer.setParams(msg.params);
        break;
      }

      case "patchParams": {
        // A new object, so the renderer never has the params it holds edited under it.
        // Fields the patch doesn't name stay the very objects the renderer drew last: it
        // signs every dab of the masks and retouch again only when they are not the same
        // arrays.
        if (!lastParams) throw new Error("a params patch arrived before any params");
        const merged: DevelopParams = { ...lastParams, ...msg.set };
        for (const key of msg.remove) Reflect.deleteProperty(merged, key);
        lastParams = merged;
        renderer?.setParams(merged);
        break;
      }

      case "setContributedParams": {
        applyParamBag(msg.bag);
        break;
      }

      case "patchContributedParams": {
        // A new object, so no renderer has the bag it holds edited under it. Entries the
        // patch doesn't name stay the very objects the renderers already saw: the develop
        // renderer bakes painted coverage again only when its dabs are not the same array.
        const merged = { ...latestParamBag, ...msg.set };
        for (const key of msg.remove) delete merged[key];
        applyParamBag(merged);
        break;
      }

      case "setStageTextures": {
        latestStageTextures = msg.bag;
        renderer?.setStageTextures(msg.bag);
        thumbRenderer?.setStageTextures(msg.bag);
        break;
      }

      case "capture": {
        // Render `params` with their photo's pipeline to a detached bitmap
        // without touching the display canvas the main thread blits from.
        // transferToImageBitmap() resets the offscreen, so the next live
        // render() repaints it; restoring lastParams and the live pipeline keeps
        // the renderer's state in sync with the live view.
        if (!renderer || !canvas) {
          const blank = new OffscreenCanvas(1, 1);
          respond({ type: "captured", reqId: msg.reqId, bitmap: blank.transferToImageBitmap() });
          break;
        }
        const live = renderer;
        const target = canvas;
        // A throw here would otherwise fall to the generic "error" response, which
        // carries no reqId, so the awaiting capture() would hang. Settle with the
        // blank fallback instead.
        try {
          const captured = withPipeline(live, msg.pipeline, latestPipeline, () => {
            live.setParams(msg.params);
            live.render();
            return target.transferToImageBitmap();
          });
          if (lastParams) live.setParams(lastParams);
          respond({ type: "captured", reqId: msg.reqId, bitmap: captured }, [captured]);
        } catch {
          if (lastParams) live.setParams(lastParams);
          const blank = new OffscreenCanvas(1, 1);
          respond({ type: "captured", reqId: msg.reqId, bitmap: blank.transferToImageBitmap() });
        }
        break;
      }

      case "setAsShotTemperature": {
        if (!renderer) break;
        renderer.setAsShotTemperature(msg.kelvin);
        break;
      }

      case "setHslStyle": {
        if (!renderer) break;
        renderer.setHslStyle(msg.range, msg.smooth);
        break;
      }

      case "render": {
        // Every way out answers by `seq`: the generic "error" carries none, and the
        // bridge sends no further render until this one is answered.
        if (!renderer || !canvas || awaitingSource) {
          respond({ type: "frameSkipped", seq: msg.seq });
          break;
        }
        let bitmap: ImageBitmap | null = null;
        try {
          renderer.render();
          bitmap = canvas.transferToImageBitmap();
          const resp: WorkerResponse = {
            type: "frame",
            seq: msg.seq,
            bitmap,
            width: renderer.bufferWidth,
            height: renderer.bufferHeight,
            sourceWidth: renderer.sourceWidth,
            sourceHeight: renderer.sourceHeight,
            sourceGen,
          };
          if (msg.wantHistogram) {
            resp.histogram = renderer.computeHistogram(!!msg.wantExtended);
          }
          respond(resp, [bitmap]);
        } catch (err) {
          bitmap?.close();
          respond({
            type: "renderError",
            seq: msg.seq,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }

      case "renderThumbnail": {
        try {
          const tr = ensureThumbRenderer(msg);
          const img = msg.image;
          if (img.kind === "bitmap") {
            tr.setImage(img.bitmap, msg.maxEdge);
          } else {
            // Cap a cached float16 source, as uploadSource("thumb") does.
            tr.setImage(img, msg.maxEdge, false, false, true);
          }
          finishThumbRender(tr, msg);
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
        if (!renderer || awaitingSource) break;
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
        let hit = false;
        try {
          hit = !!renderer && renderer.bindSource(msg.key);
        } catch (err) {
          // The view waits for this answer. A miss has it load and upload the photo
          // itself, which replaces the entry; the renderer may have let go of the
          // source it held, so nothing is drawn until then. Reported as an error too.
          awaitingSource = true;
          respond({ type: "sourceBound", reqId: msg.reqId, hit: false });
          throw err;
        }
        if (hit) {
          sourceGen++;
          awaitingSource = false;
        }
        respond({ type: "sourceBound", reqId: msg.reqId, hit });
        if (hit) postHealSource();
        break;
      }

      case "uploadSource": {
        const bind = msg.bind ?? true;
        if (bind && msg.target === "main") sourceGen++;
        const target = msg.target === "thumb" ? ensureThumbRenderer() : renderer;
        if (!target) break;
        const img = msg.image;
        // Cap a cached float16 source to maxEdge for the thumb renderer so it doesn't
        // hold a full-res source; the main renderer keeps full resolution for zoom.
        const capFloat16 = msg.target === "thumb";
        try {
          if (img.kind === "bitmap") {
            target.uploadSource(msg.key, img.bitmap, msg.maxEdge, msg.isFallbackPreview, msg.baseCurveForBitmap, bind, capFloat16);
          } else {
            target.uploadSource(msg.key, img, msg.maxEdge, msg.isFallbackPreview, false, bind, capFloat16);
          }
        } catch (err) {
          if (!bind || msg.target !== "main") throw err;
          sourceFailed(err);
          break;
        }
        // Only a bind into the main renderer changes the active heal source.
        if (bind && msg.target === "main") {
          awaitingSource = false;
          postHealSource();
        }
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
        thumbRenderer?.setCacheBudget(msg.bytes * THUMB_CACHE_FRACTION);
        break;
      }

      case "setViewport": {
        renderer?.setViewport(msg.roi, msg.outW, msg.outH);
        break;
      }

      case "renderThumbnailFromSource": {
        try {
          const tr = ensureThumbRenderer(msg);
          // msg.maxEdge is the OUTPUT cap for this thumbnail — smaller than the
          // resident source's own upload cap — so pass it as the bind override.
          if (!tr.bindSource(msg.key, msg.maxEdge)) {
            respond({ type: "thumbnailMiss", requestId: msg.requestId, key: msg.key });
            break;
          }
          finishThumbRender(tr, msg);
        } catch (err) {
          respondThumbError(msg.requestId, err);
        }
        break;
      }

      case "analyzeUpright": {
        // Always respond, even with no renderer or no readable pixels: the bridge's
        // computeUpright promise has no timeout, so a silent break hangs the awaiting
        // TransformPanel forever. A zero result is the correct no-op; a throw settles
        // via uprightError (carrying the reqId) rather than the reqId-less generic
        // "error" response, which wouldn't clear the pending promise.
        try {
          const pixels = renderer?.readDownscaledPixels(256);
          if (!pixels) {
            respond({ type: "upright", reqId: msg.reqId, result: { straighten: 0, perspectiveV: 0, perspectiveH: 0 } });
            break;
          }
          const lines = detectLines(pixels.data, pixels.w, pixels.h);
          const result = computeUprightCorrection(lines, msg.mode, pixels.w, pixels.h);
          respond({ type: "upright", reqId: msg.reqId, result });
        } catch (err) {
          respond({
            type: "uprightError",
            reqId: msg.reqId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
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
