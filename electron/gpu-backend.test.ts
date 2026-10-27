// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Linux ANGLE backend ladder (gpu-backend.cjs). Chromium no longer falls
// back to software WebGL on its own, so a guest without usable 3D (VirtualBox,
// reported on MX Linux) needs SwiftShader as an explicit last rung, and a
// session that proves the hardware path unusable moves the next launch onto it.

import { describe, expect, it } from "vitest";
import {
  SOFTWARE_BACKEND,
  angleBackends,
  angleSwitches,
  webgl2Lost,
  softwareFallbackFor,
  parseBackendCache,
  formatBackendCache,
  backendState,
} from "./gpu-backend.cjs";

describe("angleBackends", () => {
  it("ends both ladders on software rendering", () => {
    expect(angleBackends(false)).toEqual(["gl", "gles", "vulkan", SOFTWARE_BACKEND]);
    expect(angleBackends(true)).toEqual(["gl", "gles", SOFTWARE_BACKEND]);
  });
});

describe("angleSwitches", () => {
  it("names the hardware backend alone", () => {
    expect(angleSwitches("gles")).toEqual([["use-angle", "gles"]]);
  });

  // The pair Chromium needs since it stopped falling back to SwiftShader for
  // WebGL by itself; the SwiftShader WebGL test run uses the same switches.
  it("opts in to SwiftShader WebGL on the software rung", () => {
    expect(angleSwitches(SOFTWARE_BACKEND)).toEqual([
      ["use-gl", "angle"],
      ["use-angle", "swiftshader"],
      ["enable-unsafe-swiftshader"],
    ]);
  });
});

describe("webgl2Lost", () => {
  it("is true when Chromium reports WebGL2 off or unavailable", () => {
    for (const webgl2 of ["unavailable_off", "unavailable_software", "disabled_off", "disabled_software"]) {
      expect(webgl2Lost({ webgl2 })).toBe(true);
    }
  });

  it("is false for a working WebGL2 and for a status it can't read", () => {
    for (const webgl2 of ["enabled", "enabled_readback", "enabled_force", "enabled_on"]) {
      expect(webgl2Lost({ webgl2 })).toBe(false);
    }
    expect(webgl2Lost({})).toBe(false);
    expect(webgl2Lost(null)).toBe(false);
    expect(webgl2Lost({ webgl2: 1 })).toBe(false);
  });
});

describe("softwareFallbackFor", () => {
  it("moves a hardware backend straight to software", () => {
    expect(softwareFallbackFor("gl")).toBe(SOFTWARE_BACKEND);
    expect(softwareFallbackFor("vulkan")).toBe(SOFTWARE_BACKEND);
  });

  it("has nowhere to go from software", () => {
    expect(softwareFallbackFor(SOFTWARE_BACKEND)).toBeNull();
  });
});

// The cache holds the backend the next launch starts on, and for software
// why it is there, so Preferences can say whether Safelight or the user chose it.
describe("the backend cache", () => {
  const backends = angleBackends(false);

  it("round-trips a backend and the reason software was picked", () => {
    const text = formatBackendCache(SOFTWARE_BACKEND, "webgl2-unavailable");
    expect(parseBackendCache(text, backends)).toEqual({
      backend: SOFTWARE_BACKEND,
      reason: "webgl2-unavailable",
    });
    expect(parseBackendCache(formatBackendCache("gles", null), backends)).toEqual({
      backend: "gles",
      reason: null,
    });
  });

  it("reads the one-line cache earlier versions wrote", () => {
    expect(parseBackendCache("vulkan\n", backends)).toEqual({ backend: "vulkan", reason: null });
  });

  it("ignores a backend this ladder doesn't have, and an unknown reason", () => {
    expect(parseBackendCache("vulkan", angleBackends(true))).toEqual({ backend: null, reason: null });
    expect(parseBackendCache(`${SOFTWARE_BACKEND}\nbecause`, backends)).toEqual({
      backend: SOFTWARE_BACKEND,
      reason: null,
    });
    expect(parseBackendCache("", backends)).toEqual({ backend: null, reason: null });
  });
});

describe("backendState", () => {
  it("says what this launch uses and what the next one will", () => {
    expect(backendState("gl", { backend: SOFTWARE_BACKEND, reason: "gpu-crashes" })).toEqual({
      software: false,
      nextSoftware: true,
      reason: "gpu-crashes",
    });
    expect(backendState(SOFTWARE_BACKEND, { backend: null, reason: null })).toEqual({
      software: true,
      nextSoftware: false,
      reason: null,
    });
  });

  it("gives no reason for a graphics-card launch", () => {
    expect(backendState("gl", { backend: "gl", reason: "chosen" })).toEqual({
      software: false,
      nextSoftware: false,
      reason: null,
    });
  });
});
