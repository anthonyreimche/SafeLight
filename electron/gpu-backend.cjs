// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The ANGLE backend ladder main.cjs probes at startup. Chromium no longer
// falls back to SwiftShader for WebGL by itself, so a machine whose GL driver
// can't give WebGL2 (a VirtualBox guest, llvmpipe, a Hyper-V or UTM VM) got no
// WebGL at all and Develop stayed blank. Software rendering is the explicit
// last rung, and a session that shows the hardware path unusable sends the
// next launch there. Pure and Electron-free so the unit suite can pin it.

"use strict";

const path = require("node:path");

const SOFTWARE_BACKEND = "swiftshader";

/** Software Safelight picked for itself tries the graphics card again after
 *  this many launches or this long, whichever comes first. */
const RETRY_AFTER_LAUNCHES = 10;
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const RUNG_ARG = "--safelight-angle-idx=";
const CACHE_NAME = "gpu-backend";

/** Linux backends in the order the startup probe tries them. Vulkan with
 *  native Wayland is incompatible, so a Wayland session skips it. */
function angleBackends(isWayland) {
  return isWayland ? ["gl", "gles", SOFTWARE_BACKEND] : ["gl", "gles", "vulkan", SOFTWARE_BACKEND];
}

/** This platform's backends in probe order, software last. */
function gpuLadder(platform, isWayland) {
  if (platform === "win32") return ["d3d11", SOFTWARE_BACKEND];
  if (platform === "darwin") return ["metal", SOFTWARE_BACKEND];
  return angleBackends(isWayland);
}

/** WARP is Microsoft's Direct3D drawn on the processor. */
const WARP_BACKEND = "d3d11-warp";

/** The backends Preferences offers, software last: on Windows also Direct3D 11
 *  on 12, OpenGL and WARP, each checked in Safelight (Vulkan and Direct3D 9 give
 *  no WebGL2 there); on macOS also OpenGL, as Chromium's own backend menu has.
 *  Linux's ladder already holds every backend Chromium has there. Automatic
 *  keeps to gpuLadder. */
function backendChoices(platform, isWayland) {
  if (platform === "win32") return ["d3d11", "d3d11on12", "gl", WARP_BACKEND, SOFTWARE_BACKEND];
  if (platform === "darwin") return ["metal", "gl", SOFTWARE_BACKEND];
  return gpuLadder(platform, isWayland);
}

/** The backend this launch starts on: a probe relaunch's rung, else a pick
 *  Preferences offers (one Automatic doesn't try included), else Automatic's
 *  rung for the cache. */
function launchBackend(ladder, choices, cache, relaunchIdx, now, version) {
  if (relaunchIdx === null && cache.reason === "chosen" && choices.includes(cache.backend)) return cache.backend;
  return ladder[startRung(ladder, cache, relaunchIdx, now, version)];
}

/** The command-line switches, as [name, value?], that select `backend`.
 *  Hardware rungs ignore Chromium's GPU blocklist, which would otherwise drop a
 *  listed driver to software compositing; the software rung leaves it alone so
 *  a blocklisted driver isn't forced back into play. Metal is Chromium's own
 *  default on macOS, so that rung names no backend. The software rung
 *  composites on the processor, as Chromium's own software mode does: a window
 *  composited through SwiftShader stayed empty on Windows. */
function angleSwitches(backend) {
  if (backend === SOFTWARE_BACKEND) {
    return [
      ["use-gl", "angle"],
      ["use-angle", SOFTWARE_BACKEND],
      ["enable-unsafe-swiftshader"],
      ["disable-gpu-compositing"],
    ];
  }
  const select = backend === "metal" ? [] : [["use-angle", backend]];
  return [...select, ["ignore-gpu-blocklist"]];
}

/** Speed-ups that need a graphics card: the faster of two cards, the page drawn
 *  on it, and uploads straight to its memory. None in software or WARP, which
 *  draw on the processor. */
function graphicsCardSwitches(backend) {
  if (backend === SOFTWARE_BACKEND || backend === WARP_BACKEND) return [];
  return [["force_high_performance_gpu"], ["enable-gpu-rasterization"], ["enable-zero-copy"]];
}

/** Whether app.getGPUFeatureStatus() says WebGL2 is off or unavailable. WebGL
 *  off means WebGL2 off too, and Chromium 148 reports only the webgl entry. A
 *  status it can't read counts as fine, so an odd value never forces software. */
