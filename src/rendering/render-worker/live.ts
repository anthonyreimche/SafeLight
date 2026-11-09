// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The live view: creating the develop renderer, what it draws with (params,
// bag, stage textures, stages, pipeline), and its frames and histogram.

import { CURRENT_PROCESS_VERSION, type DevelopParams, type Mask } from "@/catalog/types";
import type { StageTextureData } from "@/extensions/types";
import type { MaskPatch, WorkerRequest, WorkerResponse } from "../render-protocol";
import { setActiveBrushTips } from "../webgl/brush-tips";
import { LIVE_MASK_COPY_PREPASSES } from "../webgl/mask-stage-instances";
import { WebGLRenderer } from "../webgl/renderer";
import {
  bindLiveView,
  messageOf,
  reportQuarantine,
  reportStageBuilds,
  showScreen,
  warmUp,
  type HandlersFor,
  type WorkerContext,
} from "./context";

// Hands a new renderer what arrived while there was none, which the worker only held.
// `ready` is the only word the bridge gets that init finished, and the bridge sends params
// and the bag again after it but never stage textures. So each step is its own try: one
// that throws is logged and must not skip `ready` or the steps after it, or a stage that
// reads a LUT would draw black until some texture changed. The renderer stays.
function seedRenderer(ctx: WorkerContext, target: WebGLRenderer): void {
  const { state } = ctx;
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
    if (state.cacheBudgetBytes > 0) target.setCacheBudget(state.cacheBudgetBytes);
  });
  attempt("stage params", () => ctx.setBag(target, state.latestParamBag));
  attempt("stage textures", () => target.setStageTextures(state.latestStageTextures));
  attempt("display profile, display space and proof", () => showScreen(state, target, true));
  attempt("params", () => {
    if (state.lastParams) target.setParams(state.lastParams, state.lastDerived);
  });
}

// The masks `patches` make of the `held` ones: a mask the patch leaves unchanged, and the
// fields of one it changes that it doesn't name, stay the very objects the renderer signed.
function mergeMasks(held: readonly Mask[], patches: readonly MaskPatch[]): Mask[] {
  const byId = new Map(held.map((m) => [m.id, m]));
  return patches.map((patch) => {
    if ("mask" in patch) return patch.mask;
    const prev = byId.get(patch.id);
    if (!prev) throw new Error(`a mask patch arrived for mask '${patch.id}', which the worker doesn't hold`);
    if (patch.remove.length === 0 && Object.keys(patch.set).length === 0) return prev;
    const merged: Mask = { ...prev, ...patch.set };
    for (const key of patch.remove) Reflect.deleteProperty(merged, key);
    return merged;
  });
}

// The bag both renderers draw with. Kept, so a renderer created later starts from it.
function applyParamBag(ctx: WorkerContext, bag: Record<string, unknown>): void {
  const { state } = ctx;
  state.latestParamBag = bag;
  if (state.renderer) ctx.setBag(state.renderer, bag);
  if (state.thumbRenderer) ctx.setBag(state.thumbRenderer, bag);
}

// The stage textures both renderers draw with, kept likewise.
function applyStageTextures(ctx: WorkerContext, bag: Record<string, StageTextureData>): void {
  const { state } = ctx;
  state.latestStageTextures = bag;
  state.renderer?.setStageTextures(bag);
  state.thumbRenderer?.setStageTextures(bag);
}

type LiveCmd =
  | "init"
  | "setParams"
  | "patchParams"
  | "setDerived"
  | "setContributedParams"
  | "patchContributedParams"
  | "setStageTextures"
  | "patchStageTextures"
  | "setBrushTips"
  | "setStages"
  | "prewarmStages"
  | "setPipeline"
  | "setAsShotTemperature"
  | "render"
  | "computeHistogram";

