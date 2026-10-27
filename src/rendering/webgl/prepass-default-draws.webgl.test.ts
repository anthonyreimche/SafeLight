// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage runs its passes when the bag holds a non-zero value under its id, or
// when one of its `{ key, max }` passes resolves above 0 from the bag or from
// the uniform's default (renderer.ts prepassActive). Without the second rule a
// stage whose draw count defaults above 0 sat idle on an untouched photo while
// its inline still ran with that default, reading the idle fallback (the raw
// source) as if it were the stage's result.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { LINEAR_PROBE_PIPELINE, floatImage, identityParams, withRenderer, worstDifference, type Frame } from "./webgl.test-support";

const ID = "default-draws.test";
/** Far from 0.25 in every channel, so a frame that shows the raw source fails the first case. */
const SOURCE = floatImage(8, 8, (x, y) => [0.1 + x / 32, 0.05 + y / 32, 0.6]);

function counted(defaultDraws: number): ProcessingStageContribution {
  return {
    id: ID,
    name: "Default draws",
    phase: "decode",
    uniforms: [{ key: "n", glslType: "float", default: defaultDraws }],
    passes: [{ glsl: "c = vec3(0.25);", iterations: { key: "n", max: 4 } }],
    glsl: "lin = stageResult;",
  };
}

/** What the counted stage's result looks like once its pass has drawn. */
const REFERENCE: ProcessingStageContribution = {
  id: "default-draws-reference.test",
  name: "Reference",
  phase: "decode",
  uniforms: [],
  glsl: "lin = vec3(0.25);",
};

function frameOf(stages: ProcessingStageContribution[], bag: Record<string, unknown>): Frame {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    renderer.setImage(SOURCE);
    renderer.setParams(identityParams());
    renderer.setContributedParams(bag);
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

describe("a { key, max } pass whose count defaults above 0", () => {
  it("runs on an empty bag", () => {
    // The pass writes 0.25 to a half-float target; the reference writes it exactly.
    expect(worstDifference(frameOf([counted(2)], {}), frameOf([REFERENCE], {}))).toBeLessThan(2e-3);
  });

  it("leaves its stage idle when the default is 0", () => {
    expect(worstDifference(frameOf([counted(0)], {}), frameOf([], {}))).toBe(0);
  });

  it("leaves its stage idle when the bag sets the count to 0", () => {
    expect(worstDifference(frameOf([counted(2)], { [`${ID}.n`]: 0 }), frameOf([], {}))).toBe(0);
  });
});
