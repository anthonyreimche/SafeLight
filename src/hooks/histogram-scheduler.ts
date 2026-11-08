// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// When the develop view asks the worker for a histogram: after something the
// histogram measures changed, throttled while editing live or once edits go quiet,
// according to Preferences. Frames that only move the view or fade an overlay leave
// it clear.

import type { HistogramData } from "@/rendering/histogram";
import { getSettings } from "@/state/settings-store";

const HIST_THROTTLE = 80;
// When live histogram is off, recompute only once edits go quiet for this long.
const HIST_SETTLE = 250;

export interface HistogramHost {
  /** Whether a render waits for its animation frame. */
  renderQueued: () => boolean;
  /** Asks the worker for the histogram of its last render. */
  compute: () => void;
  publish: (histogram: HistogramData) => void;
}

export interface HistogramScheduler {
  /** Something the histogram measures has changed since one was last asked for. */
  markDirty: () => void;
  /** The source just drawn comes with its own histogram. */
  clearDirty: () => void;
  /** A frame arrived, with the histogram it carries if it asked for one. `follows`:
   *  it asked for one that comes on its own, so none is recomputed for it. */
  onFrame: (histogram: HistogramData | undefined, follows?: boolean) => void;
  /** The histogram a frame said would follow it arrived. */
  onHistogram: (histogram: HistogramData) => void;
  /** Drops a request still waiting. */
  dispose: () => void;
}

export function createHistogramScheduler(host: HistogramHost): HistogramScheduler {
  let dirty = false;
  // performance.now() of the last change that set `dirty`.
  let dirtyAt = 0;
  // Counts the changes that set `dirty`, to tell whether the histogram of a frame
  // measured them all.
  let changes = 0;
  // `changes` when the last frame whose histogram follows came, if it hasn't.
  let followedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastAt = 0;

  const recompute = () => {
    timer = null;
    lastAt = performance.now();
    // The worker measures its last render, so an edit whose render still waits
    // for its animation frame needs that frame to ask again. A render waiting in
    // the bridge's mailbox takes the request itself (RenderBridge.computeHistogram).
    dirty = host.renderQueued();
    // Ask the worker to compute the histogram from the RGBA16F render pipeline
    // and deliver it via setOnHistogram. The previous main-thread path read the
    // 2D display canvas with getImageData, which is ALWAYS 8-bit — so 256 source
    // codes mapped into 256 bins, and any tonal stretch (curve/exposure/WB)
    // spread them apart into the comb/banding you see. The canvas is 8-bit no
    // matter how high-bit the pipeline is, so it can never produce a clean
    // histogram; only the in-worker float readback can.
    host.compute();
  };

  return {
    markDirty() {
      dirty = true;
      changes++;
      dirtyAt = performance.now();
    },
    clearDirty() {
      dirty = false;
    },
    onFrame(histogram, follows = false) {
      if (histogram) {
        host.publish(histogram);
        lastAt = performance.now();
        return;
      }
      if (follows) followedAt = changes;
      if (follows || !dirty) return;
      if (getSettings().liveHistogram) {
        // Live: recompute continuously while editing, throttled to HIST_THROTTLE.
        if (!timer) {
          const elapsed = performance.now() - lastAt;
          const delay = Math.max(0, HIST_THROTTLE - elapsed);
          timer = setTimeout(recompute, delay);
        }
      } else {
        // Off: debounce — reset on every frame so we only recompute after the
        // edit settles, instead of on each intermediate frame. Counted from the
        // edit, not the frame: Auto Tone/WB give each step's histogram 450 ms,
        // and a slow render would otherwise use that up.
        if (timer) clearTimeout(timer);
        const sinceEdit = performance.now() - dirtyAt;
        timer = setTimeout(recompute, Math.max(0, HIST_SETTLE - sinceEdit));
      }
    },
    onHistogram(histogram) {
      host.publish(histogram);
      lastAt = performance.now();
      if (followedAt === changes) dirty = false;
      followedAt = null;
    },
    dispose() {
      followedAt = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastAt = 0;
    },
  };
}
