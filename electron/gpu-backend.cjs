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

// Why the next launch draws in software: the user turned it on in Preferences,
// or this machine failed on the graphics card.
const SOFTWARE_REASONS = new Set(["chosen", "webgl2-unavailable", "gpu-crashes"]);

/** The cache file's text: the backend on the first line; for software the
 *  reason on the second, and on the third when software began (epoch ms) and
 *  how many launches have used it since. Earlier versions read only the first
 *  two lines. */
function formatBackendCache({ backend, reason, since, launches }) {
  if (since === null) return reason ? `${backend}\n${reason}\n` : `${backend}\n`;
  return `${backend}\n${reason || ""}\n${since} ${launches}\n`;
}

/** The backend the cache names, if `backends` has it, a known reason, and the
 *  software clock. */
function parseBackendCache(text, backends) {
  const [first = "", second = "", third = ""] = String(text).split(/\r?\n/).map((line) => line.trim());
  const backend = backends.includes(first) ? first : null;
  const reason = backend && SOFTWARE_REASONS.has(second) ? second : null;
  const clock = backend ? /^(\d+) (\d+)$/.exec(third) : null;
  return {
    backend,
    reason,
    since: clock ? Number(clock[1]) : null,
    launches: clock ? Number(clock[2]) : 0,
  };
}

/** What Preferences shows: whether this launch and the next draw in software,
 *  and why the next one does. */
function backendState(current, next) {
  const nextSoftware = next.backend === SOFTWARE_BACKEND;
  return {
    software: current === SOFTWARE_BACKEND,
    nextSoftware,
    reason: nextSoftware ? next.reason : null,
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
 *  user chose never is; one with no start date predates the clock, so it is. */
function retriesHardware(cache, now) {
  if (cache.backend !== SOFTWARE_BACKEND || cache.reason === "chosen") return false;
  if (cache.since === null) return true;
  return cache.launches >= RETRY_AFTER_LAUNCHES || now - cache.since >= RETRY_AFTER_MS;
}

/** The ladder index this launch starts on: the rung a probe relaunch asked
 *  for, else the cached backend unless it is due a retry, else the first. */
function startRung(ladder, cache, relaunchIdx, now) {
  if (relaunchIdx !== null) return Math.max(0, Math.min(relaunchIdx, ladder.length - 1));
  if (!cache.backend || retriesHardware(cache, now)) return 0;
  return Math.max(0, ladder.indexOf(cache.backend));
}

/** What the cache holds once a launch on `backend` reaches ready. Software the
 *  cache already named counts one more launch. Software the probe reached by
 *  relaunching past each crashed rung is due a retry soon: on a two-rung
 *  ladder that can be a single passing crash. */
function readyCache(backend, cache, now) {
  if (backend !== SOFTWARE_BACKEND) return { backend, reason: null, since: null, launches: 0 };
  if (cache.backend === SOFTWARE_BACKEND) {
    return { ...cache, since: cache.since === null ? now : cache.since, launches: cache.launches + 1 };
  }
  return { backend, reason: "gpu-crashes", since: now, launches: RETRY_AFTER_LAUNCHES - 1 };
}

/** The software cache written when a session finds the graphics card unusable,
 *  or the user turns software on. */
function fallbackCache(reason, now) {
  return { backend: SOFTWARE_BACKEND, reason, since: now, launches: 0 };
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
  formatBackendCache,
  parseBackendCache,
  backendState,
  backendCacheFiles,
  retriesHardware,
  startRung,
  readyCache,
  fallbackCache,
  relaunchRung,
  relaunchArgs,
  relaunchOptions,
};
