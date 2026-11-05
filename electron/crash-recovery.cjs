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
 *  least `minIntervalMs` apart, so a persistently dying GPU ends in a restart
 *  prompt instead of a reload storm. "ok" recovers; "debounced" is part of a
 *  recovery already under way; "spent" means reloading has stopped helping. A
 *  denied attempt consumes neither the budget nor the debounce clock. */
function createRecoveryGate({ max = 3, minIntervalMs = 10_000, now = Date.now } = {}) {
  let used = 0;
  let last = -Infinity;
  return {
    tryRecover() {
      const t = now();
      if (used >= max) return "spent";
      if (t - last < minIntervalMs) return "debounced";
      used += 1;
      last = t;
      return "ok";
    },
  };
}

// net::ERR_ABORTED: a load another navigation replaced, not one that failed.
const ERR_ABORTED = -3;

/** A did-fail-load for the window's own page, not a frame inside it. */
function isMainFrameLoadFailure(errorCode, isMainFrame) {
  return isMainFrame === true && errorCode !== ERR_ABORTED;
}

const RESTART = 0;

const RESTART_MESSAGES = {
  renderer: {
    message: "Safelight's window keeps crashing.",
    detail: "Reloading it didn't help. Restart Safelight to carry on.",
  },
  gpu: {
    message: "Safelight's graphics stopped working.",
    detail: "Reloading didn't help. Restart Safelight to carry on.",
  },
  load: {
    message: "Safelight's window couldn't load.",
    detail: "Trying again didn't help. Restart Safelight, or reinstall it if this keeps happening.",
  },
};

const SOFTWARE_NEXT_DETAIL =
  "After a restart Safelight draws in software: slower, but it doesn't depend on the graphics driver.";

/** dialog.showMessageBox options for a window reloading can't save.
 *  `softwareNext`: the restart moves a graphics-card launch to software. */
function restartPrompt(kind, softwareNext = false) {
  const { message, detail } = RESTART_MESSAGES[kind];
  return {
    type: "error",
    title: "Safelight",
    message,
    detail: kind === "gpu" && softwareNext ? SOFTWARE_NEXT_DETAIL : detail,
    buttons: ["Restart", "Quit"],
    defaultId: RESTART,
    cancelId: 1,
    noLink: true,
  };
}

/** What died this launch, for Report an issue: the renderer reloads after a
 *  crash and loses its own record, so the main process keeps one. Clean exits
 *  are normal teardown and left out. */
function createCrashLog({ max = 20, now = Date.now } = {}) {
  const entries = [];
  return {
    record(processType, details) {
      if (!details || details.reason === "clean-exit") return;
      entries.push({
        time: now(),
        process: String(processType),
        reason: String(details.reason),
        exitCode: Number(details.exitCode) || 0,
        ...(details.name ? { name: String(details.name) } : {}),
      });
      if (entries.length > max) entries.shift();
    },
    list() {
      return entries.map((e) => ({ ...e }));
    },
  };
}

module.exports = {
  isRuntimeGpuCrash,
  isRendererCrash,
  createRecoveryGate,
  createCrashLog,
  isMainFrameLoadFailure,
  restartPrompt,
  RESTART,
};
