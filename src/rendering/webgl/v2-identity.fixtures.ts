// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the process version 2 freeze covers (v2-identity.test.tsx): stage sets
// and transforms chosen to reach every version 2 branch of the shader template
// and the injector (inserted clamps, space conversions, split exits,
// slSceneLuma, layered results) as Safelight 3.0.1, the newest release that
// renders version 2 photos, built them.

import type { ProcessingStageContribution } from "@/extensions/types";
import { V2_VARIANT, buildFragmentShader } from "./shaders";
import { buildStageInjection } from "./stage-injection";
import { LEGACY_EXTENSION_STAGES, V1_IDENTITY_PIPELINES, normalizeGlsl } from "./v1-identity.fixtures";
import { builtinStages } from "./webgl.test-support";

const amount = (key: string) => [{ key, glslType: "float" as const, default: 0 }];
const copyPass = [{ glsl: "c = readPrev(vUv);" }];

const SPACED_STAGES: ProcessingStageContribution[] = [
  {
    id: "spaced.wide", name: "Wide", phase: "scene-linear",
    space: { encoding: "linear", primaries: "rec2020" },
    glsl: "lin *= 1.0 + wideGain;", uniforms: amount("wideGain"),
  },
  {
    id: "spaced.wideToo", name: "Wide too", phase: "scene-linear", priority: 110,
    space: { encoding: "linear", primaries: "rec2020" },
    glsl: "lin *= 1.0 + wideTooGain;", uniforms: amount("wideTooGain"),
  },
  {
    id: "spaced.curve", name: "Curve", phase: "tone-map", space: { encoding: "perceptual" },
    glsl: "lin = mix(lin, lin * lin, curveAmount);", uniforms: amount("curveAmount"),
  },
  {
    id: "spaced.displayWide", name: "Display wide", phase: "display-adjust",
    space: { encoding: "linear", primaries: "rec2020" },
    glsl: "c *= 1.0 + displayWideGain;", uniforms: amount("displayWideGain"),
  },
  {
    id: "spaced.grade", name: "Grade", phase: "effects",
    space: { encoding: "perceptual", primaries: "rec2020" },
    glsl: "c += gradeLift;", uniforms: amount("gradeLift"),
  },
  {
    id: "spaced.out", name: "Out", phase: "output-encode", space: { encoding: "linear" },
    glsl: "c *= 1.0 - outDim;", uniforms: amount("outDim"),
  },
];

const SPLIT_STAGES: ProcessingStageContribution[] = [
  {
    id: "split.decode", name: "Decode split", phase: "decode", reads: "current",
    glsl: "lin = mix(lin, stageResult, decodeMix);", uniforms: amount("decodeMix"), passes: copyPass,
  },
  {
    id: "split.scene", name: "Scene split", phase: "scene-linear", reads: "current",
    glsl: "lin = mix(lin, stageResult, sceneMix);", uniforms: amount("sceneMix"), passes: copyPass,
  },
  {
    id: "split.display", name: "Display split", phase: "display-adjust", reads: "current",
    space: { encoding: "perceptual" },
    glsl: "c = mix(c, stageResult, displayMix);", uniforms: amount("displayMix"), passes: copyPass,
  },
  {
    id: "split.effects", name: "Effects split", phase: "effects", reads: "current",
    glsl: "c = mix(c, stageResult, effectsMix);", uniforms: amount("effectsMix"), passes: copyPass,
  },
];

const SCENE_LUMA_STAGE: ProcessingStageContribution = {
  id: "luma.reader", name: "Luma reader", phase: "display-adjust", space: { encoding: "perceptual" },
  glsl: "c *= slSceneLuma > 1.0 ? 1.0 - lumaDim : 1.0;", uniforms: amount("lumaDim"),
};

const LAYERED_STAGES: ProcessingStageContribution[] = ["A", "B", "C"].map((k) => ({
  id: `layered.${k}`, name: `Layered ${k}`, phase: "decode",
  glsl: `lin = mix(lin, stageResult, layered${k});`, uniforms: amount(`layered${k}`), passes: copyPass,
}));

interface Config {
  stages: () => ProcessingStageContribution[];
  samplerBudget?: number;
}

export const V2_IDENTITY_CONFIGS: Record<string, Config> = {
  builtin: { stages: () => builtinStages() },
  legacyExtensions: { stages: () => [...builtinStages(), ...LEGACY_EXTENSION_STAGES] },
  spaced: { stages: () => [...builtinStages(), ...SPACED_STAGES] },
  splits: { stages: () => [...builtinStages(), ...SPLIT_STAGES] },
  sceneLuma: { stages: () => [...builtinStages(), SCENE_LUMA_STAGE] },
  layered: { stages: () => [...builtinStages(), ...LAYERED_STAGES], samplerBudget: 2 },
};

export const V2_IDENTITY_PIPELINES: Record<string, string | null> = {
  ...V1_IDENTITY_PIPELINES,
  rec2020:
    "vec3 pipelineToDisplay(vec3 lin) { return slEncodePerceptual(SL_REC2020_TO_REC709 * max(SL_REC709_TO_REC2020 * lin, 0.0)); }",
};

const GLSL_KEYS = ["uniforms", "helpers", "srcUv", "noiseReduction", "sceneLinear", "effects"] as const;

/** JSON with object keys sorted, so a hash doesn't depend on the order the
 *  injector builds its objects in. Arrays keep theirs. */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

/** Every frozen piece, keyed `config/part`: normalized GLSL, or JSON for what
 *  the renderer drives that GLSL with. The test hashes these; run this on the
 *  commit that adds this file to see the text a hash stands for. */
export function v2Snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, config] of Object.entries(V2_IDENTITY_CONFIGS)) {
    const built = buildStageInjection(config.stages(), V2_VARIANT, config.samplerBudget);
    const { uniforms, helpers, srcUv, noiseReduction, sceneLinear, effects, ...injectionMeta } = built.injection;
    for (const key of GLSL_KEYS) out[`${name}/${key}`] = normalizeGlsl(built.injection[key]);
    out[`${name}/meta`] = stableStringify({
      injectionMeta,
      bindings: built.bindings,
      textureBindings: built.textureBindings,
      hasNoiseReduction: built.hasNoiseReduction,
      prepass: built.prepass.map(({ passes, ...stage }) => ({
        ...stage,
        passes: passes.map(({ fragmentSource, ...pass }) => ({ ...pass, fragmentSource: normalizeGlsl(fragmentSource) })),
      })),
    });
    for (const [pipeline, glsl] of Object.entries(V2_IDENTITY_PIPELINES)) {
      out[`${name}/shader/${pipeline}`] = normalizeGlsl(buildFragmentShader(glsl, built.injection, V2_VARIANT));
    }
  }
  return out;
}
