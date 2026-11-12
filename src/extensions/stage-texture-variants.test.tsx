// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.setStageTexture's `variant`: data filed under the texture's key and the
// variant's name, owned like the plain texture. In the dom project, as
// registry.test.tsx is, for the stores the registry's import graph reaches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProcessingStage, unregisterExtension } from "./registry";
import { getStageTextures, setStageTexture } from "@/rendering/render-bridge";
import { forgetExtension } from "./extension-kinds";
import { makeScopedAPI } from "./host";
import type { ProcessingStageContribution, StageTextureData } from "./types";

describe("setStageTexture: variants", () => {
  const tex: StageTextureData = { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, format: "rgba8", version: 1 };
  const stage: ProcessingStageContribution = {
    id: "acme.calib",
    name: "Calibration",
    phase: "decode",
    glsl: "",
    uniforms: [],
    textures: [{ key: "table", kind: "dynamic", format: "rgba8" }],
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerProcessingStage("acme", stage);
  });
  afterEach(() => {
    for (const key of Object.keys(getStageTextures())) setStageTexture(key, null);
    vi.restoreAllMocks();
    unregisterExtension("acme");
    unregisterExtension("other");
    forgetExtension("acme");
    forgetExtension("other");
  });

  it("files each variant apart from the plain texture and the others", () => {
    const api = makeScopedAPI("acme");
    const second = { ...tex, version: 2 };
    api.setStageTexture("acme.calib", "table", tex, "a1");
    api.setStageTexture("acme.calib", "table", second, "b-2");
    expect(getStageTextures()["acme.calib.table#a1"]).toBe(tex);
    expect(getStageTextures()["acme.calib.table#b-2"]).toBe(second);
    expect(getStageTextures()["acme.calib.table"]).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("clears one variant by name and keeps the rest", () => {
    const api = makeScopedAPI("acme");
    api.setStageTexture("acme.calib", "table", tex, "a1");
    api.setStageTexture("acme.calib", "table", tex, "b2");
    api.setStageTexture("acme.calib", "table", null, "a1");
    expect(Object.keys(getStageTextures())).toEqual(["acme.calib.table#b2"]);
  });

  it("refuses a variant name that isn't letters, digits, - or _, and says so", () => {
    makeScopedAPI("acme").setStageTexture("acme.calib", "table", tex, "a.b");
    expect(Object.keys(getStageTextures())).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/variant "a\.b".*setStageTexture ignored/));
  });

  it("refuses another extension's write to a variant", () => {
    makeScopedAPI("other").setStageTexture("acme.calib", "table", tex, "a1");
    expect(getStageTextures()["acme.calib.table#a1"]).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("drops the variants with the extension", () => {
    makeScopedAPI("acme").setStageTexture("acme.calib", "table", tex, "a1");
    unregisterExtension("acme");
    expect(getStageTextures()["acme.calib.table#a1"]).toBeUndefined();
  });
});
