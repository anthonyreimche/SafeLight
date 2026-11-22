// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage's "lut" and "dynamic" textures can be sampled in its passes: a pass
// that names a texture's key gets the stage's sampler for it, and the passes'
// signature follows the data the frame draws with, so new data (or another
// variant) draws the passes again from the first that names it. A pass that
// names none is built as before, and painted kinds stay inline-only.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution, TextureRequirement } from "@/extensions/types";
import { prefixSig, type SigFrame } from "./prepass-signature";
import { uniformPrefix } from "./shader-compiler";
import { buildStageInjection } from "./stage-injection";

const ID = "acme.depth";
const PFX = uniformPrefix(ID);

function stage(passGlsl: readonly string[], textures: TextureRequirement[]): ProcessingStageContribution {
  return {
    id: ID,
    name: "Depth",
    phase: "scene-linear",
    glsl: "lin = mix(lin, stageResult, take);",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    textures,
    passes: passGlsl.map((glsl) => ({ glsl, uniforms: [{ key: "gain", glslType: "float", default: 1 }] })),
  };
}

const DEPTH: TextureRequirement = { key: "depth", kind: "dynamic" };

describe("stage textures in passes", () => {
  it("declares the stage's sampler in a pass that names the key, and rewrites the name", () => {
    const [pass] = buildStageInjection([stage(["c = texture(depth, vUv).rgb * gain;"], [DEPTH])]).prepass[0].passes;
    expect(pass.fragmentSource).toContain(`uniform sampler2D ${PFX}depth;`);
    expect(pass.fragmentSource).toContain(`texture(${PFX}depth, vUv).rgb * ${PFX}gain`);
    expect(pass.textures).toEqual([{ qualifiedKey: `${ID}.depth`, glslName: `${PFX}depth` }]);
  });

  it("finds the key in the pass's helpers too", () => {
    const built = buildStageInjection([
      {
        ...stage([], [DEPTH, { key: "table", kind: "lut" }]),
        passes: [{ glsl: "c = vec3(near(vUv));", helpers: "float near(vec2 uv) { return texture(depth, uv).r; }" }],
      },
    ]);
    const [pass] = built.prepass[0].passes;
    expect(pass.fragmentSource).toContain(`texture(${PFX}depth, uv).r`);
    expect(pass.textures).toEqual([{ qualifiedKey: `${ID}.depth`, glslName: `${PFX}depth` }]);
  });

  it("leaves a pass that names no texture as it was", () => {
    const named = buildStageInjection([stage(["c = c * gain;"], [DEPTH])]).prepass[0].passes[0];
    const bare = buildStageInjection([stage(["c = c * gain;"], [])]).prepass[0].passes[0];
    expect(named.fragmentSource).toBe(bare.fragmentSource);
    expect(named).not.toHaveProperty("textures");
  });

  it("keeps painted and brush kinds out of passes", () => {
    const [pass] = buildStageInjection([
      stage(["c = vec3(mask(vUv));"], [{ key: "mask", kind: "coverage" }]),
    ]).prepass[0].passes;
    expect(pass.fragmentSource).not.toContain(`sampler2D ${PFX}mask`);
    expect(pass).not.toHaveProperty("textures");
  });

  it("signs the data the frame draws with from the first pass that names the texture", () => {
    const { prepass } = buildStageInjection([stage(["c = c * gain;", "c = texture(depth, vUv).rgb;"], [DEPTH])]);
    const frame = (data: string): SigFrame => ({
      bag: {},
      w: 64,
      h: 48,
      baseCurve: 0,
      linear: true,
      isFallbackPreview: false,
      processVersion: 2,
      sourceWidth: 640,
      sourceHeight: 480,
      stageTextureSig: (qualifiedKey) => (qualifiedKey === `${ID}.depth` ? data : "none"),
    });
    const before = frame(`${ID}.depth#a@1`);
    const after = frame(`${ID}.depth#a@2`);
    expect(prefixSig(prepass[0], after, "e1", 0)).toBe(prefixSig(prepass[0], before, "e1", 0));
    expect(prefixSig(prepass[0], after, "e1", 1)).not.toBe(prefixSig(prepass[0], before, "e1", 1));
  });
});
