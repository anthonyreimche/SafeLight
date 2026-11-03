// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every program a photo renders with defines SL_PROCESS_VERSION, its process
// version, so an extension stage can keep a range fix off frozen version 1
// photos with `#if SL_PROCESS_VERSION >= 2`: in its inline glsl, its helpers
// and its passes.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import {
  LINEAR_PROBE_PIPELINE,
  type Frame,
  floatImage,
  identityParams,
  withRenderer,
  worstDifference,
} from "./webgl.test-support";

const SOURCE = floatImage(8, 8, (x, y) => [0.1 + x / 32, 0.05 + y / 32, 0.3]);

const stage = (id: string, over: Partial<ProcessingStageContribution>): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "scene-linear",
  glsl: "",
  uniforms: [],
  ...over,
});

const byVersion = (v2: string, v1: string): string =>
  `#if SL_PROCESS_VERSION >= 2\n${v2}\n#else\n${v1}\n#endif`;

function framesOf(
  stages: ProcessingStageContribution[],
  versions: readonly number[],
  bag: Record<string, unknown> = {},
): Frame[] {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    renderer.setImage(SOURCE);
    renderer.setContributedParams(bag);
    return versions.map((processVersion) => {
      renderer.setParams(identityParams({ processVersion }));
      const frame = renderer.captureFloatFrame();
      if (!frame) throw new Error("captureFloatFrame returned null");
      return frame;
    });
  });
}

const frameOf = (stages: ProcessingStageContribution[], version: number): Frame => framesOf(stages, [version])[0];

describe("SL_PROCESS_VERSION", () => {
  it("is the photo's process version in a stage's inline glsl", () => {
    const gated = stage("pv.inline", { glsl: byVersion("lin *= 2.0;", "lin *= 0.5;") });
    const [v1, v2] = framesOf([gated], [1, 2]);
    expect(worstDifference(v1, frameOf([stage("pv.half", { glsl: "lin *= 0.5;" })], 1))).toBeLessThan(1e-3);
    expect(worstDifference(v2, frameOf([stage("pv.double", { glsl: "lin *= 2.0;" })], 2))).toBeLessThan(1e-3);
  });

  it("is the photo's process version in a stage's helpers", () => {
    const gated = stage("pv.helpers", {
      helpers: `float gain() {\n${byVersion("return 2.0;", "return 0.5;")}\n}`,
      glsl: "lin *= gain();",
    });
    const [v1, v2] = framesOf([gated], [1, 2]);
    expect(worstDifference(v1, frameOf([stage("pv.half", { glsl: "lin *= 0.5;" })], 1))).toBeLessThan(1e-3);
    expect(worstDifference(v2, frameOf([stage("pv.double", { glsl: "lin *= 2.0;" })], 2))).toBeLessThan(1e-3);
  });

  // One renderer draws both versions, so a pass program or result kept from
  // the other version's frame shows here.
  it("is the photo's process version in a stage's passes", () => {
    const gated = stage("pv.pass", {
      phase: "decode",
      uniforms: [{ key: "on", glslType: "float", default: 0 }],
      passes: [{ glsl: byVersion("c = vec3(0.4);", "c = vec3(0.1);") }],
      glsl: "if (on > 0.5) lin = stageResult;",
    });
    const [v1, v2, again] = framesOf([gated], [1, 2, 1], { "pv.pass.on": 1 });
    const flat = (value: string) => stage("pv.flat", { phase: "decode", glsl: `lin = vec3(${value});` });
    expect(worstDifference(v1, frameOf([flat("0.1")], 1))).toBeLessThan(2e-3);
    expect(worstDifference(v2, frameOf([flat("0.4")], 2))).toBeLessThan(2e-3);
    expect(worstDifference(again, v1)).toBe(0);
  });
});