export function liveHandlers(ctx: WorkerContext): HandlersFor<LiveCmd> {
  const { state, respond } = ctx;

  // A GPU reset loses the develop canvas's context, and every texture and program with
  // it, so the renderers go. Once it is restored init runs again as it last ran, and the
  // window hears ready or initError as from any init, then hands the photo over again. A
  // canvas a later init replaced is no longer the worker's.
  const watchContext = (canvas: OffscreenCanvas, init: Extract<WorkerRequest, { cmd: "init" }>) => {
    canvas.addEventListener("webglcontextlost", (e) => {
      if (state.canvas !== canvas) return;
      // Without this the context is never restored.
      e.preventDefault();
      state.renderer?.dispose();
      state.renderer = null;
      state.thumbRenderer?.dispose();
      state.thumbRenderer = null;
      state.thumbCanvas = null;
      state.awaitingSource = true;
      state.liveStateStale = false;
      respond({ type: "contextLost" });
    });
    canvas.addEventListener("webglcontextrestored", () => {
      if (state.canvas === canvas) handlers.init(init);
    });
  };

  const handlers: HandlersFor<LiveCmd> = {
    init(msg) {
      // A context that can't be created — no WebGL2, or the page is inside
      // Chromium's post-GPU-reset refusal of 3D contexts — gets its own
      // response so the bridge can retry instead of waiting for `ready`
      // forever. So does a stock develop program that can't be built: warmUp
      // builds it here, not on the first frame, so it fails the init (retried
      // and reported by the bridge) rather than every frame after it.
      let created: WebGLRenderer | null = null;
      let renderer: WebGLRenderer;
      try {
        state.canvas = new OffscreenCanvas(msg.width, msg.height);
        watchContext(state.canvas, msg);
        created = new WebGLRenderer(state.canvas, {
          // The worker can't read the preference itself (settings-store uses
          // localStorage, unavailable off the main thread), so it arrives here.
          highBitDepth: msg.highBitDepth,
          // The live view spreads many masks' prepasses over a few frames; the
          // thumbnail renderer draws each frame complete.
          maskCopyPrepassesPerFrame: LIVE_MASK_COPY_PREPASSES,
          // Only the live view leaves dormant stages out; the thumbnail renderer
          // draws every photo with one program.
          skipDormantStages: true,
          // A retry (after an earlier initError) may land after setPipeline /
          // setStages messages already updated the latest* state — seed from
          // them, the same as ensureThumbRenderer, so recovery doesn't silently
          // fall back to the built-in pipeline with no extension stages.
          pipeline: state.latestPipeline,
          stages: state.latestStages,
          onStageQuarantined: reportQuarantine(ctx),
          onStageBuild: reportStageBuilds(ctx),
        });
        // Only the develop renderer answers readSourceSample; the thumb renderer
        // would cut a sample from every thumbnail for nothing.
        created.keepSourceSample = true;
        created.keepSourcePixels = true;
        warmUp(created, state.lastParams?.processVersion ?? CURRENT_PROCESS_VERSION);
        renderer = created;
        state.renderer = created;
      } catch (err) {
        created?.dispose();
        state.canvas = null;
        state.renderer = null;
        respond({ type: "initError", message: messageOf(err) });
        return;
      }
      seedRenderer(ctx, renderer);
      respond({ type: "ready", pipelineFloat: renderer.colorBufferFloat });
    },

    setParams(msg) {
      state.lastParams = msg.params;
      state.lastDerived = msg.derived;
      state.renderer?.setParams(msg.params, msg.derived);
    },

    patchParams(msg) {
      // A new object, so the renderer never has the params it holds edited under it.
      // Fields the patch doesn't name stay the very objects the renderer drew last, and so
      // do the masks it leaves unchanged: it signs a brush's dabs and the retouch again
      // only when they are not the same arrays.
      if (!state.lastParams) throw new Error("a params patch arrived before any params");
      const merged: DevelopParams = { ...state.lastParams, ...msg.set };
      for (const key of msg.remove) Reflect.deleteProperty(merged, key);
      if (msg.masks) merged.masks = mergeMasks(state.lastParams.masks, msg.masks);
      state.lastParams = merged;
      if (msg.derived || msg.derivedRemove) {
        // Values the patch doesn't name stay the very objects the renderer drew last.
        const derived = { ...state.lastDerived, ...msg.derived };
        for (const key of msg.derivedRemove ?? []) Reflect.deleteProperty(derived, key);
        state.lastDerived = derived;
      }
      state.renderer?.setParams(merged, state.lastDerived);
    },

    setDerived(msg) {
      state.lastDerived = msg.derived;
      if (state.lastParams) state.renderer?.setParams(state.lastParams, state.lastDerived);
    },

    setContributedParams(msg) {
      applyParamBag(ctx, msg.bag);
    },

    patchContributedParams(msg) {
      // A new object, so no renderer has the bag it holds edited under it. Entries the
      // patch doesn't name stay the very objects the renderers already saw: the develop
      // renderer bakes painted coverage again only when its dabs are not the same array.
      const merged = { ...state.latestParamBag, ...msg.set };
      for (const key of msg.remove) delete merged[key];
      applyParamBag(ctx, merged);
    },

    setStageTextures(msg) {
      applyStageTextures(ctx, msg.bag);
    },

    patchStageTextures(msg) {
      // A new bag; the textures the patch doesn't name stay the objects the renderers
      // uploaded, so an unchanged version still skips the upload.
      const merged = { ...state.latestStageTextures, ...msg.set };
      for (const key of msg.remove) delete merged[key];
      applyStageTextures(ctx, merged);
    },

    setBrushTips(msg) {
      setActiveBrushTips(msg.tips);
    },

    setStages(msg) {
      state.latestStages = msg.stages;
      state.renderer?.setStages(msg.stages);
      state.thumbRenderer?.setStages(msg.stages);
    },

    // A hint only: before there is a renderer, its first frame builds what it needs.
    prewarmStages(msg) {
      state.renderer?.prewarmStages(msg.stageIds);
    },

    setPipeline(msg) {
      state.latestPipeline = msg.pipeline;
      state.renderer?.setActivePipeline(msg.pipeline);
      state.thumbRenderer?.setActivePipeline(msg.pipeline);
    },

    setAsShotTemperature(msg) {
      state.renderer?.setAsShotTemperature(msg.kelvin);
    },

    render(msg) {
      // Every way out answers by `seq`: the generic "error" carries none, and the
      // bridge sends no further render until this one is answered.
      const { renderer, canvas } = state;
      if (!renderer || !canvas || state.awaitingSource) {
        respond({ type: "frameSkipped", seq: msg.seq });
        return;
      }
      let bitmap: ImageBitmap | null = null;
      let framePosted = false;
      try {
        renderer.render();
        state.liveStateStale = false;
        bitmap = canvas.transferToImageBitmap();
        const sourceFull = renderer.sourceFullSize;
        const resp: WorkerResponse = {
          type: "frame",
          seq: msg.seq,
          bitmap,
          width: renderer.bufferWidth,
          height: renderer.bufferHeight,
          sourceWidth: renderer.sourceWidth,
          sourceHeight: renderer.sourceHeight,
          sourceGen: state.sourceGen,
          sourceFullWidth: sourceFull.width,
          sourceFullHeight: sourceFull.height,
          sourceNative: renderer.sourceNative,
          roi: renderer.viewport,
          wholeWidth: renderer.wholeWidth,
          wholeHeight: renderer.wholeHeight,
          crop: renderer.drawnCrop,
        };
        if (msg.wantHistogram) resp.histogramFollows = true;
        if (renderer.overflowedStages.length > 0) {
          resp.overflowedStages = [...renderer.overflowedStages];
        }
        const prepassPending = renderer.prepassPending;
        if (prepassPending) resp.prepassPending = true;
        respond(resp, [bitmap]);
        framePosted = true;
        // The readback stalls until the GPU drains the frame, so the frame goes first.
        // A frame with prepasses pending is followed by one that asks again.
        if (msg.wantHistogram && !prepassPending) {
          respond({ type: "histogram", histogram: renderer.computeHistogram(!!msg.wantExtended) });
        }
      } catch (err) {
        if (framePosted) {
          respond({ type: "histogramError", message: `histogram failed: ${messageOf(err)}` });
        } else {
          bitmap?.close();
          respond({ type: "renderError", seq: msg.seq, message: messageOf(err) });
        }
      }
    },

    computeHistogram(msg) {
      const { renderer } = state;
      if (!renderer || state.awaitingSource) return;
      bindLiveView(ctx, renderer);
      const histogram = renderer.computeHistogram(!!msg.wantExtended);
      respond({ type: "histogram", histogram });
    },
  };
  return handlers;
}
