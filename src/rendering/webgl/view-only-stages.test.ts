// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A view-only stage (ProcessingStageContribution.viewOnly) is a view aid, such
// as a focus overlay: its block runs only while the program draws for the eye
// (VIEW_STAGES_UNIFORM), which only the live view's renderer turns on, and then
// only for the frames it shows. Programs without one keep their text.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { checkStageContract } from "@/extensions/stage-validation";
import { uniformPrefix } from "./shader-compiler";
import { STAGE_ANCHORS } from "./stage-anchors";
import { V2_VARIANT, V3_VARIANT, buildFragmentShader } from "./shaders";
import { VIEW_STAGES_UNIFORM, buildStageInjection, stageSignature } from "./stage-injection";

const OVERLAY: ProcessingStageContribution = {
  id: "acme.overlay",
  name: "Overlay",
  phase: "output-encode",
  space: { encoding: "perceptual" },
  glsl: "c = mix(c, vec3(1.0, 0.0, 0.0), amount);",
  uniforms: [{ key: "amount", glslType: "float", default: 0 }],
  viewOnly: true,
};

const LOOK: ProcessingStageContribution = { ...OVERLAY, id: "acme.look", viewOnly: undefined };

describe("a view-only stage's block", () => {
  it("runs only while the program draws for the eye", () => {
    const { injection } = buildStageInjection([OVERLAY], V2_VARIANT);
    expect(injection.effects).toMatch(new RegExp(`if \\(${VIEW_STAGES_UNIFORM}\\) \\{`));
    expect(injection.uniforms).toContain(`uniform bool ${VIEW_STAGES_UNIFORM};`);
  });

  it("declares the switch once for several view-only stages", () => {
    const second = { ...OVERLAY, id: "acme.overlay2" };
    const { injection } = buildStageInjection([OVERLAY, second], V2_VARIANT);
    expect(injection.uniforms.split(`uniform bool ${VIEW_STAGES_UNIFORM};`)).toHaveLength(2);
    expect(injection.effects.match(new RegExp(`if \\(${VIEW_STAGES_UNIFORM}\\)`, "g"))).toHaveLength(2);
  });

  // The patch pass (Heal's) bakes the retouched source every frame draws from,
  // exports included, while the uniform may be on: it must end before any
  // stage block.
  it("never runs in the patch pass, which ends before every stage block", () => {
    const { injection } = buildStageInjection([OVERLAY], V3_VARIANT);
    const source = buildFragmentShader(null, injection, V3_VARIANT);
    const patch = source.indexOf("if (uPatchPass) {");
    const patchEnd = source.indexOf("return;", patch);
    expect(patch).toBeGreaterThan(0);
    expect(source.slice(patch, patchEnd)).not.toContain(VIEW_STAGES_UNIFORM);
    expect(source.indexOf(`if (${VIEW_STAGES_UNIFORM})`)).toBeGreaterThan(patchEnd);
  });

  // The live view runs the block every frame, the aid off included: a stage that
  // reads its result through its own sampler, inside its own switch, pays no
  // fetch per pixel while off.
  it("fetches its result for the block only when the block names stageResult", () => {
    const passes = [{ glsl: "c = c * 0.5;" }];
    const sampled = { ...OVERLAY, passes, glsl: `if (amount > 0.5) c = textureLod(${uniformPrefix(OVERLAY.id)}stageResult, srcUv, 0.0).rgb;` };
    const named = { ...OVERLAY, passes, glsl: "if (amount > 0.5) c = stageResult;" };
    const fetch = /vec3 stageResult = /;
    expect(buildStageInjection([sampled], V2_VARIANT).injection.effects).not.toMatch(fetch);
    expect(buildStageInjection([named], V2_VARIANT).injection.effects).toMatch(fetch);
    expect(buildStageInjection([{ ...sampled, viewOnly: undefined }], V2_VARIANT).injection.effects).toMatch(fetch);
  });

  it("leaves a program without one as it was", () => {
    const { injection } = buildStageInjection([LOOK], V2_VARIANT);
    expect(injection.effects).not.toContain(VIEW_STAGES_UNIFORM);
    expect(injection.uniforms).not.toContain(VIEW_STAGES_UNIFORM);
  });

  it("signs differently from the same stage drawn everywhere", () => {
    expect(stageSignature(OVERLAY)).not.toBe(stageSignature(LOOK));
    expect(stageSignature({ ...LOOK, viewOnly: false })).toBe(stageSignature(LOOK));
  });
});

describe("the view-only contract", () => {
  const withFields = (fields: Record<string, unknown>): ProcessingStageContribution =>
    // Plain JavaScript can pass values TypeScript would reject.
    ({ ...OVERLAY, ...fields }) as ProcessingStageContribution;

  it("accepts a view-only stage", () => {
    expect(checkStageContract(OVERLAY)).toEqual({ error: null, readsIgnored: null, warnings: [] });
  });

  it("refuses a value that isn't true or false", () => {
    expect(checkStageContract(withFields({ viewOnly: "yes" })).error).toMatch(/viewOnly must be true or false/);
  });

  it("refuses a geometry stage, which moves what every frame samples", () => {
    expect(checkStageContract(withFields({ phase: "geometry", space: undefined })).error).toMatch(/geometry/);
  });

  it("refuses values handed to other stages, which exports would read differently", () => {
    const produces = [{ name: "acme_focus", glslType: "float", producer: "0.0" }];
    expect(checkStageContract(withFields({ produces })).error).toMatch(/produce/);
  });

  it("refuses mask copies, which would draw the aid into a mask", () => {
    expect(checkStageContract(withFields({ mask: { maskable: true } })).error).toMatch(/mask/);
  });

  // An extension's noise reduction replaces the built-in denoiser in every
  // program, exports included, so a view aid there would take it away.
  it("refuses the noise-reduction phase, which would leave exports without noise reduction", () => {
    expect(checkStageContract(withFields({ phase: "noise-reduction", space: undefined })).error).toMatch(/noise-reduction/);
  });

  it("refuses an anchor, whose block is written outside the view-only switch", () => {
    expect(checkStageContract(withFields({ anchor: Object.keys(STAGE_ANCHORS)[0] })).error).toMatch(/anchor/);
  });

  it("refuses reading the current image, whose split exit is written outside the view-only switch", () => {
    const fields = { reads: "current", passes: [{ glsl: "c = c * 0.5;" }] };
    expect(checkStageContract(withFields(fields)).error).toMatch(/reads/);
    expect(checkStageContract(withFields({ ...fields, reads: "source" })).error).toBeNull();
  });
});
