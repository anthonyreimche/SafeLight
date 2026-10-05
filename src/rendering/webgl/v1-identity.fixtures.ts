// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the process version 1 freeze covers (v1-identity.test.tsx): stage sets
// and display transforms whose assembled develop shader must stay
// token-for-token what b1f5ec5 built. Every stage here is shaped like an
// extension written before `space` existed.

import type { ProcessingStageContribution } from "@/extensions/types";
import type { BuiltStageInjection, ContributedBinding } from "./stage-injection";
import type { V1Binding, V1StageMeta } from "./v1-reference-meta";
import { builtinStages } from "./webgl.test-support";

export const LEGACY_EXTENSION_STAGES: ProcessingStageContribution[] = [
  {
    id: "legacy.warp",
    name: "Warp",
    phase: "geometry",
    glsl: "srcUv.x += warpAmount * 0.01 * (srcUv.y - 0.5);",
    uniforms: [{ key: "warpAmount", glslType: "float", default: 0 }],
  },
  {
    id: "legacy.fringe",
    name: "Fringe",
    phase: "decode",
    glsl: "lin = mix(lin, stageResult, fringeAmount);",
    uniforms: [{ key: "fringeAmount", glslType: "float", default: 0 }],
    passes: [
      {
        glsl: "c = 0.5 * (readPrev(vUv - vec2(uTexel.x, 0.0)) + readPrev(vUv + vec2(uTexel.x, 0.0)));",
      },
    ],
  },
  {
    id: "legacy.smooth",
    name: "Smooth",
    phase: "noise-reduction",
    priority: 60,
    glsl: "lin = mix(lin, smoothBlend(stageResult, lin), smoothAmount);",
    helpers: "vec3 smoothBlend(vec3 a, vec3 b) { return 0.5 * (a + b); }",
    uniforms: [{ key: "smoothAmount", glslType: "float", default: 0 }],
    passes: [
      {
        glsl: "c = smoothTap(vUv, smoothRadius);",
        helpers:
          "vec3 smoothTap(vec2 uv, float r) { return 0.5 * (readPrev(uv) + readPrev(uv + vec2(0.0, uTexel.y * r))); }",
        iterations: 2,
        uniforms: [{ key: "smoothRadius", glslType: "float", default: 1 }],
      },
    ],
  },
  {
    id: "legacy.film",
    name: "Film",
    phase: "tone-map",
    glsl: "lin = mix(lin, texture(filmLut, vec2(clamp(luma(lin), 0.0, 1.0), 0.5)).rgb, filmAmount);",
    uniforms: [{ key: "filmAmount", glslType: "float", default: 0 }],
    textures: [{ key: "filmLut", kind: "lut", width: 256, height: 1, format: "rgba8" }],
  },
  {
    id: "legacy.local",
    name: "Local",
    phase: "scene-linear",
    glsl: "lin *= 1.0 + localGain * localCov(srcUv);",
    uniforms: [{ key: "localGain", glslType: "float", default: 0 }],
    textures: [{ key: "localCov", kind: "coverage" }],
  },
  {
    id: "legacy.tint",
    name: "Tint",
    phase: "display-adjust",
    glsl: "c = mix(c, c * tintColor, tintAmount);",
    uniforms: [
      { key: "tintColor", glslType: "vec3", default: [1, 1, 1] },
      { key: "tintAmount", glslType: "float", default: 0 },
    ],
  },
  {
    id: "legacy.glow",
    name: "Glow",
    phase: "effects",
    priority: 70,
    glsl: "c += glowAmount * 0.1 * luma(c);",
    uniforms: [{ key: "glowAmount", glslType: "float", default: 0 }],
  },
  {
    id: "legacy.mono",
    name: "Mono",
    phase: "output-encode",
    glsl: "if (monoOn) c = vec3(luma(c));",
    uniforms: [{ key: "monoOn", glslType: "bool", default: false }],
  },
];

export const V1_IDENTITY_CONFIGS = {
  builtin: (): ProcessingStageContribution[] => builtinStages(),
  legacyExtensions: (): ProcessingStageContribution[] => [
    ...builtinStages(),
    ...LEGACY_EXTENSION_STAGES,
  ],
};

export const V1_IDENTITY_PIPELINES: Record<string, string | null> = {
  builtin: null,
  custom: "vec3 pipelineToDisplay(vec3 lin) { return lin / (1.0 + max(lin, vec3(0.0))); }",
};

const pickBinding = (b: ContributedBinding): V1Binding => ({
  qualifiedKey: b.qualifiedKey,
  glslName: b.glslName,
  glslType: b.glslType,
  default: b.default,
});

/** What a built injection hands the renderer besides GLSL text: uniform and
 *  texture bindings, the NR flag and the prepass layout. Every field is picked
 *  by name, so anything a later task adds to the builder's result (a prepass
 *  `split`, say) stays out of the version 1 freeze. `sig` is left out on
 *  purpose: it isn't GLSL, and its format may change without changing any
 *  render. */
export function projectStageMeta(built: BuiltStageInjection): V1StageMeta {
  return {
    bindings: built.bindings.map(pickBinding),
    textureBindings: built.textureBindings.map((t) => ({
      qualifiedKey: t.qualifiedKey,
      glslName: t.glslName,
      kind: t.kind,
    })),
    hasNoiseReduction: built.hasNoiseReduction,
    prepass: built.prepass.map((p) => ({
      stageId: p.stageId,
      resultUniform: p.resultUniform,
      passes: p.passes.map((pass) => ({
        iterations: pass.iterations,
        bindings: pass.bindings.map(pickBinding),
      })),
    })),
  };
}

/** Code tokens only: comments, blank lines and indentation dropped, runs of
 *  whitespace collapsed. Two shaders that normalize equal compile to the same
 *  program, so comments and layout may change without touching v1 renders.
 *  Comments go in one left-to-right pass, so whichever opener comes first hides
 *  the other as it does for a compiler, and each leaves a space so it still
 *  separates the tokens either side. */
export function normalizeGlsl(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}
