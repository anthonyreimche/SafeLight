// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Anchors: a point in the develop program's main() for each of the core
// tools, where the stage that takes the tool over writes its block. Only
// Safelight's own stages may name one. A stage there is written as it reads,
// with no braces around it, so a program whose blocks moved onto anchors can
// still be the frozen program token for token.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution, StageAnchor } from "@/extensions/types";
import { checkStageContract } from "@/extensions/stage-validation";
import { CORE_EXTENSION_ID } from "@/extensions/core-extension";
import { buildFragmentShader, V1_VARIANT, V2_VARIANT, V3_VARIANT } from "./shaders";
import { isStandIn } from "./core-reads";
import { buildStageInjection } from "./stage-injection";
import { STAGE_ANCHORS } from "./stage-anchors";
import { builtinStages } from "./webgl.test-support";

const anchored = (
  anchor: StageAnchor,
  glsl: string,
  extra: Partial<ProcessingStageContribution> = {},
): ProcessingStageContribution => ({
  id: `core.probe-${anchor}`,
  name: `Probe ${anchor}`,
  phase: STAGE_ANCHORS[anchor].domain === "scene" ? "scene-linear" : "display-adjust",
  // Ahead of the core tool's own stage at the anchor.
  priority: 0,
  anchor,
  glsl,
  uniforms: [],
  ...extra,
});

/** Where each anchor sits: just ahead of the core block it is named for. */
const LANDMARKS: Record<StageAnchor, string> = {
  geometry: "vec2 srcUv = cropTransformUV(viewUv);",
  retouch: "if (uApplyRetouch && (uSpotCount > 0 || uRetouchCount > 0))",
  "white-balance": "lin = applyWhiteBalance(lin, uTemperature",
  tone: "float E = uExposure;",
  masks: "float mcovs[MAX_MASKS];",
  "display-basic": "if (abs(uWhites) > 0.001)",
  "tone-curve": "c = applyToneCurve(c);",
  hsl: "applyHSL(",
  presence: "if (abs(dehAmt) > 0.001)",
  "band-detail": "float bandDet =",
  vibrance: "c = applyVibSat(c, uVibrance, uSaturation);",
  "color-grading": "applyColorGrading(",
  sharpen: "float sharpenViz = 0.0;",
};

const ANCHORS = Object.keys(STAGE_ANCHORS) as StageAnchor[];
const probe = (anchor: StageAnchor) => `slProbe_${anchor.replace(/-/g, "_")}();`;

describe("anchors", () => {
  it("are named in main()'s order", () => {
    expect(ANCHORS).toEqual([
      "geometry",
      "retouch",
      "white-balance",
      "tone",
      "masks",
      "display-basic",
      "tone-curve",
      "hsl",
      "presence",
      "band-detail",
      "vibrance",
      "color-grading",
      "sharpen",
    ]);
  });

  for (const variant of [V1_VARIANT, V2_VARIANT, V3_VARIANT]) {
    it(`each lands right ahead of its core block (version ${variant.version})`, () => {
      const probes = ANCHORS.map((a) => anchored(a, probe(a)));
      const { injection } = buildStageInjection([...builtinStages(), ...probes], variant);
      const shader = buildFragmentShader(null, injection, variant);
      const main = shader.slice(shader.indexOf("void main()"));
      // Each anchor sits after the block before it and ahead of its own.
      let previousBlock = -1;
      for (const anchor of ANCHORS) {
        const at = main.indexOf(probe(anchor));
        const block = main.indexOf(LANDMARKS[anchor], at);
        expect(at, anchor).toBeGreaterThan(previousBlock);
        expect(block, anchor).toBeGreaterThan(at);
        previousBlock = block;
      }
    });
  }

  it("write a stage's block as it reads, outside every injection group", () => {
    const glsl = "float slProbeE = uProbeAmount;\nc *= slProbeE;";
    const { injection } = buildStageInjection(
      [anchored("tone-curve", glsl, { uniforms: [{ key: "uProbeAmount", glslType: "float", default: 0 }] })],
      V2_VARIANT,
    );
    expect(injection.anchors).toEqual({ "tone-curve": glsl });
    // Then core's stand-ins for the names no stage here declares (core-reads.ts).
    expect(injection.uniforms.split("\n")[0]).toBe("uniform float uProbeAmount;");
    expect(injection.uniforms.split("\n").slice(1).every(isStandIn)).toBe(true);
    expect([injection.sceneLinear, injection.effects]).toEqual(["", ""]);
  });

  it("declare a stage's helpers with the other helpers", () => {
    const helpers = "vec3 slProbeTint(vec3 c) { return c; }";
    const { injection } = buildStageInjection([anchored("hsl", "c = slProbeTint(c);", { helpers })], V2_VARIANT);
    expect(injection.helpers).toBe(helpers);
  });

  it("run their stages by priority", () => {
    const { injection } = buildStageInjection(
      [
        anchored("vibrance", "slSecond();", { id: "core.second", priority: 200 }),
        anchored("vibrance", "slFirst();", { id: "core.first", priority: 10 }),
      ],
      V2_VARIANT,
    );
    expect(injection.anchors?.vibrance).toBe("slFirst();\nslSecond();");
  });

  it("leave the injection without anchors when no stage names one, as the freeze hashes it", () => {
    const { injection } = buildStageInjection([], V2_VARIANT);
    expect("anchors" in injection).toBe(false);
  });

  it("write nothing where no stage names them", () => {
    const { injection } = buildStageInjection([anchored("sharpen", probe("sharpen"))], V1_VARIANT);
    expect(Object.keys(injection.anchors ?? {})).toEqual(["sharpen"]);
    const shader = buildFragmentShader(null, injection, V1_VARIANT);
    expect(shader).not.toContain("__ANCHOR_");
  });

  it("are left to Safelight's stages: an extension's stage stays in its phase's group", () => {
    const ext = anchored("hsl", "c = c * 2.0;", { id: "acme.tint" });
    const { injection } = buildStageInjection([ext], V2_VARIANT);
    expect(injection.anchors).toBeUndefined();
    expect(injection.effects).toContain("c = c * 2.0;");
  });
});

describe("the anchor contract", () => {
  it("warns an extension that its anchor is ignored", () => {
    const check = checkStageContract(anchored("hsl", "c = c;", { id: "acme.tint" }), "acme");
    expect(check.error).toBeNull();
    expect(check.warnings).toContain(
      'stage "acme.tint": anchor is for Safelight\'s own stages, so it is ignored',
    );
  });

  it("refuses an anchor that doesn't exist", () => {
    const check = checkStageContract(
      { ...anchored("hsl", "c = c;"), anchor: "toneCurve" as StageAnchor },
      CORE_EXTENSION_ID,
    );
    expect(check.error).toBe('stage "core.probe-hsl": anchor "toneCurve" is not one of geometry, retouch, white-balance, tone, masks, display-basic, tone-curve, hsl, presence, band-detail, vibrance, color-grading, sharpen');
  });

  it("accepts Safelight's own anchored stage", () => {
    const check = checkStageContract(anchored("tone", "lin = lin;"), CORE_EXTENSION_ID);
    expect(check).toEqual({ error: null, readsIgnored: null, warnings: [] });
  });
});