function webgl2Lost(status) {
  const off = (value) => typeof value === "string" && /^(?:unavailable|disabled)_/.test(value);
  return !!status && (off(status.webgl) || off(status.webgl2));
}

/** Where the next launch goes once `backend` proved unusable mid-session, or
 *  null when it is already software. Straight to software: a driver that loses
 *  WebGL2 on one hardware backend rarely keeps it on another, and every rung
 *  tried costs the user a restart. */
function softwareFallbackFor(backend) {
  return backend === SOFTWARE_BACKEND ? null : SOFTWARE_BACKEND;
}

/** Where the next launch goes once the develop renderer couldn't start on
 *  `backend`: the next rung down `ladder`, since another hardware backend may
 *  link the shader that this one couldn't. Null when it is already software. */
function rendererFallbackFor(ladder, backend) {
  if (backend === SOFTWARE_BACKEND) return null;
  return ladder[ladder.indexOf(backend) + 1] ?? SOFTWARE_BACKEND;
}

// Why the next launch starts where it does: the user picked that backend in
// Preferences, or this machine failed on the graphics card and is in software.
const SOFTWARE_REASONS = new Set(["chosen", "webgl2-unavailable", "gpu-crashes", "renderer-failed"]);

// The trial lines, from the fifth line on: the selection a change in Preferences
// goes back to if it isn't kept, and the change that went back and why, which
// the launch after going back names.
const REVERT_TO = "revert-to";
const REVERTED_FROM = "reverted-from";
const UNKEPT = "unkept";

/** How long the first window on a changed backend has for the user to keep it.
 *  A window that opens but draws nothing reports no error, and nobody can press
 *  Keep in it. */
const CONFIRM_WITHIN_MS = 20_000;

/** The cache file's text: the backend on the first line; for software the
 *  reason on the second, on the third when software began (epoch ms) and how
 *  many launches have used it since, and on the fourth the app version that
 *  put it there. A change on trial adds its lines after those four, which are
 *  then padded out. Earlier versions read only the first four lines. */
function formatBackendCache({ backend, reason, since, launches, version, revertTo, reverted }) {
  const head =
    since === null
      ? [backend ?? "", ...(reason ? [reason] : [])]
      : [backend, reason || "", `${since} ${launches}`, ...(version ? [version] : [])];
  const trial = [
    ...(revertTo === undefined ? [] : [`${REVERT_TO} ${revertTo}`]),
    ...(reverted === undefined ? [] : [`${REVERTED_FROM} ${reverted.from}${reverted.because === UNKEPT ? ` ${UNKEPT}` : ""}`]),
  ];
  if (trial.length === 0) return `${head.join("\n")}\n`;
  return `${[...head, ...Array(4 - head.length).fill(""), ...trial].join("\n")}\n`;
}

/** Every backend any platform's ladder or picks name. */
const ALL_BACKENDS = ["gl", "gles", "vulkan", "d3d11", "d3d11on12", WARP_BACKEND, "metal", SOFTWARE_BACKEND];

/** The Preferences entry that lets Safelight pick the backend itself. */
const AUTOMATIC = "auto";

/** The backend the cache names, if `backends` has it, a known reason, the
 *  software clock, and the app version when one was stored. A backend the user
 *  picked that this ladder lacks (Vulkan, picked under X11, read in a Wayland
 *  session) comes back as `elsewhere`, so the launch neither starts on it nor
 *  writes over it. A selection to go back to that `backends` lacks reads as
 *  Automatic. */
function parseBackendCache(text, backends) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim());
  const [first = "", second = "", third = "", fourth = ""] = lines;
  const backend = backends.includes(first) ? first : null;
  const reason = backend && SOFTWARE_REASONS.has(second) ? second : null;
  const clock = backend ? /^(\d+) (\d+)$/.exec(third) : null;
  const elsewhere = !backend && ALL_BACKENDS.includes(first) && second === "chosen" ? first : null;
  const trialLine = (key) => lines.slice(4).find((line) => line.startsWith(`${key} `))?.slice(key.length + 1).trim();
  const revertTo = trialLine(REVERT_TO);
  const [revertedFrom, because] = trialLine(REVERTED_FROM)?.split(/\s+/) ?? [];
  return {
    backend,
    reason,
    since: clock ? Number(clock[1]) : null,
    launches: clock ? Number(clock[2]) : 0,
    ...(clock && fourth ? { version: fourth } : {}),
    ...(elsewhere ? { elsewhere } : {}),
    ...(revertTo === undefined ? {} : { revertTo: backends.includes(revertTo) ? revertTo : AUTOMATIC }),
    ...(revertedFrom === AUTOMATIC || ALL_BACKENDS.includes(revertedFrom)
      ? { reverted: { from: revertedFrom, because: because === UNKEPT ? UNKEPT : "failed" } }
      : {}),
  };
}

