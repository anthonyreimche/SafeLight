// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Thumbnails, drawn by their own renderer and canvas so a thumbnail render
// doesn't clobber the develop canvas mid-frame.

import { CURRENT_PROCESS_VERSION, type DevelopParams } from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { withPipeline } from "@/extensions/pipelines";
import type { FloatFrame } from "../float-frame";
import { WebGLRenderer } from "../webgl/renderer";
import {
  THUMB_CACHE_FRACTION,
  messageOf,
  reportQuarantine,
  reportStageBuilds,
  warmUp,
  type HandlersFor,
  type WorkerContext,
} from "./context";

const DEFAULT_THUMB_JPEG_QUALITY = 0.8;

interface ThumbRenderRequest {
  requestId: string;
  params: DevelopParams;
  derived: Record<string, unknown>;
  asShotTemperature: number;
  quality?: number;
  lossless?: boolean;
  contributedParams?: Record<string, unknown>;
  pipeline: ResolvedPipeline;
  float?: Pick<FloatFrame, "point" | "space">;
  preview?: boolean;
}

// A grid preview takes the stages the live view has awake, so the photo being
// edited is drawn by the program the live view draws it with, not by one built
// for every installed stage while the live view waits. Another photo's preview
// that needs more wakes them all at once (wakeTogether). A frame that carries
// data (a headless or float frame) gets every stage.
function wakeFor(ctx: WorkerContext, tr: WebGLRenderer, preview: boolean): void {
  if (preview) tr.wakeStages(ctx.state.renderer?.awakeStages ?? []);
  else tr.wakeAllStages();
}

// `first` is the request that creates the renderer. Its program is built here, with
// that photo's version, display transform and stage values, so a renderer that can't
// build at all fails the request and is not kept, instead of failing every frame
// after it. An upload creates one with no photo to go by (`first` is absent): it
// builds the current version under the pipeline, stages and values the worker holds.
export function ensureThumbRenderer(
  ctx: WorkerContext,
  first?: Pick<ThumbRenderRequest, "params" | "pipeline" | "contributedParams" | "preview">,
): WebGLRenderer {
  const { state } = ctx;
  if (state.thumbRenderer) return state.thumbRenderer;
  const canvas = new OffscreenCanvas(512, 512);
  const created = new WebGLRenderer(canvas, {
    highBitDepth: false,
    pipeline: state.latestPipeline,
    stages: state.latestStages,
    confirmedDraws: [...state.confirmedDraws],
    skipDormantStages: true,
    wakeTogether: true,
    onStageQuarantined: reportQuarantine(ctx),
    onStageBuild: reportStageBuilds(ctx),
  });
  const ownBag = first?.contributedParams;
  try {
    ctx.setBag(created, ownBag ?? state.latestParamBag);
    wakeFor(ctx, created, first ? first.preview === true : true);
    if (first) {
      withPipeline(created, first.pipeline, state.latestPipeline, () =>
        warmUp(created, first.params.processVersion),
      );
    } else {
      warmUp(created, CURRENT_PROCESS_VERSION);
    }
  } catch (err) {
    created.dispose();
    throw err;
  }
  // Chromium evicts the least recently used context when a page holds too many, and
  // that can be this one alone. The renderer and its textures went with it.
  canvas.addEventListener("webglcontextlost", () => {
    if (state.thumbCanvas !== canvas) return;
    state.thumbRenderer?.dispose();
    state.thumbRenderer = null;
    state.thumbCanvas = null;
  });
  state.thumbCanvas = canvas;
  state.thumbRenderer = created;
  if (state.cacheBudgetBytes > 0) created.setCacheBudget(state.cacheBudgetBytes * THUMB_CACHE_FRACTION);
  if (ownBag !== undefined) ctx.setBag(created, state.latestParamBag);
  created.setStageTextures(state.latestStageTextures);
  return created;
}

