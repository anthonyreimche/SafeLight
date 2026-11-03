// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The ANGLE backend ladder (gpu-backend.cjs). Chromium no longer falls back to
// software WebGL on its own, so a guest without usable 3D (VirtualBox, reported
// on MX Linux) needs SwiftShader as an explicit last rung, and a session that
// proves the hardware path unusable moves the next launch onto it.

import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SOFTWARE_BACKEND,
  RETRY_AFTER_LAUNCHES,
  RETRY_AFTER_MS,
  angleBackends,
  gpuLadder,
  angleSwitches,
  webgl2Lost,
  softwareFallbackFor,
  rendererFallbackFor,
  parseBackendCache,
  formatBackendCache,
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
} from "./gpu-backend.cjs";

describe("angleBackends", () => {
  it("ends both ladders on software rendering", () => {
    expect(angleBackends(false)).toEqual(["gl", "gles", "vulkan", SOFTWARE_BACKEND]);
    expect(angleBackends(true)).toEqual(["gl", "gles", SOFTWARE_BACKEND]);
  });
});

// Windows and macOS guests (Hyper-V, VMware, Parallels, UTM) can lack usable
// 3D too, so every platform ends its ladder on the same software rung.
describe("gpuLadder", () => {
  it("gives each platform its hardware backend, then software", () => {
    expect(gpuLadder("win32", false)).toEqual(["d3d11", SOFTWARE_BACKEND]);
    expect(gpuLadder("darwin", false)).toEqual(["metal", SOFTWARE_BACKEND]);
    expect(gpuLadder("linux", false)).toEqual(angleBackends(false));
    expect(gpuLadder("linux", true)).toEqual(angleBackends(true));
  });
});

