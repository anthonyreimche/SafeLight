// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage that sets plainSource (a film negative inversion) takes the RAW
// baseline tone, the camera baseline after it and channel reconstruction off
// the photo while it is at work, and leaves them on while it is at rest.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";
import { baselineRefit, baselineTone } from "@/rendering/baseline-tone";
import type { WebGLRenderer } from "./renderer";
import {
  PIXEL_TOLERANCE,
  basicStagesFor,
  floatImage,
  identityParams,
  pixelAt,
  withRenderer,
  type FloatImage,
} from "./webgl.test-support";

// Hands the scene-linear colour to the frame, offset and scaled so values above
// white and below black survive the output clamp. It keeps the baseline (it
// doesn't skip it) and drops the shoulder, so the baseline is all that moves a
// value on its way to the probe.
const PROBE: ResolvedPipeline = {
  id: "test.plain-probe",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return 0.25 + lin * 0.125; }",
  skipBaseCurve: false,
  skipToneShoulder: true,
  sig: "test.plain-probe",
};

const STAGE_ID = "test.plain";

function plainStage(plainSource: boolean): ProcessingStageContribution {
  return {
    id: STAGE_ID,
    name: "Plain source probe",
    phase: "decode",
    glsl: "lin *= 1.0 + 0.0 * on;",
    uniforms: [{ key: "on", glslType: "float", default: 0 }],
    dormantWhen: { on: 0 },
    plainSource,
  };
}

const TEXEL = [0.2, 0.3, 0.1] as const;

function scene(stage: ProcessingStageContribution, on: number, source: FloatImage = floatImage(16, 16, () => TEXEL)) {
  return withRenderer({ stages: [...basicStagesFor(CURRENT_PROCESS_VERSION), stage], pipeline: PROBE }, (renderer: WebGLRenderer) => {
    renderer.setImage(source);
    renderer.setContributedParams({ [`${STAGE_ID}.on`]: on });
    renderer.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return { frame, at: (x: number, y: number) => pixelAt(frame, x, y).map((v) => (v - 0.25) / 0.125) };
  });
}

const baselined = (x: number) => baselineRefit(baselineTone(x));

describe("plainSource", () => {
  it("leaves the baseline on while the stage is at rest", () => {
    const out = scene(plainStage(true), 0).at(8, 8);
    out.forEach((v, i) => expect(Math.abs(v - baselined(TEXEL[i]))).toBeLessThan(2 * PIXEL_TOLERANCE));
    expect(Math.abs(out[1] - TEXEL[1])).toBeGreaterThan(0.05);
  });

  it("takes the baseline off while the stage is at work", () => {
    const out = scene(plainStage(true), 1).at(8, 8);
    out.forEach((v, i) => expect(Math.abs(v - TEXEL[i])).toBeLessThan(2 * PIXEL_TOLERANCE));
  });

  it("changes nothing for a stage at work that doesn't ask for it", () => {
    const out = scene(plainStage(false), 1).at(8, 8);
    out.forEach((v, i) => expect(Math.abs(v - baselined(TEXEL[i]))).toBeLessThan(2 * PIXEL_TOLERANCE));
  });

  it("leaves a channel at the clip level as it is while the stage is at work", () => {
    // Red at the sensor's clip level beside a darker, bluer neighbourhood:
    // channel reconstruction would rebuild red from the neighbourhood's colour.
    const CLIPPED = [1.0, 0.4, 0.3] as const;
    const source = floatImage(16, 16, (x, y) => (x === 8 && y === 8 ? CLIPPED : [0.1, 0.1, 0.4]));
    const out = scene(plainStage(true), 1, source).at(8, 8);
    out.forEach((v, i) => expect(Math.abs(v - CLIPPED[i])).toBeLessThan(2 * PIXEL_TOLERANCE));
  });
});
