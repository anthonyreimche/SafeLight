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
  V3_VARIANT,
  buildFragmentShader,
  shaderVariantFor,
  variantKey,
  type StageInjection,
} from "./shaders";

describe("shaderVariantFor", () => {
  it("renders anything that isn't a stored version 2 or later as version 1", () => {
    for (const v of [undefined, null, 0, -3, 1, 1.5, "2"]) expect(shaderVariantFor(v)).toBe(V1_VARIANT);
  });

  it("renders version 2, and any newer version the default cap doesn't allow, as version 2", () => {
    for (const v of [2, 3, 7, 99]) expect(shaderVariantFor(v)).toBe(V2_VARIANT);
  });

  it("renders a newer version as the newest the cap allows", () => {
    expect(shaderVariantFor(3, 3)).toBe(V3_VARIANT);
    expect(shaderVariantFor(99, 3)).toBe(V3_VARIANT);
    expect(shaderVariantFor(2, 3)).toBe(V2_VARIANT);
  });
});

describe("variants", () => {
  // The renderer's shoulder gate and developed-copy format read fullInfo, so
  // version 3 keeps version 2's decisions until a task changes them on purpose.
  it("name what each version changes", () => {
    expect(V1_VARIANT).toEqual({ version: 1, fullInfo: false, signedOutput: false });
    expect(V2_VARIANT).toEqual({ version: 2, fullInfo: true, signedOutput: false });
    expect(V3_VARIANT).toEqual({ version: 3, fullInfo: true, signedOutput: true });
  });

  it("key the program cache as before", () => {
    expect([V1_VARIANT, V2_VARIANT, V3_VARIANT].map(variantKey)).toEqual(["pv1", "pv2", "pv3"]);
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

describe("Highlights and Shadows in the version 2 program", () => {
  const v2 = buildFragmentShader(null, undefined, V2_VARIANT);
  const v1 = buildFragmentShader(null, undefined, V1_VARIANT);

  it("runs the tone block through the shared curves", () => {
    expect(v2).toContain("float L1 = slToneHighlights(Lx, E, H);");
    expect(v2).toContain("float L2 = slToneShadows(L1, S);");
    expect(v1).not.toContain("slToneHighlights");
  });

  it("leaves Highlight and Shadow Detail to their own sliders", () => {
    expect(v2).toContain("float hiGain = uHighlightDetail / 100.0;");
    expect(v2).toContain("float shGain = uShadowDetail / 100.0;");
    expect(v1).toContain("float hiGain = (H < 0.0 ? -H : 0.0) + uHighlightDetail / 100.0;");
    expect(v1).toContain("float shGain = (S > 0.0 ? 0.5 * S : 0.0) + uShadowDetail / 100.0;");
  });
});

describe("the camera baseline", () => {
  const REFIT = "if (uApplyBaseCurve) lin = slBaselineRefit(lin) * uBaselineGain;";
  const main = (src: string) => src.slice(src.indexOf("void main()"));

  // The decode stages' passes share one prelude across versions, which runs
  // the source through baselineTone alone. Refitting after them, and after clip
  // recovery (whose 0.98 threshold assumes that curve), keeps both agreeing.
  for (const variant of [V2_VARIANT, V3_VARIANT]) {
    const src = buildFragmentShader(null, undefined, variant);

    it(`is refit after channel reconstruction and before white balance on version ${variant.version}`, () => {
      const body = main(src);
      expect(body.split(REFIT)).toHaveLength(2);
      expect(body).toContain("if (uApplyBaseCurve) lin = baselineTone(lin);");
      expect(body.indexOf("lin = reconstructClipped(lin, srcUv);")).toBeLessThan(body.indexOf(REFIT));
      expect(body.indexOf(REFIT)).toBeLessThan(body.indexOf("lin = applyWhiteBalance(lin, uTemperature"));
    });

    it(`declares the camera's gain and the refit curve on version ${variant.version}`, () => {
      expect(src).toContain("uniform float uBaselineGain;");
      expect(src).toContain("vec3 slBaselineRefit(vec3 x)");
    });
  }

  it("leaves version 1 without either", () => {
    const src = buildFragmentShader(null, undefined, V1_VARIANT);
    expect(src).not.toContain("uBaselineGain");
    expect(src).not.toContain("slBaselineRefit");
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

describe("a transform's uniforms", () => {
  const GLSL = "vec3 pipelineToDisplay(vec3 lin) { return u_t_gain * lin; }";

  it("are declared ahead of the transform that reads them", () => {
    const src = buildFragmentShader(GLSL, undefined, V2_VARIANT, undefined, "uniform float u_t_gain;");
    const declared = src.indexOf("uniform float u_t_gain;");
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(src.indexOf(GLSL));
  });

  it("leave the program text alone when there are none", () => {
    expect(buildFragmentShader(GLSL, undefined, V2_VARIANT, undefined, "")).toBe(
      buildFragmentShader(GLSL, undefined, V2_VARIANT),
    );
  });
});

describe("the scene exit", () => {
  const EXIT = "fragColor = vec4(slEncodePerceptual(lin), 1.0); return;";

  it("is in a scene program only, once, ahead of the display transform", () => {
    const src = buildFragmentShader(null, undefined, V2_VARIANT, "scene");
    expect(src.split(EXIT)).toHaveLength(2);
    const main = src.indexOf("void main()");
    expect(src.indexOf(EXIT)).toBeLessThan(src.indexOf("pipelineToDisplay(lin)", main));
    expect(buildFragmentShader(null, undefined, V2_VARIANT)).not.toContain(EXIT);
  });

  // The scene point is what the display transform receives: every scene-linear
  // and tone-map stage has run.
  it("comes after the scene-linear stages", () => {
    const stages = {
      uniforms: "",
      helpers: "",
      srcUv: "",
      noiseReduction: "",
      sceneLinear: "/*MARK*/",
      effects: "",
    };
    for (const variant of [V1_VARIANT, V2_VARIANT]) {
      const src = buildFragmentShader(null, stages, variant, "scene");
      expect(src.indexOf("/*MARK*/")).toBeGreaterThan(-1);
      expect(src.indexOf("/*MARK*/")).toBeLessThan(src.indexOf(EXIT));
    }
  });

  it("lets a split draw run past it", () => {
    const stages = {
      uniforms: "uniform int uSplitAt;",
      helpers: "",
      srcUv: "",
      noiseReduction: "",
      sceneLinear: "",
      effects: "",
      splitCount: 1,
    };
    expect(buildFragmentShader(null, stages, V2_VARIANT, "scene")).toContain(`if (uSplitAt < 0) { ${EXIT} }`);
  });

  it("brings the encoding helpers into a version 1 scene program", () => {
    expect(buildFragmentShader(null, undefined, V1_VARIANT, "scene")).toContain("vec3 slEncodePerceptual(");
    expect(buildFragmentShader(null, undefined, V1_VARIANT)).not.toContain("vec3 slEncodePerceptual(");
  });
});