describe("angleSwitches", () => {
  // The blocklist would otherwise quietly drop a listed driver to software
  // compositing, much slower than the card it could have used.
  it("names the hardware backend and ignores the GPU blocklist", () => {
    expect(angleSwitches("gles")).toEqual([["use-angle", "gles"], ["ignore-gpu-blocklist"]]);
    expect(angleSwitches("d3d11")).toEqual([["use-angle", "d3d11"], ["ignore-gpu-blocklist"]]);
  });

  it("leaves macOS on Chromium's own Metal backend", () => {
    expect(angleSwitches("metal")).toEqual([["ignore-gpu-blocklist"]]);
  });

  // The pair Chromium needs since it stopped falling back to SwiftShader for
  // WebGL by itself; the SwiftShader WebGL test run uses the same switches.
  // A software launch doesn't force a blocklisted driver back into play.
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

  // Chromium 148 reports no webgl2 entry at all. This is the status from the
  // MX Linux VirtualBox guest (#180) after its GPU process gave up.
  it("reads WebGL off as WebGL2 lost when there is no webgl2 entry", () => {
    expect(
      webgl2Lost({
        "2d_canvas": "disabled_software",
        gpu_compositing: "disabled_software",
        opengl: "disabled_off",
        rasterization: "disabled_software",
        webgl: "disabled_off",
        webgpu: "disabled_off",
      }),
    ).toBe(true);
    expect(webgl2Lost({ webgl: "enabled", gpu_compositing: "enabled" })).toBe(false);
  });

  it("is true when either WebGL entry is off", () => {
    expect(webgl2Lost({ webgl: "enabled", webgl2: "unavailable_off" })).toBe(true);
    expect(webgl2Lost({ webgl: "unavailable_off", webgl2: "enabled" })).toBe(true);
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

// A renderer that can't start on one hardware backend may on the next, so it
// steps down the ladder one rung rather than jumping to software.
describe("rendererFallbackFor", () => {
  it("steps to the next rung on the ladder", () => {
    const ladder = gpuLadder("linux", false);
    expect(rendererFallbackFor(ladder, "gl")).toBe("gles");
    expect(rendererFallbackFor(ladder, "gles")).toBe("vulkan");
    expect(rendererFallbackFor(ladder, "vulkan")).toBe(SOFTWARE_BACKEND);
    expect(rendererFallbackFor(gpuLadder("linux", true), "gles")).toBe(SOFTWARE_BACKEND);
  });

  it("goes straight to software where the ladder has one hardware rung", () => {
    expect(rendererFallbackFor(gpuLadder("win32", false), "d3d11")).toBe(SOFTWARE_BACKEND);
    expect(rendererFallbackFor(gpuLadder("darwin", false), "metal")).toBe(SOFTWARE_BACKEND);
  });

  it("has nowhere to go from software", () => {
    expect(rendererFallbackFor(gpuLadder("linux", false), SOFTWARE_BACKEND)).toBeNull();
  });
});

// Retrying the first rung on a timer would fail the same way and ask for
// another restart, so a renderer failure holds until the app changes.
describe("software after a renderer failure", () => {
  const failed = fallbackCache("renderer-failed", 0, "3.1.0");

  it("remembers the app version through the cache file, and still reads files without one", () => {
    expect(failed.version).toBe("3.1.0");
    expect(parseBackendCache(formatBackendCache(failed), angleBackends(false))).toEqual(failed);
    expect(parseBackendCache(`${SOFTWARE_BACKEND}\nrenderer-failed\n5 0\n`, angleBackends(false)).version).toBeUndefined();
  });

  it("is not retried while the app version is the same, however long it has run", () => {
    const old = { ...failed, launches: 1000 };
    expect(retriesHardware(old, RETRY_AFTER_MS * 10, "3.1.0")).toBe(false);
    expect(startRung(gpuLadder("linux", false), old, null, RETRY_AFTER_MS * 10, "3.1.0")).toBe(3);
  });

  it("is retried once the app version changes, or when no version was stored", () => {
    expect(retriesHardware({ ...failed, launches: RETRY_AFTER_LAUNCHES }, 1, "3.2.0")).toBe(true);
    expect(retriesHardware({ ...failed, version: undefined, launches: RETRY_AFTER_LAUNCHES }, 1, "3.1.0")).toBe(true);
  });
});

// The cache holds the backend the next launch starts on, and for software
// why it is there, so Preferences can say whether Safelight or the user chose it.
describe("the backend cache", () => {
  const backends = angleBackends(false);
  const none = { backend: null, reason: null, since: null, launches: 0 };

  it("round-trips a backend, why software was picked, and since when", () => {
    const software = { backend: SOFTWARE_BACKEND, reason: "webgl2-unavailable", since: 1000, launches: 3 };
    expect(formatBackendCache(software)).toBe(`${SOFTWARE_BACKEND}\nwebgl2-unavailable\n1000 3\n`);
    expect(parseBackendCache(formatBackendCache(software), backends)).toEqual(software);
    const hardware = { backend: "gles", reason: null, since: null, launches: 0 };
    expect(formatBackendCache(hardware)).toBe("gles\n");
    expect(parseBackendCache(formatBackendCache(hardware), backends)).toEqual(hardware);
  });

  it("keeps a renderer that couldn't start as the reason", () => {
    const software = { backend: SOFTWARE_BACKEND, reason: "renderer-failed", since: 5, launches: 0 };
    expect(parseBackendCache(formatBackendCache(software), backends)).toEqual(software);
  });

  it("reads the caches earlier versions wrote", () => {
    expect(parseBackendCache("vulkan\n", backends)).toEqual({ ...none, backend: "vulkan" });
    expect(parseBackendCache(`${SOFTWARE_BACKEND}\ngpu-crashes\n`, backends)).toEqual({
      ...none,
      backend: SOFTWARE_BACKEND,
      reason: "gpu-crashes",
    });
  });

  it("ignores a backend this ladder doesn't have, an unknown reason, and a bad count", () => {
    expect(parseBackendCache("vulkan", angleBackends(true))).toEqual(none);
    expect(parseBackendCache(`${SOFTWARE_BACKEND}\nbecause\nsoon`, backends)).toEqual({
      ...none,
      backend: SOFTWARE_BACKEND,
    });
    expect(parseBackendCache("", backends)).toEqual(none);
  });
});

describe("backendCacheFiles", () => {
  const userData = "/home/ann/.config/Safelight";

  it("keeps the cache in userData, and reads the old Linux file to migrate it", () => {
    expect(backendCacheFiles(userData, "linux", { HOME: "/home/ann" })).toEqual({
      file: posix.join(userData, "gpu-backend"),
      legacy: posix.join("/home/ann", ".config", "safelight", "gpu-backend"),
    });
    expect(backendCacheFiles(userData, "linux", { XDG_CONFIG_HOME: "/xdg", HOME: "/home/ann" }).legacy).toBe(
      posix.join("/xdg", "safelight", "gpu-backend"),
    );
  });

  it("has no old file off Linux", () => {
    const appData = "C:\\Users\\ann\\AppData\\Roaming\\Safelight";
    expect(backendCacheFiles(appData, "win32", { HOME: "/home/ann" })).toEqual({
      file: win32.join(appData, "gpu-backend"),
      legacy: null,
    });
    expect(backendCacheFiles("/Users/ann/Library/Application Support/Safelight", "darwin", {}).file).toBe(
      "/Users/ann/Library/Application Support/Safelight/gpu-backend",
    );
  });

  // A development run's userData is the old folder itself.
  it("doesn't migrate a file onto itself", () => {
    const same = posix.join("/home/ann", ".config", "safelight");
    expect(backendCacheFiles(same, "linux", { HOME: "/home/ann" }).legacy).toBeNull();
  });

  it("never names a relative path", () => {
    expect(backendCacheFiles(null, "linux", {})).toEqual({ file: null, legacy: null });
    expect(backendCacheFiles("rel", "linux", { HOME: "" })).toEqual({ file: null, legacy: null });
    expect(backendCacheFiles(null, "linux", { XDG_CONFIG_HOME: "cfg", HOME: "home" })).toEqual({
      file: null,
      legacy: null,
    });
    expect(backendCacheFiles(null, "linux", { HOME: "/home/ann" }).file).toBe(
      posix.join("/home/ann", ".config", "safelight", "gpu-backend"),
    );
  });
});

// Software Safelight picked for itself is retried on the graphics card now
// and then, so one bad session doesn't keep a machine in software for good.
describe("retrying the graphics card", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const auto = { backend: SOFTWARE_BACKEND, reason: "webgl2-unavailable", since: 0, launches: 0 };

  it("retries once enough launches or days have passed", () => {
    expect(retriesHardware(auto, DAY)).toBe(false);
    expect(retriesHardware({ ...auto, launches: RETRY_AFTER_LAUNCHES }, DAY)).toBe(true);
    expect(retriesHardware(auto, RETRY_AFTER_MS)).toBe(true);
    expect(RETRY_AFTER_MS).toBe(7 * DAY);
  });

  it("retries the software an earlier version cached with no date", () => {
    expect(retriesHardware({ ...auto, since: null }, 0)).toBe(true);
    expect(retriesHardware({ ...auto, reason: null, since: null }, 0)).toBe(true);
  });

  it("never retries software the user turned on, nor a hardware cache", () => {
    const chosen = { ...auto, reason: "chosen", launches: 1000 };
    expect(retriesHardware(chosen, 1000 * DAY)).toBe(false);
    expect(retriesHardware({ ...chosen, since: null }, 0)).toBe(false);
    expect(retriesHardware({ backend: "gl", reason: null, since: null, launches: 0 }, 1000 * DAY)).toBe(false);
  });

  it("starts on the cached rung, a probe relaunch's rung, or the first", () => {
    const ladder = gpuLadder("linux", false);
    const none = { backend: null, reason: null, since: null, launches: 0 };
    expect(startRung(ladder, none, null, 0)).toBe(0);
    expect(startRung(ladder, { ...none, backend: "vulkan" }, null, 0)).toBe(2);
    expect(startRung(ladder, auto, null, DAY)).toBe(3);
    expect(startRung(ladder, auto, null, RETRY_AFTER_MS)).toBe(0);
    expect(startRung(ladder, auto, 1, DAY)).toBe(1);
    expect(startRung(ladder, none, 99, 0)).toBe(3);
    expect(startRung(ladder, none, -1, 0)).toBe(0);
  });

  it("counts software launches toward the retry, from when software began", () => {
    expect(readyCache(SOFTWARE_BACKEND, { ...auto, since: 5, launches: 2 }, 9)).toEqual({
      ...auto,
      since: 5,
      launches: 3,
    });
    expect(readyCache(SOFTWARE_BACKEND, { ...auto, since: null }, 9)).toEqual({ ...auto, since: 9, launches: 1 });
  });

  // The probe relaunches past each rung whose GPU process died at startup. On
  // a two-rung ladder that can be one passing crash, so the retry comes soon.
  it("records a probe that ended on software as GPU crashes, due a retry soon", () => {
    const none = { backend: null, reason: null, since: null, launches: 0 };
    const probed = readyCache(SOFTWARE_BACKEND, none, 9);
    expect(probed).toEqual({
      backend: SOFTWARE_BACKEND,
      reason: "gpu-crashes",
      since: 9,
      launches: RETRY_AFTER_LAUNCHES - 1,
    });
    expect(retriesHardware(probed, 10)).toBe(false);
    expect(retriesHardware(readyCache(SOFTWARE_BACKEND, probed, 10), 11)).toBe(true);
  });

  it("caches a hardware rung that reached ready, retry or not", () => {
    expect(readyCache("gl", auto, RETRY_AFTER_MS)).toEqual({ backend: "gl", reason: null, since: null, launches: 0 });
  });

  it("starts a fresh retry clock on each fallback", () => {
    expect(fallbackCache("gpu-crashes", 42)).toEqual({
      backend: SOFTWARE_BACKEND,
      reason: "gpu-crashes",
      since: 42,
      launches: 0,
    });
  });
});

describe("probe relaunch arguments", () => {
  const argv = ["/opt/Safelight/safelight", "--no-sandbox", "--safelight-angle-idx=1"];

  it("reads the rung a probe relaunch asked for", () => {
    expect(relaunchRung(argv)).toBe(1);
    expect(relaunchRung(argv.slice(0, 2))).toBeNull();
    expect(relaunchRung(["exe", "--safelight-angle-idx=x"])).toBeNull();
  });

  // A restart must read the cache again, not pin the rung an earlier probe chose.
  it("replaces or drops the rung on relaunch", () => {
    expect(relaunchArgs(argv, 2)).toEqual(["--no-sandbox", "--safelight-angle-idx=2"]);
    expect(relaunchArgs(argv)).toEqual(["--no-sandbox"]);
  });

  // An AppImage's own executable sits in a mount that is gone once it exits.
  it("relaunches an AppImage through the file the user started, not its mount", () => {
    expect(relaunchOptions(argv, { APPIMAGE: "/home/a/Safelight.AppImage" }, 2)).toEqual({
      args: ["--no-sandbox", "--safelight-angle-idx=2"],
      execPath: "/home/a/Safelight.AppImage",
    });
    expect(relaunchOptions(argv, {})).toEqual({ args: ["--no-sandbox"] });
  });
});

describe("backendState", () => {
  const ladder = gpuLadder("linux", false);
  const none = { backend: null, reason: null, since: null, launches: 0 };

  it("says what this launch uses and what the next one will", () => {
    expect(backendState("gl", { ...none, backend: SOFTWARE_BACKEND, reason: "gpu-crashes", since: 0 }, ladder, 0)).toEqual({
      software: false,
      nextSoftware: true,
      reason: "gpu-crashes",
      backend: "gl",
      next: SOFTWARE_BACKEND,
      choice: null,
      backends: ladder,
    });
    expect(backendState(SOFTWARE_BACKEND, none, ladder, 0)).toMatchObject({
      software: true,
      nextSoftware: false,
      reason: null,
      next: "gl",
      choice: null,
    });
  });

  it("gives no software reason for a graphics-card pick, but names the pick", () => {
    expect(backendState("gl", { ...none, backend: "vulkan", reason: "chosen" }, ladder, 0)).toMatchObject({
      software: false,
      nextSoftware: false,
      reason: null,
      next: "vulkan",
      choice: "vulkan",
    });
  });

  it("names software the user picked as the pick", () => {
    expect(backendState("gl", fallbackCache("chosen", 0), ladder, 0)).toMatchObject({
      nextSoftware: true,
      reason: "chosen",
      next: SOFTWARE_BACKEND,
      choice: SOFTWARE_BACKEND,
    });
  });

  // Software Safelight picked for itself and now due a retry starts the next
  // launch on the graphics card, whatever the cache's first line says.
  it("reports where the next launch really starts", () => {
    const due = { backend: SOFTWARE_BACKEND, reason: "webgl2-unavailable", since: 0, launches: RETRY_AFTER_LAUNCHES };
    expect(backendState(SOFTWARE_BACKEND, due, ladder, 0).next).toBe("gl");
  });
});

// Preferences ▸ Rendering ▸ Graphics backend: Automatic probes the ladder; any
// other entry pins that backend for every later launch until the user changes
// it or it fails.
describe("a backend the user picked", () => {
  const ladder = gpuLadder("linux", false);

  it("caches a graphics-card pick with no software clock", () => {
    expect(chosenCache("gles", 7)).toEqual({ backend: "gles", reason: "chosen", since: null, launches: 0 });
    expect(parseBackendCache(formatBackendCache(chosenCache("gles", 7)), ladder)).toEqual(chosenCache("gles", 7));
  });

  it("caches software as the software the user turned on", () => {
    expect(chosenCache(SOFTWARE_BACKEND, 7, "3.2.0")).toEqual(fallbackCache("chosen", 7, "3.2.0"));
  });

  it("starts every later launch on the pick and never retries away from it", () => {
    const pick = chosenCache("vulkan", 0);
    expect(startRung(ladder, pick, null, 1000 * RETRY_AFTER_MS)).toBe(2);
    expect(retriesHardware(pick, 1000 * RETRY_AFTER_MS)).toBe(false);
  });

  it("stays picked once a launch on it reaches ready", () => {
    expect(readyCache("vulkan", chosenCache("vulkan", 0), 9)).toEqual(chosenCache("vulkan", 0));
  });

  // Vulkan isn't offered under Wayland. A pick made in an X11 session is kept
  // for the next X11 session rather than started on, or written over, here.
  it("is remembered, not started on, in a session type that doesn't offer it", () => {
    const wayland = gpuLadder("linux", true);
    const cache = parseBackendCache(formatBackendCache(chosenCache("vulkan", 0)), wayland);
    expect(cache).toMatchObject({ backend: null, reason: null, elsewhere: "vulkan" });
    expect(startRung(wayland, cache, null, 0)).toBe(0);
    expect(backendState("gl", cache, wayland, 0)).toMatchObject({ choice: null, next: "gl" });
  });

  it("isn't remembered when Safelight, not the user, put the backend there", () => {
    const cache = parseBackendCache("vulkan\n", gpuLadder("linux", true));
    expect(cache).toEqual({ backend: null, reason: null, since: null, launches: 0 });
  });

  it("is dropped when the launch ended up on another backend", () => {
    expect(readyCache("gl", chosenCache("vulkan", 0), 9)).toEqual({ backend: "gl", reason: null, since: null, launches: 0 });
  });
});