/** What Preferences shows: the backend this launch draws with and the one the
 *  next starts on, whether either is software and why, the backend the user
 *  picked (null for Automatic), the ones this platform can pick from, the
 *  selection a change on trial goes back to, the change this launch went back
 *  from and why, and when a change this launch is trying goes back unless kept
 *  (epoch ms). */
function backendState(current, next, ladder, now, version, choices = ladder, { reverted = null, keepBy = null } = {}) {
  const nextSoftware = next.backend === SOFTWARE_BACKEND;
  return {
    software: current === SOFTWARE_BACKEND,
    nextSoftware,
    reason: nextSoftware ? next.reason : null,
    backend: current,
    next: launchBackend(ladder, choices, next, null, now, version),
    choice: next.reason === "chosen" ? next.backend : null,
    backends: choices,
    revertTo: next.revertTo ?? null,
    reverted,
    keepBy,
  };
}

/** Earlier versions kept the Linux cache in the XDG config folder, outside
 *  userData. Null when neither XDG_CONFIG_HOME nor HOME is absolute. */
function legacyLinuxCacheFile(env) {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && path.posix.isAbsolute(xdg)) return path.posix.join(xdg, "safelight", CACHE_NAME);
  const home = env.HOME;
  if (home && path.posix.isAbsolute(home)) return path.posix.join(home, ".config", "safelight", CACHE_NAME);
  return null;
}

/** The cache file, under userData, and the old Linux one to read once and
 *  remove. With no absolute userData the old location stands in; with neither,
 *  nothing is cached and every launch probes. */
function backendCacheFiles(userData, platform, env) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const legacy = platform === "linux" ? legacyLinuxCacheFile(env) : null;
  const file = userData && paths.isAbsolute(userData) ? paths.join(userData, CACHE_NAME) : legacy;
  return { file, legacy: legacy === file ? null : legacy };
}

/** Whether a software cache is due a try on the graphics card. Software the
 *  user chose never is; one with no start date predates the clock, so it is.
 *  A renderer that couldn't start would fail the same way again, so that waits
 *  for a different app version. */
function retriesHardware(cache, now, version) {
  if (cache.backend !== SOFTWARE_BACKEND || cache.reason === "chosen") return false;
  if (cache.reason === "renderer-failed" && cache.version === version) return false;
  if (cache.since === null) return true;
  return cache.launches >= RETRY_AFTER_LAUNCHES || now - cache.since >= RETRY_AFTER_MS;
}

/** The ladder index this launch starts on: the rung a probe relaunch asked
 *  for, else the cached backend unless it is due a retry, else the first. */
function startRung(ladder, cache, relaunchIdx, now, version) {
  if (relaunchIdx !== null) return Math.max(0, Math.min(relaunchIdx, ladder.length - 1));
  if (!cache.backend || retriesHardware(cache, now, version)) return 0;
  return Math.max(0, ladder.indexOf(cache.backend));
}

/** What the cache holds once a launch on `backend` reaches ready. Software the
 *  cache already named counts one more launch. Software the probe reached by
 *  relaunching past each crashed rung is due a retry soon: on a two-rung
 *  ladder that can be a single passing crash. */
function readyCache(backend, cache, now) {
  const { reverted, ...kept } = cache;
  const trial = kept.revertTo === undefined ? {} : { revertTo: kept.revertTo };
  if (backend !== SOFTWARE_BACKEND) {
    const picked = kept.backend === backend && kept.reason === "chosen";
    return { backend, reason: picked ? "chosen" : null, since: null, launches: 0, ...trial };
  }
  if (kept.backend === SOFTWARE_BACKEND) {
    return { ...kept, since: kept.since === null ? now : kept.since, launches: kept.launches + 1 };
  }
  return { backend, reason: "gpu-crashes", since: now, launches: RETRY_AFTER_LAUNCHES - 1, ...trial };
}

