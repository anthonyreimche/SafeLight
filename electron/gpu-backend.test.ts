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
  graphicsCardSwitches,
  backendChoices,
  launchBackend,
  AUTOMATIC,
  selectionOf,
  pickCache,
  revertTargetFor,
  revertCache,
  provenCache,
  CONFIRM_WITHIN_MS,
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
  // Compositing the window through SwiftShader too left it empty on Windows:
  // nothing it drew reached the screen. The window composites on the processor,
  // as in Chromium's own software mode, and WebGL is read back into it.
  it("opts in to SwiftShader WebGL on the software rung, composited on the processor", () => {
    expect(angleSwitches(SOFTWARE_BACKEND)).toEqual([
      ["use-gl", "angle"],
      ["use-angle", "swiftshader"],
      ["enable-unsafe-swiftshader"],
      ["disable-gpu-compositing"],
    ]);
  });
});

// Speed-ups for a graphics card. In software they only send the page's drawing
// through SwiftShader as well, and there is no card to pick.
describe("graphicsCardSwitches", () => {
  it("picks the faster card and draws the page on it on every hardware rung", () => {
    for (const backend of ["gl", "gles", "vulkan", "d3d11", "metal"]) {
      expect(graphicsCardSwitches(backend)).toEqual([
        ["force_high_performance_gpu"],
        ["enable-gpu-rasterization"],
        ["enable-zero-copy"],
      ]);
    }
  });

  it("adds nothing in software", () => {
    expect(graphicsCardSwitches(SOFTWARE_BACKEND)).toEqual([]);
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
      revertTo: null,
      reverted: null,
      keepBy: null,
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

// Preferences offers more than Automatic tries. On Windows each was checked in
// Safelight on an RTX 4070 Ti: Direct3D 11 on 12, OpenGL and WARP draw; Vulkan
// and Direct3D 9 give no WebGL2. Automatic keeps its own short ladder, so a
// machine that fails isn't walked through backends nobody asked for.
describe("backends the user can pick beyond Automatic's", () => {
  const ladder = gpuLadder("win32", false);
  const choices = backendChoices("win32", false);

  it("lists every backend that runs Safelight on Windows, software last", () => {
    expect(choices).toEqual(["d3d11", "d3d11on12", "gl", "d3d11-warp", SOFTWARE_BACKEND]);
    expect(ladder).toEqual(["d3d11", SOFTWARE_BACKEND]);
  });

  // Chromium's own backend menu on macOS offers OpenGL beside Metal. Linux's
  // ladder already holds every backend Chromium has there.
  it("offers OpenGL beside Metal on macOS, and Linux what Automatic tries", () => {
    expect(backendChoices("darwin", false)).toEqual(["metal", "gl", SOFTWARE_BACKEND]);
    expect(gpuLadder("darwin", false)).toEqual(["metal", SOFTWARE_BACKEND]);
    expect(angleSwitches("gl")).toEqual([["use-angle", "gl"], ["ignore-gpu-blocklist"]]);
    expect(backendChoices("linux", false)).toEqual(gpuLadder("linux", false));
    expect(backendChoices("linux", true)).toEqual(gpuLadder("linux", true));
  });

  it("selects each Windows pick with its own ANGLE backend", () => {
    expect(angleSwitches("d3d11on12")).toEqual([["use-angle", "d3d11on12"], ["ignore-gpu-blocklist"]]);
    expect(angleSwitches("d3d11-warp")).toEqual([["use-angle", "d3d11-warp"], ["ignore-gpu-blocklist"]]);
    expect(angleSwitches("gl")).toEqual([["use-angle", "gl"], ["ignore-gpu-blocklist"]]);
  });

  // WARP is Direct3D drawn on the processor: there is no card to pick or draw the page on.
  it("asks for no graphics-card speed-ups on WARP", () => {
    expect(graphicsCardSwitches("d3d11-warp")).toEqual([]);
    expect(graphicsCardSwitches("d3d11on12")).toHaveLength(3);
  });

  it("starts on a pick Automatic doesn't try, and remembers it", () => {
    const picked = parseBackendCache(formatBackendCache(chosenCache("d3d11-warp", 0)), choices);
    expect(picked).toMatchObject({ backend: "d3d11-warp", reason: "chosen" });
    expect(launchBackend(ladder, choices, picked, null, 0)).toBe("d3d11-warp");
    expect(readyCache("d3d11-warp", picked, 9)).toEqual(chosenCache("d3d11-warp", 9));
  });

  // A pick whose GPU process dies before a window opens is cleared, and the probe
  // relaunches on Automatic's first rung.
  it("lets a probe relaunch take the launch back to Automatic's ladder", () => {
    const picked = parseBackendCache(formatBackendCache(chosenCache("gl", 0)), choices);
    const failedRung = ladder.indexOf(launchBackend(ladder, choices, picked, null, 0));
    expect(failedRung).toBe(-1);
    expect(launchBackend(ladder, choices, picked, failedRung + 1, 0)).toBe("d3d11");
  });

  it("starts where Automatic would without a pick, or with one this platform doesn't offer", () => {
    const none = parseBackendCache("", choices);
    expect(launchBackend(ladder, choices, none, null, 0)).toBe("d3d11");
    const vulkan = parseBackendCache(formatBackendCache(chosenCache("vulkan", 0)), choices);
    expect(vulkan).toMatchObject({ backend: null, elsewhere: "vulkan" });
    expect(launchBackend(ladder, choices, vulkan, null, 0)).toBe("d3d11");
  });

  it("sends a pick whose renderer can't start back to Automatic's first rung", () => {
    expect(rendererFallbackFor(ladder, "gl")).toBe("d3d11");
    expect(rendererFallbackFor(ladder, "d3d11on12")).toBe("d3d11");
  });

  it("shows Preferences every pick and where the next launch starts", () => {
    const picked = chosenCache("d3d11on12", 0);
    expect(backendState("d3d11", picked, ladder, 0, undefined, choices)).toMatchObject({
      backend: "d3d11",
      next: "d3d11on12",
      choice: "d3d11on12",
      nextSoftware: false,
      backends: choices,
    });
  });
});

// A backend changed in Preferences is on trial until the user keeps it, from a
// bar in the window it draws. Failing before then (the graphics process dies at
// start, WebGL2 is lost, the renderer can't be built, crash recovery gives up),
// or not kept in time (a window that draws nothing reports no error), the next
// launch goes back to the selection that last worked, and says why.
describe("a change that doesn't work goes back to the last selection that did", () => {
  const ladder = gpuLadder("linux", false);
  const choices = backendChoices("linux", false);
  const automatic = parseBackendCache("", choices);
  const roundTrip = (cache: ReturnType<typeof pickCache>) => parseBackendCache(formatBackendCache(cache), choices);

  it("names a launch's selection: the pick, or Automatic", () => {
    expect(selectionOf(chosenCache("vulkan", 0))).toBe("vulkan");
    expect(selectionOf(fallbackCache("chosen", 0))).toBe(SOFTWARE_BACKEND);
    expect(selectionOf(automatic)).toBe(AUTOMATIC);
    expect(selectionOf({ ...automatic, backend: "gl" })).toBe(AUTOMATIC);
    expect(selectionOf(fallbackCache("gpu-crashes", 0))).toBe(AUTOMATIC);
  });

  it("keeps where a pick goes back to through the cache file", () => {
    const pick = pickCache("vulkan", AUTOMATIC, 0);
    expect(pick).toEqual({ ...chosenCache("vulkan", 0), revertTo: AUTOMATIC });
    expect(roundTrip(pick)).toEqual(pick);
    expect(launchBackend(ladder, choices, roundTrip(pick), null, 0)).toBe("vulkan");
    const software = pickCache(SOFTWARE_BACKEND, "gl", 5, "3.2.5");
    expect(roundTrip(software)).toEqual({ ...fallbackCache("chosen", 5, "3.2.5"), revertTo: "gl" });
  });

  it("puts Automatic on trial too, starting it on the ladder", () => {
    const auto = pickCache(AUTOMATIC, "gles", 0);
    expect(auto).toEqual({ backend: null, reason: null, since: null, launches: 0, revertTo: "gles" });
    expect(roundTrip(auto)).toEqual(auto);
    expect(launchBackend(ladder, choices, roundTrip(auto), null, 0)).toBe("gl");
  });

  it("writes Automatic with nothing to go back to as an empty cache", () => {
    expect(pickCache(AUTOMATIC, AUTOMATIC, 0)).toEqual(automatic);
    expect(parseBackendCache(formatBackendCache(pickCache(AUTOMATIC, undefined, 0)), choices)).toEqual(automatic);
  });

  it("isn't on trial when the pick is the selection it would go back to", () => {
    expect(pickCache("gl", "gl", 0)).toEqual(chosenCache("gl", 0));
  });

  // Earlier versions read the first lines only, so the trial adds lines after them.
  it("leaves the lines earlier versions read as they were", () => {
    const [first, second] = formatBackendCache(pickCache("gles", AUTOMATIC, 0)).split("\n");
    expect([first, second]).toEqual(["gles", "chosen"]);
    const software = formatBackendCache(pickCache(SOFTWARE_BACKEND, AUTOMATIC, 5, "3.2.5")).split("\n");
    expect(software.slice(0, 4)).toEqual([SOFTWARE_BACKEND, "chosen", "5 0", "3.2.5"]);
  });

  it("reads a selection to go back to that this session doesn't offer as Automatic", () => {
    const pick = parseBackendCache(formatBackendCache(pickCache("gl", "vulkan", 0)), gpuLadder("linux", true));
    expect(pick.revertTo).toBe(AUTOMATIC);
  });

  describe("what a change goes back to", () => {
    const proven = chosenCache("gl", 0);
    const trial = pickCache("vulkan", "gles", 0);

    it("is this launch's selection once it was kept, or when it was never on trial", () => {
      expect(revertTargetFor(proven, false, false)).toBe("gl");
      expect(revertTargetFor(automatic, false, false)).toBe(AUTOMATIC);
      expect(revertTargetFor(trial, true, false)).toBe("vulkan");
    });

    // Changing twice before a restart keeps the first selection that worked.
    it("is what this launch would go back to while it is still on trial", () => {
      expect(revertTargetFor(trial, false, false)).toBe("gles");
    });

    it("is never a selection that failed this session", () => {
      expect(revertTargetFor(trial, false, true)).toBe("gles");
      expect(revertTargetFor(proven, false, true)).toBe(AUTOMATIC);
    });
  });

  it("stays on trial when the launch reaches ready, which isn't drawing yet", () => {
    const pick = pickCache("vulkan", AUTOMATIC, 0);
    expect(readyCache("vulkan", pick, 9)).toEqual(pick);
    const auto = pickCache(AUTOMATIC, "gles", 0);
    expect(readyCache("gl", auto, 9)).toEqual({ backend: "gl", reason: null, since: null, launches: 0, revertTo: "gles" });
  });

  it("keeps the pick once the user keeps it", () => {
    expect(provenCache(pickCache("vulkan", AUTOMATIC, 0))).toEqual(chosenCache("vulkan", 0));
    expect(provenCache(chosenCache("gl", 0))).toEqual(chosenCache("gl", 0));
  });

  it("goes back to the selection that worked, naming the one that didn't", () => {
    const back = revertCache(pickCache("vulkan", "gl", 0), 7, "3.2.5");
    expect(back).toEqual({ ...chosenCache("gl", 7), reverted: { from: "vulkan", because: "failed" } });
    expect(roundTrip(back!)).toEqual(back);
    expect(launchBackend(ladder, choices, roundTrip(back!), null, 0)).toBe("gl");
    expect(revertCache(pickCache("gles", AUTOMATIC, 0), 7)).toEqual({
      ...automatic,
      reverted: { from: "gles", because: "failed" },
    });
    expect(revertCache(pickCache(AUTOMATIC, SOFTWARE_BACKEND, 0), 7, "3.2.5")).toEqual({
      ...fallbackCache("chosen", 7, "3.2.5"),
      reverted: { from: AUTOMATIC, because: "failed" },
    });
  });

  // No error comes from a window that opens but draws nothing; nobody can see
  // its Keep to press it, so the change goes back once the time is up.
  it("goes back from a change nobody kept, and says so", () => {
    expect(CONFIRM_WITHIN_MS).toBe(20_000);
    const back = revertCache(pickCache("vulkan", "gl", 0), 7, "3.2.5", "unkept");
    expect(back).toEqual({ ...chosenCache("gl", 7), reverted: { from: "vulkan", because: "unkept" } });
    expect(roundTrip(back!)).toEqual(back);
  });

  // The user pressed Go back: they know why, so nothing is named.
  it("goes back without a word when the user asks to", () => {
    expect(revertCache(pickCache("vulkan", "gl", 0), 7, "3.2.5", null)).toEqual(chosenCache("gl", 7));
  });

  it("has nothing to go back to off trial", () => {
    expect(revertCache(chosenCache("vulkan", 0), 7)).toBeNull();
    expect(revertCache(automatic, 7)).toBeNull();
  });

  // The launch after going back says why once; its ready cache drops the note.
  it("names the failed selection for one launch", () => {
    const back = revertCache(pickCache("vulkan", "gl", 0), 7)!;
    expect(readyCache("gl", back, 9)).toEqual(chosenCache("gl", 0));
  });

  it("ignores a reason it doesn't know, and a selection that isn't one", () => {
    expect(parseBackendCache("gl\nchosen\n\n\nreverted-from vulkan sideways\n", choices).reverted).toEqual({
      from: "vulkan",
      because: "failed",
    });
    expect(parseBackendCache("gl\nchosen\n\n\nreverted-from nonsense\n", choices).reverted).toBeUndefined();
  });

  it("tells Preferences what a pick goes back to, what this launch went back from, and when to keep it by", () => {
    expect(backendState("gl", pickCache("vulkan", AUTOMATIC, 0), ladder, 0, undefined, choices)).toMatchObject({
      choice: "vulkan",
      revertTo: AUTOMATIC,
      reverted: null,
      keepBy: null,
    });
    const reverted = { from: "vulkan", because: "unkept" };
    expect(backendState("gl", chosenCache("gl", 0), ladder, 0, undefined, choices, { reverted })).toMatchObject({
      choice: "gl",
      revertTo: null,
      reverted,
      keepBy: null,
    });
    expect(backendState("vulkan", pickCache("vulkan", "gl", 0), ladder, 0, undefined, choices, { keepBy: 25_000 })).toMatchObject({
      revertTo: "gl",
      keepBy: 25_000,
    });
  });
});