// Settle a thumbnail request that failed, so the caller's promise rejects (and
// its in-flight bookkeeping clears) instead of hanging on a lost requestId.
function respondThumbError(ctx: WorkerContext, requestId: string, err: unknown): void {
  ctx.respond({ type: "thumbnailError", requestId, message: messageOf(err) });
}

// Shared tail for both thumbnail handlers (after their divergent setImage/bindSource
// preamble): applies params + per-render stage bag and pipeline, renders (or reads
// the frame as floats), restores the global bag and live pipeline, and settles the
// request — including the convertToBlob rejection path — so the caller's promise
// never hangs.
function finishThumbRender(ctx: WorkerContext, tr: WebGLRenderer, msg: ThumbRenderRequest): void {
  const { state } = ctx;
  tr.setAsShotTemperature(msg.asShotTemperature);
  tr.setParams(msg.params, msg.derived);
  const bag = msg.contributedParams;
  if (bag !== undefined) ctx.setBag(tr, bag);
  wakeFor(ctx, tr, msg.preview === true);
  const { float } = msg;
  let read: ReturnType<WebGLRenderer["readFloatFrame"]> = null;
  // Restore the global bag even if the draw throws, or a failed render leaves the
  // thumb renderer holding this photo's stage params and every later thumbnail
  // renders with the wrong photo's uniforms.
  try {
    read = withPipeline(tr, msg.pipeline, state.latestPipeline, () => {
      if (float) return tr.readFloatFrame(float.point, Infinity, float.space);
      tr.render();
      return null;
    });
  } finally {
    if (bag !== undefined) ctx.setBag(tr, state.latestParamBag);
  }
  if (float) {
    const frame: FloatFrame | null = read && { ...read, space: float.space, point: float.point };
    ctx.respond({ type: "thumbnailFloat", requestId: msg.requestId, frame }, frame ? [frame.data.buffer] : undefined);
    return;
  }
  const { thumbCanvas } = state;
  if (!thumbCanvas) throw new Error("thumb canvas unavailable");
  // The event may not have been delivered yet; a lost context encodes a blank frame.
  if (thumbCanvas.getContext("webgl2")?.isContextLost()) throw new Error("The thumbnail graphics context was lost.");
  const encoding: ImageEncodeOptions = msg.lossless
    ? { type: "image/png" }
    : { type: "image/jpeg", quality: msg.quality ?? DEFAULT_THUMB_JPEG_QUALITY };
  thumbCanvas.convertToBlob(encoding).then(
    (blob) => ctx.respond({ type: "thumbnail", requestId: msg.requestId, blob }),
    (err) => respondThumbError(ctx, msg.requestId, err),
  );
}

export function thumbnailHandlers(ctx: WorkerContext): HandlersFor<"renderThumbnail" | "renderThumbnailFromSource"> {
  return {
    renderThumbnail(msg) {
      try {
        const tr = ensureThumbRenderer(ctx, msg);
        const img = msg.image;
        if (img.kind === "bitmap") {
          tr.setImage(img.bitmap, msg.maxEdge);
        } else {
          // Cap a cached float16 source, as uploadSource("thumb") does.
          tr.setImage(img, msg.maxEdge, false, true);
        }
        finishThumbRender(ctx, tr, msg);
      } catch (err) {
        respondThumbError(ctx, msg.requestId, err);
      }
    },

    renderThumbnailFromSource(msg) {
      try {
        const tr = ensureThumbRenderer(ctx, msg);
        // msg.maxEdge is the OUTPUT cap for this thumbnail — smaller than the
        // resident source's own upload cap — so pass it as the bind override.
        if (!tr.bindSource(msg.key, msg.maxEdge)) {
          ctx.respond({ type: "thumbnailMiss", requestId: msg.requestId, key: msg.key });
          return;
        }
        finishThumbRender(ctx, tr, msg);
      } catch (err) {
        respondThumbError(ctx, msg.requestId, err);
      }
    },
  };
}