/** The Preferences entry a cache stands for: the backend the user picked, or
 *  Automatic. */
function selectionOf(cache) {
  return cache.reason === "chosen" && cache.backend ? cache.backend : AUTOMATIC;
}

/** The cache for a change made in Preferences, on trial until the user keeps
 *  it: `revertTo` is where the next launch goes if it isn't kept. Not on trial
 *  when that is the selection itself. */
function pickCache(selection, revertTo, now, version) {
  const cache =
    selection === AUTOMATIC ? { backend: null, reason: null, since: null, launches: 0 } : chosenCache(selection, now, version);
  return revertTo === undefined || revertTo === selection ? cache : { ...cache, revertTo };
}

/** Where a change made now goes back to if it isn't kept: this launch's
 *  selection once it was kept, or when it was never on trial; while it is still
 *  on trial, wherever it would go back to; and never a selection that failed
 *  this session. */
function revertTargetFor(cache, kept, failed) {
  if (failed) return cache.revertTo ?? AUTOMATIC;
  if (kept || cache.revertTo === undefined) return selectionOf(cache);
  return cache.revertTo;
}

/** The cache that sends the next launch back to the selection a change on
 *  trial came from, naming the change and `because` ("failed", or "unkept"
 *  when its time ran out); null `because` when the user asked to go back, who
 *  needs no word. Null off trial. */
function revertCache(cache, now, version, because = "failed") {
  if (cache.revertTo === undefined) return null;
  const back = pickCache(cache.revertTo, undefined, now, version);
  return because === null ? back : { ...back, reverted: { from: selectionOf(cache), because } };
}

/** The cache once the user has kept it: off trial. */
function provenCache(cache) {
  const { revertTo, ...proven } = cache;
  return proven;
}

/** The software cache written when a session finds the graphics card unusable,
 *  or the user turns software on. */
function fallbackCache(reason, now, version) {
  return { backend: SOFTWARE_BACKEND, reason, since: now, launches: 0, ...(version ? { version } : {}) };
}

/** The cache for a backend picked in Preferences. Software keeps the software
 *  clock its other reasons use; a graphics-card pick needs none, since it is
 *  never retried away from. */
function chosenCache(backend, now, version) {
  if (backend === SOFTWARE_BACKEND) return fallbackCache("chosen", now, version);
  return { backend, reason: "chosen", since: null, launches: 0 };
}

/** The rung a probe relaunch passed on the command line, or null. */
function relaunchRung(argv) {
  const arg = argv.find((a) => a.startsWith(RUNG_ARG));
  if (!arg) return null;
  const idx = parseInt(arg.slice(RUNG_ARG.length), 10);
  return Number.isNaN(idx) ? null : idx;
}

/** app.relaunch arguments: this launch's, with the probe rung replaced by
 *  `rung`, or dropped so the next launch reads the cache. */
function relaunchArgs(argv, rung) {
  const args = argv.slice(1).filter((a) => !a.startsWith(RUNG_ARG));
  return rung === undefined ? args : [...args, `${RUNG_ARG}${rung}`];
}

/** app.relaunch options: relaunchArgs, run from $APPIMAGE when this is one, as
 *  the executable inside its mount is gone once the process exits. */
function relaunchOptions(argv, env, rung) {
  const args = relaunchArgs(argv, rung);
  return env.APPIMAGE ? { args, execPath: env.APPIMAGE } : { args };
}

module.exports = {
  SOFTWARE_BACKEND,
  RETRY_AFTER_LAUNCHES,
  RETRY_AFTER_MS,
  angleBackends,
  gpuLadder,
  backendChoices,
  launchBackend,
  CONFIRM_WITHIN_MS,
  AUTOMATIC,
  selectionOf,
  pickCache,
  revertTargetFor,
  revertCache,
  provenCache,
  angleSwitches,
  graphicsCardSwitches,
  webgl2Lost,
  softwareFallbackFor,
  rendererFallbackFor,
  formatBackendCache,
  parseBackendCache,
  backendState,
  backendCacheFiles,
  retriesHardware,
  startRung,
  readyCache,
  fallbackCache,
  chosenCache,
  relaunchRung,
  relaunchArgs,
  relaunchOptions,
};
