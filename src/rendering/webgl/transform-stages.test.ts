// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage that belongs to a display transform (ProcessingStageContribution
// .transform) is in a frame's stages only while the frame draws with that
// transform. SafeLight #278: a camera-match lookup registered for the open
// photo reached every thumbnail and export drawn while it was open.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { checkStageContract } from "@/extensions/stage-validation";
import { stagesForTransform } from "./transform-stages";

const MATCH: ProcessingStageContribution = {
  id: "acme.match",
  name: "Match",
  phase: "effects",
  space: { encoding: "perceptual" },
  glsl: "c = c * 0.5;",
  uniforms: [],
  transform: "acme.match-transform",
};

const LOOK: ProcessingStageContribution = { ...MATCH, id: "acme.look", transform: undefined };

const withFields = (fields: Record<string, unknown>) => ({ ...MATCH, ...fields }) as ProcessingStageContribution;

describe("stagesForTransform", () => {
  it("keeps a transform's stage in frames drawn with it", () => {
    expect(stagesForTransform([LOOK, MATCH], "acme.match-transform")).toEqual([LOOK, MATCH]);
  });

  it("leaves it out of frames drawn with another transform", () => {
    expect(stagesForTransform([LOOK, MATCH], "core.pipeline")).toEqual([LOOK]);
  });

  it("hands back the set itself when it leaves nothing out", () => {
    const set = [LOOK, MATCH];
    expect(stagesForTransform(set, "acme.match-transform")).toBe(set);
    const keyed = { [LOOK.id]: LOOK };
    expect(stagesForTransform(keyed, "core.pipeline")).toBe(keyed);
  });
});

describe("a transform's stage contract", () => {
  it("accepts a transform id", () => {
    expect(checkStageContract(MATCH).error).toBeNull();
  });

  it("refuses a value that isn't a transform id", () => {
    expect(checkStageContract(withFields({ transform: 3 })).error).toMatch(/transform must be/);
    expect(checkStageContract(withFields({ transform: "" })).error).toMatch(/transform must be/);
  });

  it("refuses a geometry stage, which moves what the crop and overlays are drawn over", () => {
    expect(checkStageContract(withFields({ phase: "geometry", space: undefined })).error).toMatch(/geometry/);
  });

  it("refuses values handed to other stages, which would go missing with another transform", () => {
    const produces = [{ name: "acme_match", glslType: "float", producer: "0.0" }];
    expect(checkStageContract(withFields({ produces })).error).toMatch(/produce/);
  });
});
