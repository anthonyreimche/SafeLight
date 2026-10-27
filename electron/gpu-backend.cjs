// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Linux ANGLE backend ladder main.cjs probes at startup. Chromium no
// longer falls back to SwiftShader for WebGL by itself, so a machine whose GL
// driver can't give WebGL2 (a VirtualBox guest, llvmpipe) got no WebGL at all
// and Develop stayed blank. Software rendering is the explicit last rung, and
// a session that shows the hardware path unusable sends the next launch there.
// Pure and dependency-free so the unit suite can pin it.

"use strict";

const SOFTWARE_BACKEND = "swiftshader";

/** Backends in the order the startup probe tries them. Vulkan with native
 *  Wayland is incompatible, so a Wayland session skips it. */
function angleBackends(isWayland) {
  return isWayland ? ["gl", "gles", SOFTWARE_BACKEND] : ["gl", "gles", "vulkan", SOFTWARE_BACKEND];
}

/** The command-line switches, as [name, value?], that select `backend`. */
function angleSwitches(backend) {
  if (backend !== SOFTWARE_BACKEND) return [["use-angle", backend]];
  return [["use-gl", "angle"], ["use-angle", SOFTWARE_BACKEND], ["enable-unsafe-swiftshader"]];
}

/** Whether app.getGPUFeatureStatus() says WebGL2 is off or unavailable. A
 *  status it can't read counts as fine, so an odd value never forces software. */
function webgl2Lost(status) {
  const webgl2 = status && status.webgl2;
  return typeof webgl2 === "string" && /^(?:unavailable|disabled)_/.test(webgl2);
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

/** The cache file's text: the backend on the first line, and for software the
 *  reason on the second. Versions before the reason wrote the first line only. */
function formatBackendCache(backend, reason) {
  return reason ? `${backend}\n${reason}\n` : `${backend}\n`;
}

/** The backend the cache names, if `backends` has it, and a known reason. */
function parseBackendCache(text, backends) {
  const [first = "", second = ""] = String(text).split(/\r?\n/).map((line) => line.trim());
  const backend = backends.includes(first) ? first : null;
  const reason = backend && SOFTWARE_REASONS.has(second) ? second : null;
  return { backend, reason };
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

module.exports = {
  SOFTWARE_BACKEND,
  angleBackends,
  angleSwitches,
  webgl2Lost,
  softwareFallbackFor,
  formatBackendCache,
  parseBackendCache,
  backendState,
};
