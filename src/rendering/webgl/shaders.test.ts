// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which develop program a photo gets. Version 1 must stay the frozen program
// (v1-identity.test.tsx); version 2 differs only where these tests say.

import { describe, expect, it } from "vitest";
import {
  V1_VARIANT,
  V2_VARIANT,
  buildFragmentShader,
  shaderVariantFor,
  type StageInjection,
} from "./shaders";

describe("shaderVariantFor", () => {
  it("renders anything that isn't a stored version 2 or later as version 1", () => {
    for (const v of [undefined, null, 0, 1, 1.5, "2"]) expect(shaderVariantFor(v)).toBe(V1_VARIANT);
  });

  it("renders version 2, and any newer version this build doesn't know, as version 2", () => {
    expect(shaderVariantFor(2)).toBe(V2_VARIANT);
    expect(shaderVariantFor(7)).toBe(V2_VARIANT);
  });
});

describe("the version 2 program", () => {
  const v2 = buildFragmentShader(null, undefined, V2_VARIANT);
  const v1 = buildFragmentShader(null, undefined, V1_VARIANT);

  it("no longer clips everything the display transform hands on", () => {
    expect(v2).not.toContain("clamp(pipelineToDisplay(lin), 0.0, 1.0)");
    expect(v2).toContain("vec3 disp = pipelineToDisplay(lin);");
  });

  it("keeps colour outside sRGB signed through the built-in transform", () => {
    expect(v2).toContain("return slEncodePerceptual(lin);");
  });

  it("skips the tone curve, HSL, vibrance/saturation and grading at identity", () => {
    expect(v2).toContain("if (uCurveActive) c = applyToneCurve(c);");
    expect(v2).toContain("if (uHslActive) c = applyHSL(clamp(c, 0.0, 1.0));");
    expect(v2).toContain("if (abs(uVibrance) >= 0.1 || abs(uSaturation) > 0.1)");
    expect(v2).toContain("if (uColorGradingActive) c = applyColorGrading(clamp(c, 0.0, 1.0));");
  });

  it("leaves version 1 without any of it", () => {
    for (const token of ["uCurveActive", "slEncodePerceptual", "uMaskHasDisplay"])
      expect(v1).not.toContain(token);
  });
});

describe("buildFragmentShader", () => {
  // String.replace reads $&, $$, $' and $` in a replacement string as
  // patterns; contributed GLSL must still arrive as written.
  it("splices GLSL that contains replacement patterns verbatim", () => {
    const note = (where: string) => `// ${where} cost: $& and $$, $' and $\``;
    const pipeline = `vec3 pipelineToDisplay(vec3 lin) { return lin; } ${note("pipeline")}`;
    const stages = {
      uniforms: note("uniforms"),
      helpers: note("helpers"),
      srcUv: note("srcUv"),
      noiseReduction: note("noiseReduction"),
      sceneLinear: note("sceneLinear"),
      effects: note("effects"),
    } satisfies StageInjection;
    for (const variant of [V1_VARIANT, V2_VARIANT]) {
      const shader = buildFragmentShader(pipeline, stages, variant);
      for (const glsl of [pipeline, ...Object.values(stages)]) expect(shader).toContain(glsl);
    }
  });
});

describe("split draws", () => {
  const base = {
    uniforms: "uniform int uSplitAt;",
    helpers: "",
    srcUv: "srcUv.x += 0.0;",
    noiseReduction: "",
    sceneLinear: "",
    effects: "",
  };

  it("reads source texels and skips geometry only when the program has splits", () => {
    const withSplits = buildFragmentShader(null, { ...base, splitCount: 1 }, V1_VARIANT);
    expect(withSplits).toContain("if (uSplitAt >= 0) srcUv = vec2(vUv.x, 1.0 - vUv.y);");
    expect(withSplits).toMatch(/if \(uSplitAt < 0\) \{\s*srcUv\.x \+= 0\.0;\s*\}/);
    const without = buildFragmentShader(null, { ...base, uniforms: "" }, V1_VARIANT);
    expect(without).not.toContain("uSplitAt");
  });
});
