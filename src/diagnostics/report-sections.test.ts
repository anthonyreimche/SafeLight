// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { DEFAULT_SETTINGS } from "@/state/settings-store";
import {
  changedSettings,
  contextText,
  crashText,
  environmentText,
  errorsText,
  extensionsText,
  graphicsText,
  photoFacts,
  type ContextFacts,
  type EnvironmentFacts,
} from "./report-sections";

const env: EnvironmentFacts = {
  appVersion: "3.0.1",
  electron: "42.4.0",
  chrome: "142.0.7444.59",
  platform: "win32",
  arch: "x64",
  osVersion: "10.0.26300",
  userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/142",
  language: "en-GB",
  threads: 16,
  screen: { width: 2560, height: 1440, dpr: 1.5 },
  viewport: { width: 1707, height: 960 },
  crossOriginIsolated: true,
  window: "main",
};

describe("environmentText", () => {
  it("describes the Electron build", () => {
    expect(environmentText(env)).toBe(
      [
        "Safelight 3.0.1",
        "Electron 42.4.0 · Chromium 142.0.7444.59",
        "Windows 10.0.26300 · x64",
        "Language en-GB · 16 CPU threads",
        "Screen 2560×1440 at 1.5× · window 1707×960",
        "Cross-origin isolated: yes",
        "Window: main",
      ].join("\n"),
    );
  });

  it("describes the browser build with its user agent", () => {
    const text = environmentText({ ...env, electron: null, chrome: null, arch: null, osVersion: null, platform: "Win32" });
    expect(text.split("\n").slice(0, 2)).toEqual([
      "Safelight 3.0.1 (browser build)",
      "Mozilla/5.0 (Windows NT 10.0) Chrome/142",
    ]);
  });
});

describe("graphicsText", () => {
  const webgl = { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA GeForce RTX 3070)", glsl: "WebGL GLSL ES 3.00", maxTexture: 16384 };

  it("lists only the GPU features that are off", () => {
    const text = graphicsText({
      webgl,
      gpuFeatures: { gpu_compositing: "enabled", rasterization: "disabled_software", video_encode: "disabled_off_ok" },
      displayProfile: null,
    });
    expect(text).toBe(
      [
        "ANGLE (NVIDIA GeForce RTX 3070)",
        "Vendor: Google Inc. (NVIDIA)",
        "WebGL GLSL ES 3.00 · max texture 16384",
        "GPU features off: rasterization (disabled_software)",
      ].join("\n"),
    );
  });

  it("says when every feature is on and when WebGL is missing", () => {
    expect(graphicsText({ webgl, gpuFeatures: { a: "enabled_on" }, displayProfile: "active" })).toContain(
      "GPU features: all enabled\nDisplay profile: active",
    );
    expect(graphicsText({ webgl: null, gpuFeatures: null, displayProfile: null })).toBe("WebGL unavailable");
  });
});

describe("extensionsText", () => {
  it("lists installed and dev extensions, built-in changes and blocked ones", () => {
    const text = extensionsText({
      rows: [
        { id: "acme.film", version: "1.2.0", source: "installed", enabled: true, running: true, trust: "verified", rendersPixels: true },
        { id: "bob.tool", version: "0.3.1", source: "installed", enabled: true, running: false, trust: "unverified", rendersPixels: false },
        {
          id: "carol.x", version: "2.0.0", source: "installed", enabled: false, running: false, trust: "stale", rendersPixels: false,
          problem: "Version 2.1.0 didn't start on this build; 2.0.0 was restored.",
        },
        { id: "me.wip", version: "0.0.1", source: "dev", enabled: true, running: false, trust: null, rendersPixels: false, problem: "error: Unexpected token" },
      ],
      builtinChanges: [{ id: "core.devtools", enabled: true }],
      blocked: [{ id: "evil.ext", reason: "Steals files" }],
    });
    expect(text).toBe(
      [
        "Installed:",
        "- acme.film 1.2.0 · on · verified · renders into photos",
        "- bob.tool 0.3.1 · on, not running · unverified",
        "- carol.x 2.0.0 · off · verified, this version not reviewed yet",
        "  Version 2.1.0 didn't start on this build; 2.0.0 was restored.",
        "Dev folder:",
        "- me.wip 0.0.1 · on, not running",
        "  error: Unexpected token",
        "Built-in changes:",
        "- core.devtools · on (off by default)",
        "Blocked:",
        "- evil.ext: Steals files",
      ].join("\n"),
    );
  });

  it("says when nothing is installed or changed", () => {
    expect(extensionsText({ rows: [], builtinChanges: [], blocked: [] })).toBe(
      "No extensions installed; built-ins at their defaults.",
    );
  });
});

