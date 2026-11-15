// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app and the `slu` engine start Chromium with the same switches, so a
// render in the engine runs on the same path as one in the app. These arrays
// are the switches main.cjs appended, in its order, before they moved here.

import { describe, expect, it, vi } from "vitest";
import { appendSwitches, chromiumSwitches } from "./chromium-switches.cjs";

const COMMON = [
  ["enable-features", "CanvasOopRasterization,SharedArrayBuffer"],
  ["disable-renderer-backgrounding"],
  ["disable-background-timer-throttling"],
  ["disable-backgrounding-occluded-windows"],
  ["disable-domain-reliability"],
  ["disable-component-update"],
  ["disable-features", "Translate,MediaRouter,OptimizationHints"],
];
const CARD = [["force_high_performance_gpu"], ["enable-gpu-rasterization"], ["enable-zero-copy"]];
const SOFTWARE = [
  ["use-gl", "angle"],
  ["use-angle", "swiftshader"],
  ["enable-unsafe-swiftshader"],
  ["disable-gpu-compositing"],
];
const LINUX = [["disable-gpu-sandbox"], ["enable-webgl"], ["ozone-platform-hint", "auto"]];

describe("chromiumSwitches", () => {
  it.each([
    ["win32", "d3d11", [["use-angle", "d3d11"], ["ignore-gpu-blocklist"], ...CARD, ...COMMON]],
    ["win32", "d3d11on12", [["use-angle", "d3d11on12"], ["ignore-gpu-blocklist"], ...CARD, ...COMMON]],
    ["win32", "gl", [["use-angle", "gl"], ["ignore-gpu-blocklist"], ...CARD, ...COMMON]],
    ["win32", "d3d11-warp", [["use-angle", "d3d11-warp"], ["ignore-gpu-blocklist"], ...COMMON]],
    ["win32", "swiftshader", [...SOFTWARE, ...COMMON]],
    ["darwin", "metal", [["ignore-gpu-blocklist"], ...CARD, ...COMMON]],
    ["darwin", "gl", [["use-angle", "gl"], ["ignore-gpu-blocklist"], ...CARD, ...COMMON]],
    ["darwin", "swiftshader", [...SOFTWARE, ...COMMON]],
    ["linux", "gl", [["use-angle", "gl"], ["ignore-gpu-blocklist"], ...CARD, ...LINUX, ...COMMON]],
    ["linux", "gles", [["use-angle", "gles"], ["ignore-gpu-blocklist"], ...CARD, ...LINUX, ...COMMON]],
    ["linux", "vulkan", [["use-angle", "vulkan"], ["ignore-gpu-blocklist"], ...CARD, ...LINUX, ...COMMON]],
    ["linux", "swiftshader", [...SOFTWARE, ...LINUX, ...COMMON]],
  ])("on %s with %s gives the switches main.cjs always appended", (platform, backend, expected) => {
    expect(chromiumSwitches(backend, platform)).toEqual(expected);
  });
});

describe("appendSwitches", () => {
  it("appends a bare switch without a value and a valued one with it, in order", () => {
    const appendSwitch = vi.fn();
    appendSwitches({ appendSwitch }, [["use-angle", "d3d11"], ["ignore-gpu-blocklist"], ["ozone-platform-hint", "auto"]]);
    expect(appendSwitch.mock.calls).toEqual([["use-angle", "d3d11"], ["ignore-gpu-blocklist"], ["ozone-platform-hint", "auto"]]);
  });
});
