// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage texture of one photo's own (TextureRequirement.perPhoto): every frame
// of a photo names the variant filed under the photo's id, so a thumbnail or an
// export draws that photo's data, never the open photo's (SafeLight #278).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { registerPipeline, registerProcessingStage, unregisterExtension } from "@/extensions/registry";
import type { ProcessingStageContribution } from "@/extensions/types";
import { checkStageContract } from "@/extensions/stage-validation";
import { frameStageBag } from "./stage-bag";

const PHOTO = "3f2b6c1e-8d4a-4f5b-9c0e-1a2b3c4d5e6f";

const FIELD: ProcessingStageContribution = {
  id: "acme.field",
  name: "Field",
  phase: "scene-linear",
  glsl: "",
  uniforms: [],
  textures: [
    { key: "field", kind: "dynamic", format: "rgba16f", perPhoto: true },
    { key: "shared", kind: "lut", format: "rgba8" },
  ],
};

beforeEach(() => registerProcessingStage("acme", FIELD));
afterEach(() => unregisterExtension("acme"));

describe("frameStageBag", () => {
  it("names the photo's own variant of a per-photo texture", () => {
    const bag = frameStageBag(DEFAULT_DEVELOP_PARAMS, {}, PHOTO);
    expect(bag["acme.field.field"]).toBe(PHOTO);
    expect(bag).not.toHaveProperty("acme.field.shared");
  });

  it("leaves a variant the photo's bag names as it is", () => {
    expect(frameStageBag(DEFAULT_DEVELOP_PARAMS, { "acme.field.field": "mine" }, PHOTO)["acme.field.field"]).toBe("mine");
  });

  // A photo with another transform never draws the stage, so it must not wait
  // on its provider either.
  it("names none for a stage that belongs to another transform", () => {
    registerPipeline("acme", { id: "acme.look", name: "Look" });
    registerProcessingStage("acme", { ...FIELD, id: "acme.match", transform: "acme.look" });
    expect(frameStageBag(DEFAULT_DEVELOP_PARAMS, {}, PHOTO)).not.toHaveProperty("acme.match.field");
    const withLook = { ...DEFAULT_DEVELOP_PARAMS, displayTransform: "acme.look" };
    expect(frameStageBag(withLook, {}, PHOTO)["acme.match.field"]).toBe(PHOTO);
  });

  it("names none without a photo, or for an id that isn't a variant name", () => {
    expect(frameStageBag(DEFAULT_DEVELOP_PARAMS, {})).not.toHaveProperty("acme.field.field");
    expect(frameStageBag(DEFAULT_DEVELOP_PARAMS, {}, "a/b")).not.toHaveProperty("acme.field.field");
  });
});

describe("a per-photo texture's contract", () => {
  const withTexture = (t: Record<string, unknown>) =>
    ({ ...FIELD, textures: [{ key: "field", format: "rgba16f", ...t }] }) as ProcessingStageContribution;

  it("accepts a lut or dynamic texture", () => {
    expect(checkStageContract(withTexture({ kind: "dynamic", perPhoto: true })).error).toBeNull();
    expect(checkStageContract(withTexture({ kind: "lut", perPhoto: true })).error).toBeNull();
  });

  it("refuses it on a texture filled from the bag, and a value that isn't true or false", () => {
    expect(checkStageContract(withTexture({ kind: "coverage", perPhoto: true })).error).toMatch(/perPhoto/);
    expect(checkStageContract(withTexture({ kind: "dynamic", perPhoto: "yes" })).error).toMatch(/perPhoto/);
  });
});
