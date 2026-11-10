// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Captures and read-backs from the develop renderer: frames drawn with other
// params (extensions measure them), float frames, the source sample, probes and
// Upright's downscale. Each is answered by its reqId whatever happens: the
// generic "error" carries none, so the awaiting promise would hang.

import type { DevelopParams } from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import { withPipeline } from "@/extensions/pipelines";
import type { FloatFrame } from "../float-frame";
import type { SourceSample } from "../source-sample";
import type { WebGLRenderer } from "../webgl/renderer";
import { bindLiveView, messageOf, showScreen, type HandlersFor, type WorkerContext } from "./context";

// A capture's values drawn over the region the live view shows, which is what a
// capture is aligned to: crop mode widens the view past the crop to the whole image,
// and the params an extension hands over carry the crop itself. The region is the
// geometry stage's derived value (geometry.ts).
function inLiveRegion(
  live: WebGLRenderer,
  lastDerived: Record<string, unknown>,
  derived: Record<string, unknown>,
): Record<string, unknown> {
  const keys = live.geometryKeys;
  if (!keys || !(keys.region in lastDerived)) return derived;
  return { ...derived, [keys.region]: lastDerived[keys.region] };
}

// Runs `draw` with a capture's params (in the live view's region), its photo's
// pipeline and its bag patch merged over the live bag, on the screen when `shown`;
// extensions measure captures, so they stay sRGB and unproofed unless one asks for
// the frame as it is shown. Whatever happens, the live view gets back what its next
// render binds, and liveStateStale has a readback before that render draw it first.
function drawCapture<T>(
  ctx: WorkerContext,
  live: WebGLRenderer,
  capture: {
    params: DevelopParams;
    derived: Record<string, unknown>;
    pipeline: ResolvedPipeline;
    bagPatch?: Record<string, unknown>;
  },
  shown: boolean,
  draw: () => T,
): T {
  const { state } = ctx;
  showScreen(state, live, shown);
  const patched = capture.bagPatch !== undefined;
  try {
    if (patched) ctx.setBag(live, { ...state.latestParamBag, ...capture.bagPatch });
    return withPipeline(live, capture.pipeline, state.latestPipeline, () => {
      live.setParams(capture.params, inLiveRegion(live, state.lastDerived, capture.derived));
      return draw();
    });
  } finally {
    // The patched bag was this capture's alone; the live view renders
    // with the merged bag again, as thumbnails restore theirs.
    if (patched) ctx.setBag(live, state.latestParamBag);
    showScreen(state, live, true);
    state.liveStateStale = true;
    if (state.lastParams) live.setParams(state.lastParams, state.lastDerived);
  }
}

type CaptureCmd = "capture" | "captureFloat" | "readSourceSample" | "probe" | "readDevelopedPixels";

export function captureHandlers(ctx: WorkerContext): HandlersFor<CaptureCmd> {
  const { state, respond } = ctx;
  const blankCapture = (reqId: number): void => {
    const blank = new OffscreenCanvas(1, 1);
    respond({ type: "captured", reqId, bitmap: blank.transferToImageBitmap() });
  };
  return {
    capture(msg) {
      // Render `params` with their photo's pipeline to a detached bitmap
      // without touching the display canvas the main thread blits from.
      // transferToImageBitmap() resets the offscreen, so the next live
      // render() repaints it, with what drawCapture puts back.
      const { renderer: live, canvas: target } = state;
      if (!live || !target) {
        blankCapture(msg.reqId);
        return;
      }
      const shown = msg.asShown === true;
      // A throw here settles with the blank fallback.
      try {
        const captured = drawCapture(ctx, live, msg, shown, () => {
          // Only a frame drawn over the canvas keeps what the view draws for
          // the eye; a measured one would carry it into its numbers.
          live.render({ viewOverlays: shown });
          return target.transferToImageBitmap();
        });
        respond({ type: "captured", reqId: msg.reqId, bitmap: captured }, [captured]);
      } catch (err) {
        console.error("[render-worker] capture failed:", err);
        blankCapture(msg.reqId);
      }
    },

    captureFloat(msg) {
      // Between photos the bound source is the last photo's, so nothing is drawn.
      let frame: FloatFrame | null = null;
      const live = state.renderer;
      if (live && !state.awaitingSource) {
        try {
          const read = drawCapture(ctx, live, msg, false, () => live.readFloatFrame(msg.point, msg.maxEdge, msg.space));
          if (read) frame = { ...read, space: msg.space, point: msg.point };
        } catch (err) {
          console.error("[render-worker] float capture failed:", err);
        }
      }
      respond({ type: "capturedFloat", reqId: msg.reqId, frame }, frame ? [frame.data.buffer] : undefined);
    },

    readSourceSample(msg) {
      // Between photos the bound source is the last photo's, so nothing is handed over.
      let sample: SourceSample | null = null;
      if (state.renderer && !state.awaitingSource) {
        try {
          sample = state.renderer.readSourceSample();
        } catch (err) {
          console.error("[render-worker] source sample failed:", err);
        }
      }
      respond({ type: "sourceSample", reqId: msg.reqId, sample }, sample ? [sample.data.buffer] : undefined);
    },

    probe(msg) {
      // Between photos the bound source is the last photo's, so nothing is read.
      // The probe binds the live frame's program again itself, so a readback
      // after it needs no redraw.
      let rgb: [number, number, number] | null = null;
      if (state.renderer && !state.awaitingSource) {
        try {
          rgb = state.renderer.probe(msg.u, msg.v, msg.point);
        } catch (err) {
          console.error("[render-worker] probe failed:", err);
        }
      }
      respond({ type: "probed", reqId: msg.reqId, rgb });
    },

    readDevelopedPixels(msg) {
      // Always respond, even with no renderer or no readable pixels: the bridge's
      // promise has no timeout. A throw settles via developedPixelsError, which
      // carries the reqId.
      try {
        const { renderer } = state;
        if (renderer) bindLiveView(ctx, renderer);
        const read = renderer?.readDownscaledPixels(msg.edge);
        const pixels = read ? { data: read.data, width: read.w, height: read.h } : null;
        respond({ type: "developedPixels", reqId: msg.reqId, pixels }, pixels ? [pixels.data.buffer] : undefined);
      } catch (err) {
        respond({ type: "developedPixelsError", reqId: msg.reqId, message: messageOf(err) });
      }
    },
  };
}
