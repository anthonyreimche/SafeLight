// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Chromium switches a launch starts with, for the app and for the `slu`
// engine alike, so a render in the engine takes the same path as one in the
// app. They must be appended before app `ready`. Pure, so the unit suite pins
// them.

"use strict";

const { angleSwitches, graphicsCardSwitches } = require("./gpu-backend.cjs");

/** Every switch a launch on `backend` appends, as [name, value?], in order. */
function chromiumSwitches(backend, platform) {
  return [
    ...angleSwitches(backend),
    ...graphicsCardSwitches(backend).map(([name]) => [name]),
    ...(platform === "linux"
      ? [
          ["disable-gpu-sandbox"],
          ["enable-webgl"],
          // Native Wayland rendering (no XWayland overhead); auto-detects X11 too.
          ["ozone-platform-hint", "auto"],
        ]
      : []),
    // SharedArrayBuffer: Chromium only grants crossOriginIsolated on http(s)
    // origins, so the COOP/COEP headers on app:// are not honoured and
    // libraw-wasm would fall back to the slow CPU decoder / embedded JPEG
    // preview. This re-enables SAB unconditionally (safe here — we only load
    // our own bundle).
    ["enable-features", "CanvasOopRasterization,SharedArrayBuffer"],
    // Keep RAW-decode workers and renders at full speed when the window is
    // occluded, in the background or never shown.
    ["disable-renderer-backgrounding"],
    ["disable-background-timer-throttling"],
    ["disable-backgrounding-occluded-windows"],
    // Privacy: Safelight ships no telemetry of its own. Belt-and-suspenders,
    // turn off Chromium's own background network services so no
    // component-update or domain-reliability traffic leaves the machine
    // without an explicit user action.
    ["disable-domain-reliability"],
    ["disable-component-update"],
    ["disable-features", "Translate,MediaRouter,OptimizationHints"],
  ];
}

/** Appends `switches` to app.commandLine. */
function appendSwitches(commandLine, switches) {
  for (const [name, value] of switches) {
    if (value === undefined) commandLine.appendSwitch(name);
    else commandLine.appendSwitch(name, value);
  }
}

module.exports = { chromiumSwitches, appendSwitches };
