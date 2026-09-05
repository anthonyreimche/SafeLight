// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Decision logic for mid-session GPU/renderer crash recovery. Virtualized GL
// drivers (VirtualBox VMSVGA especially) can kill the GPU process under load;
// Chromium respawns it, but the app's WebGL worker contexts and the composited
// surface stay dead, leaving a black window whose only cure is a reload. The
// wiring in main.cjs reloads affected windows when these predicates and the
// gate agree. Pure and dependency-free so the unit suite can pin it.

"use strict";

const GPU_FAIL_REASONS = new Set(["crashed", "launch-failed", "abnormal-exit"]);

// "clean-exit" is normal teardown and "killed" is an external actor's choice
// (task manager, OS shutdown) — neither warrants an automatic reload.
const RENDERER_FAIL_REASONS = new Set([
  "crashed",
  "oom",
  "abnormal-exit",
  "launch-failed",
  "integrity-failure",
]);

/** A GPU failure with a window open. Zero-window failures happen during the
 *  startup ANGLE probe, which owns that case (it relaunches with the next
 *  backend); recovering there would fight it. */
function isRuntimeGpuCrash(details, windowCount) {
  return details.type === "GPU" && GPU_FAIL_REASONS.has(details.reason) && windowCount > 0;
}

function isRendererCrash(details) {
  return RENDERER_FAIL_REASONS.has(details.reason);
}

/** Bounded, debounced recovery gate: at most `max` recoveries per session, at
 *  least `minIntervalMs` apart, so a persistently dying GPU degrades to the
 *  old behaviour (user restarts) instead of a reload storm. A denied attempt
 *  consumes neither the budget nor the debounce clock. */
function createRecoveryGate({ max = 3, minIntervalMs = 10_000, now = Date.now } = {}) {
  let used = 0;
  let last = -Infinity;
  return {
    tryRecover() {
      const t = now();
      if (used >= max || t - last < minIntervalMs) return false;
      used += 1;
      last = t;
      return true;
    },
  };
}

module.exports = { isRuntimeGpuCrash, isRendererCrash, createRecoveryGate };
