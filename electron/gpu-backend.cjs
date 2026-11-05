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

/** The command-line switches, as [name, value?], that select `backend`.
 *  Hardware rungs ignore Chromium's GPU blocklist, which would otherwise drop a
 *  listed driver to software compositing; the software rung leaves it alone so
 *  a blocklisted driver isn't forced back into play. Metal is Chromium's own
 *  default on macOS, so that rung names no backend. */
function angleSwitches(backend) {
  if (backend === SOFTWARE_BACKEND) {
    return [["use-gl", "angle"], ["use-angle", SOFTWARE_BACKEND], ["enable-unsafe-swiftshader"]];
  }
  const select = backend === "metal" ? [] : [["use-angle", backend]];
  return [...select, ["ignore-gpu-blocklist"]];
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

/** The cache file's text: the backend on the first line; for software the
 *  reason on the second, on the third when software began (epoch ms) and how
 *  many launches have used it since, and on the fourth the app version that
 *  put it there. Earlier versions read only the first three lines. */
function formatBackendCache({ backend, reason, since, launches, version }) {
  if (since === null) return reason ? `${backend}\n${reason}\n` : `${backend}\n`;
  return `${backend}\n${reason || ""}\n${since} ${launches}\n${version ? `${version}\n` : ""}`;
}

/** Every backend any platform's ladder names. */
const ALL_BACKENDS = ["gl", "gles", "vulkan", "d3d11", "metal", SOFTWARE_BACKEND];

/** The backend the cache names, if `backends` has it, a known reason, the
 *  software clock, and the app version when one was stored. A backend the user
 *  picked that this ladder lacks (Vulkan, picked under X11, read in a Wayland
 *  session) comes back as `elsewhere`, so the launch neither starts on it nor
 *  writes over it. */
function parseBackendCache(text, backends) {
  const [first = "", second = "", third = "", fourth = ""] = String(text).split(/\r?\n/).map((line) => line.trim());
  const backend = backends.includes(first) ? first : null;
  const reason = backend && SOFTWARE_REASONS.has(second) ? second : null;
  const clock = backend ? /^(\d+) (\d+)$/.exec(third) : null;
  const elsewhere = !backend && ALL_BACKENDS.includes(first) && second === "chosen" ? first : null;
  return {
    backend,
    reason,
    since: clock ? Number(clock[1]) : null,
    launches: clock ? Number(clock[2]) : 0,
    ...(clock && fourth ? { version: fourth } : {}),
    ...(elsewhere ? { elsewhere } : {}),
  };
}

/** What Preferences shows: the backend this launch draws with and the one the
 *  next starts on, whether either is software and why, the backend the user
 *  picked (null for Automatic), and the ones this platform can pick from. */
function backendState(current, next, ladder, now, version) {
  const nextSoftware = next.backend === SOFTWARE_BACKEND;
  return {
    software: current === SOFTWARE_BACKEND,
    nextSoftware,
    reason: nextSoftware ? next.reason : null,
    backend: current,
    next: ladder[startRung(ladder, next, null, now, version)],
    choice: next.reason === "chosen" ? next.backend : null,
    backends: ladder,
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
  if (backend !== SOFTWARE_BACKEND) {
    const picked = cache.backend === backend && cache.reason === "chosen";
    return { backend, reason: picked ? "chosen" : null, since: null, launches: 0 };
  }
  if (cache.backend === SOFTWARE_BACKEND) {
    return { ...cache, since: cache.since === null ? now : cache.since, launches: cache.launches + 1 };
  }
  return { backend, reason: "gpu-crashes", since: now, launches: RETRY_AFTER_LAUNCHES - 1 };
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
  angleSwitches,
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
