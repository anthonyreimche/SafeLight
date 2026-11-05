// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The renderers' sources: handing the develop renderer the next photo, and
// the GPU source caches of both renderers.

import {
  THUMB_CACHE_FRACTION,
  postSourcePixels,
  sourceFailed,
  type HandlersFor,
  type WorkerContext,
} from "./context";
import { ensureThumbRenderer } from "./thumbnails";

type SourceCmd =
  | "clearSource"
  | "setImage"
  | "bindSource"
  | "uploadSource"
  | "hasSource"
  | "setCacheBudget"
  | "setSourceSample";

export function sourceHandlers(ctx: WorkerContext): HandlersFor<SourceCmd> {
  const { state, respond } = ctx;
  return {
    clearSource() {
      state.awaitingSource = true;
    },

    setImage(msg) {
      state.sourceGen++;
      const { renderer } = state;
      if (!renderer) return;
      const img = msg.image;
      try {
        if (img.kind === "bitmap") {
          renderer.setImage(img.bitmap, msg.maxEdge, msg.isFallbackPreview);
        } else {
          // Capped like uploadSource below.
          renderer.setImage(img, msg.maxEdge, msg.isFallbackPreview, true);
        }
      } catch (err) {
        sourceFailed(ctx, err);
        return;
      }
      state.awaitingSource = false;
      postSourcePixels(ctx);
    },

    bindSource(msg) {
      let hit = false;
      try {
        hit = !!state.renderer && state.renderer.bindSource(msg.key);
      } catch (err) {
        // The view waits for this answer. A miss has it load and upload the photo
        // itself, which replaces the entry; the renderer may have let go of the
        // source it held, so nothing is drawn until then. Reported as an error too.
        state.awaitingSource = true;
        respond({ type: "sourceBound", reqId: msg.reqId, hit: false });
        throw err;
      }
      if (hit) {
        state.sourceGen++;
        state.awaitingSource = false;
      }
      respond({ type: "sourceBound", reqId: msg.reqId, hit });
      if (hit) postSourcePixels(ctx);
    },

    uploadSource(msg) {
      const bind = msg.bind ?? true;
      const main = msg.target === "main";
      if (bind && main) state.sourceGen++;
      const target = msg.target === "thumb" ? ensureThumbRenderer(ctx) : state.renderer;
      if (!target) return;
      const img = msg.image;
      // Cap a cached float16 source to maxEdge: neither renderer draws larger.
      // The develop cap (2560 px and up) is at least the cache's own edge
      // except at the integrated graphics setting, where a bigger source would
      // only hold memory.
      const capFloat16 = true;
      try {
        if (img.kind === "bitmap") {
          target.uploadSource(msg.key, img.bitmap, msg.maxEdge, msg.isFallbackPreview, bind, capFloat16);
        } else {
          target.uploadSource(msg.key, img, msg.maxEdge, msg.isFallbackPreview, bind, capFloat16);
        }
      } catch (err) {
        if (!bind || !main) throw err;
        sourceFailed(ctx, err);
        return;
      }
      // Only a bind into the main renderer changes the active heal source.
      if (bind && main) {
        state.awaitingSource = false;
        postSourcePixels(ctx);
      }
    },

    hasSource(msg) {
      const target = msg.target === "thumb" ? state.thumbRenderer : state.renderer;
      respond({ type: "hasSource", reqId: msg.reqId, has: !!target && target.hasSource(msg.key) });
    },

    setCacheBudget(msg) {
      state.cacheBudgetBytes = msg.bytes;
      state.renderer?.setCacheBudget(msg.bytes);
      state.thumbRenderer?.setCacheBudget(msg.bytes * THUMB_CACHE_FRACTION);
    },

    setSourceSample(msg) {
      state.renderer?.setSourceSample(msg.key, msg.fullWidth, msg.fullHeight, msg.sample);
    },
  };
}