const photo: CatalogPhoto = {
  id: "p1",
  filename: "SECRET_NAME_123.NEF",
  relPath: "SecretTrip/SECRET_NAME_123.NEF",
  folder: "SecretTrip",
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 6048,
  height: 4024,
  fileSize: 1,
  mimeType: "image/x-nikon-nef",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: ["SecretKeyword"],
  dateCreated: 0,
  dateImported: 0,
  exif: {
    cameraMake: "NIKON CORPORATION",
    cameraModel: "NIKON Z 6",
    lens: "NIKKOR Z 24-70mm f/4 S",
    bodySerial: "SERIAL-BODY-9",
    lensSerial: "SERIAL-LENS-9",
    artist: "Secret Artist",
    copyright: "Secret Copyright",
    imageDescription: "Secret description",
    dateTimeOriginal: "2026:01:02 03:04:05",
    gpsLatitude: 51.123456,
    gpsLongitude: -0.654321,
  },
};

describe("photoFacts and contextText", () => {
  const context = (over: Partial<ContextFacts> = {}): ContextFacts => ({
    module: "Develop",
    theme: "core.neutral",
    layout: "core.classic",
    folderOpen: true,
    photoCount: 1234,
    photo: photoFacts(photo),
    edit: { processVersion: 1, currentProcessVersion: 2, pipeline: "core.agx", ownPipeline: true },
    changedSettings: [],
    ...over,
  });

  it("never carries names, places, serials or dates", () => {
    const text = contextText(context());
    for (const secret of ["SECRET_NAME", "SecretTrip", "SecretKeyword", "SERIAL", "Secret Artist", "Secret Copyright", "Secret description", "2026:01:02", "51.12", "0.65"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("describes the photo, the edit and the app state", () => {
    expect(contextText(context({ changedSettings: ["developMaxEdge 8192"] }))).toBe(
      [
        "Module: Develop",
        "Theme: core.neutral · Layout: core.classic",
        "Catalog: 1,234 photos",
        "Photo: .nef · image/x-nikon-nef · 6048×4024",
        "Camera: NIKON Z 6 · Lens: NIKKOR Z 24-70mm f/4 S",
        "Processing: version 1 (current 2) · display transform core.agx (photo's own)",
        "Settings changed: developMaxEdge 8192",
      ].join("\n"),
    );
  });

  it("notes decode problems, virtual copies and pending metadata", () => {
    const facts = photoFacts({ ...photo, copyOf: "p0", metadataPending: true, decodeError: "Couldn't read it" });
    const text = contextText(context({ photo: facts, edit: null }));
    expect(text).toContain("Photo: .nef · image/x-nikon-nef · 6048×4024 · virtual copy · metadata still loading");
    expect(text).toContain("Decode problem: Couldn't read it");
  });

  it("says when no folder is open", () => {
    expect(contextText(context({ folderOpen: false, photo: null, edit: null, photoCount: 0 }))).toContain("No folder open");
  });
});

describe("changedSettings", () => {
  it("reports allowlisted settings that differ from the default", () => {
    const s = {
      ...DEFAULT_SETTINGS,
      developMaxEdge: 8192 as const,
      highBitDepth: false,
      gpuSourceCacheBytes: 1024 * 1024 * 1024,
      externalCatalogDir: "C:\\Users\\ann\\Catalogs",
      displayProfilePath: "/home/ann/monitor.icc",
    };
    expect(changedSettings(s, DEFAULT_SETTINGS)).toEqual([
      "developMaxEdge 8192",
      "gpuSourceCacheBytes 1024 MB",
      "highBitDepth off",
    ]);
  });
});

describe("errorsText", () => {
  it("writes one block per entry without blank lines inside", () => {
    const at = new Date(2026, 9, 21, 14, 2, 11).getTime();
    const text = errorsText([
      { id: "a", level: "error", message: "[render-worker] lost\n\ncontext", stack: "    at f (a.js:1:2)", time: at, count: 3, source: "develop" },
      { id: "b", level: "crash", message: "GPU process gone: crashed (exit 1)", time: at, count: 1, source: "native" },
    ]);
    expect(text).toBe(
      [
        "2026-10-21 14:02:11 · develop · error ×3",
        "[render-worker] lost",
        "context",
        "    at f (a.js:1:2)",
        "",
        "2026-10-21 14:02:11 · native · crash",
        "GPU process gone: crashed (exit 1)",
      ].join("\n"),
    );
  });

  it("says when the log is empty", () => {
    expect(errorsText([])).toBe("No warnings or errors recorded.");
  });
});

describe("crashText", () => {
  it("writes the crash, its stack and the component stack", () => {
    expect(
      crashText({ what: 'Panel "core.histogram"', message: "boom", stack: "    at H (a.js:1:2)", componentStack: "\n    at Histogram\n    at Panel" }),
    ).toBe(['Panel "core.histogram" crashed: boom', "    at H (a.js:1:2)", "Component stack:", "    at Histogram", "    at Panel"].join("\n"));
  });
});
