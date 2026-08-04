// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every develop program the app can assemble, compiled and linked against a
// real driver. A GLSL error in any of these surfaces only at runtime, on a
// user's machine, as a black or frozen view — so this file enumerates the
// pipeline × contributed-stage matrix rather than sampling it.

import { describe, expect, it } from "vitest";
import {
  PROCESSING_PHASE_ORDER,
  type GlslType,
  type ProcessingPhase,
  type ProcessingStageContribution,
} from "@/extensions/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import {
  DEFAULT_PIPELINE_GLSL,
  VERTEX_SHADER,
  buildFragmentShader,
  type StageInjection,
} from "./shaders";
import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import {
  buildProgram,
  builtinStage,
  builtinStages,
  glHarness,
  releaseProgram,
  rendererBuildError,
} from "./webgl.test-support";

const EMPTY_INJECTION: StageInjection = {
  uniforms: "",
  helpers: "",
  srcUv: "",
  noiseReduction: "",
  sceneLinear: "",
  effects: "",
};

/** A replacement display transform of the shape an extension ships (Advanced
 *  Rendering's AgX and friends): its own shoulder, and it owns the baseline. */
const REPLACEMENT_PIPELINE: ResolvedPipeline = {
  id: "test.filmic",
  glsl: `vec3 pipelineToDisplay(vec3 lin) {
  vec3 x = max(lin, 0.0);
  return linearToSrgbU(x / (x + 0.155) * 1.019);
}`,
  skipBaseCurve: true,
  sig: "test.filmic",
};

/** The working value each injection marker sits next to. A stage routed to the
 *  wrong group would touch a variable that isn't in scope there, so the
 *  phase → variable mapping is part of what these programs prove. */
const PHASE_BODY: Record<ProcessingPhase, string> = {
  geometry: "srcUv = clamp(srcUv + vec2(amount * 0.0), 0.0, 1.0);",
  decode: "lin = max(lin * (1.0 + amount * 0.0), 0.0);",
  "noise-reduction": "lin = max(lin * (1.0 + amount * 0.0), 0.0);",
  "scene-linear": "lin *= 1.0 + amount * 0.0;",
  "tone-map": "lin = min(lin, vec3(64.0)) * (1.0 + amount * 0.0);",
  "display-adjust": "c = clamp(c * (1.0 + amount * 0.0), 0.0, 1.0);",
  effects: "c = clamp(c + vec3(vUv.x) * amount * 0.0, 0.0, 1.0);",
  "output-encode": "c = clamp(c * (1.0 + amount * 0.0), 0.0, 1.0);",
};

function stageForPhase(phase: ProcessingPhase): ProcessingStageContribution {
  return {
    id: `test.${phase}`,
    name: phase,
    phase,
    glsl: PHASE_BODY[phase],
    uniforms: [{ key: "amount", glslType: "float", default: 0 }],
  };
}

const EVERY_GLSL_TYPE: { key: string; glslType: GlslType; default: number | number[] | boolean }[] = [
  { key: "fAmt", glslType: "float", default: 1 },
  { key: "iAmt", glslType: "int", default: 1 },
  { key: "bFlag", glslType: "bool", default: true },
  { key: "v2", glslType: "vec2", default: [0, 0] },
  { key: "v3", glslType: "vec3", default: [0, 0, 0] },
  { key: "v4", glslType: "vec4", default: [0, 0, 0, 0] },
  { key: "iv2", glslType: "ivec2", default: [0, 0] },
  { key: "iv3", glslType: "ivec3", default: [0, 0, 0] },
  { key: "iv4", glslType: "ivec4", default: [0, 0, 0, 0] },
  { key: "m3", glslType: "mat3", default: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  { key: "m4", glslType: "mat4", default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  { key: "samp", glslType: "sampler2D", default: 0 },
];

const EVERY_TYPE_STAGE: ProcessingStageContribution = {
  id: "test.every-type",
  name: "Every uniform type",
  phase: "effects",
  uniforms: EVERY_GLSL_TYPE,
  helpers: `vec3 scaleBy(vec3 col) { return col * fAmt; }`,
  glsl: `c = scaleBy(c);
if (bFlag) c += vec3(float(iAmt)) * 0.0;
c.xy += v2 * 0.0;
c += v3 * 0.0 + v4.rgb * 0.0;
c += vec3(float(iv2.x + iv3.y + iv4.z)) * 0.0;
c += (m3 * c) * 0.0 + (m4 * vec4(c, 1.0)).rgb * 0.0;
c += texture(samp, vUv).rgb * 0.0;`,
};

const TEXTURE_STAGE: ProcessingStageContribution = {
  id: "test.lut",
  name: "LUT",
  phase: "display-adjust",
  glsl: `c = mix(c, texture(lut, vec2(luma(c), 0.5)).rgb, strength * 0.0);`,
  uniforms: [{ key: "strength", glslType: "float", default: 0 }],
  textures: [{ key: "lut", kind: "lut", format: "rgba8" }],
};

const PREPASS_STAGE: ProcessingStageContribution = {
  id: "test.blur",
  name: "Prepass blur",
  phase: "scene-linear",
  glsl: `lin = mix(lin, stageResult, radius * 0.0);`,
  uniforms: [{ key: "radius", glslType: "float", default: 0 }],
  passes: [
    {
      glsl: `c = mix(c, readPrev(vUv + uTexel * radius), 0.5);`,
      iterations: 2,
      uniforms: [{ key: "radius", glslType: "float", default: 1 }],
    },
  ],
};

/** Two stages that pick the same uniform key and the same helper name. Without
 *  per-stage namespacing the second declaration is a GLSL redefinition error. */
const COLLIDING_STAGES: ProcessingStageContribution[] = ["test.first", "test.second"].map(
  (id) => ({
    id,
    name: id,
    phase: "effects",
    glsl: `c = boost(c, amount);`,
    helpers: `vec3 boost(vec3 col, float amt) { return col * (1.0 + amt * 0.0); }`,
    uniforms: [{ key: "amount", glslType: "float", default: 0 }],
  }),
);

/** An extension noise-reduction stage: registering one makes buildStageInjection
 *  drop the built-in denoiser, which is its own program variant. */
const EXTENSION_NR_STAGE: ProcessingStageContribution = {
  id: "acme.denoise",
  name: "Acme denoise",
  phase: "noise-reduction",
  glsl: `lin = mix(lin, max(lin, 0.0), strength * 0.0);`,
  uniforms: [{ key: "strength", glslType: "float", default: 0 }],
};

function expectCompiles(fragmentSource: string): void {
  const { gl } = glHarness();
  const build = buildProgram(gl, VERTEX_SHADER, fragmentSource);
  expect(build.error).toBeNull();
  releaseProgram(gl, build);
}

describe("develop fragment shader assembly", () => {
  it("compiles the built-in pipeline with no contributed stages", () => {
    expectCompiles(buildFragmentShader());
  });

  it("compiles the stock transform spliced in explicitly", () => {
    expectCompiles(buildFragmentShader(DEFAULT_PIPELINE_GLSL, EMPTY_INJECTION));
  });

  it("compiles a replacement display transform", () => {
    expectCompiles(buildFragmentShader(REPLACEMENT_PIPELINE.glsl, EMPTY_INJECTION));
  });

  // Each marker is spliced into a different scope, so a block that is valid at
  // one is not necessarily valid at another.
  const MARKERS: { marker: keyof StageInjection; glsl: string }[] = [
    { marker: "uniforms", glsl: "uniform float uTestMarker;" },
    { marker: "helpers", glsl: "vec3 markerHelper(vec3 col) { return col; }" },
    { marker: "srcUv", glsl: "{ srcUv = clamp(srcUv + sensorUv * 0.0, 0.0, 1.0); }" },
    { marker: "noiseReduction", glsl: "{ lin = max(lin, 0.0) + vec3(rawLuma) * 0.0; }" },
    { marker: "sceneLinear", glsl: "{ lin *= 1.0 + refT * 0.0; }" },
    { marker: "effects", glsl: "{ c = clamp(c + vUv.xyx * 0.0, 0.0, 1.0); }" },
  ];
  for (const { marker, glsl } of MARKERS) {
    it(`compiles a block spliced at the ${marker} marker`, () => {
      expectCompiles(buildFragmentShader(null, { ...EMPTY_INJECTION, [marker]: glsl }));
    });
  }
});

describe("shipped stage sets", () => {
  it("registers the three stages the app ships", () => {
    expect(builtinStages().map((s) => s.id)).toEqual([
      "core.vignette",
      "core.grain",
      BUILTIN_DENOISE_ID,
    ]);
  });

  for (const id of ["core.vignette", "core.grain", BUILTIN_DENOISE_ID]) {
    it(`links the program carrying ${id} alone`, () => {
      expect(rendererBuildError({ stages: [builtinStage(id)] })).toBeNull();
    });
  }

  it("links the program carrying every shipped stage", () => {
    expect(rendererBuildError({ stages: builtinStages() })).toBeNull();
  });

  it("links the shipped stages under a replacement display transform", () => {
    expect(
      rendererBuildError({ stages: builtinStages(), pipeline: REPLACEMENT_PIPELINE }),
    ).toBeNull();
  });

  it("links with no stages at all", () => {
    expect(rendererBuildError({ stages: [], pipeline: BUILTIN_RESOLVED })).toBeNull();
  });
});

describe("contributed stage permutations", () => {
  for (const phase of PROCESSING_PHASE_ORDER) {
    it(`links a stage contributed to the ${phase} phase`, () => {
      expect(rendererBuildError({ stages: [stageForPhase(phase)] })).toBeNull();
    });
  }

  it("links one stage per phase at once", () => {
    expect(
      rendererBuildError({ stages: PROCESSING_PHASE_ORDER.map(stageForPhase) }),
    ).toBeNull();
  });

  it("links a stage declaring every uniform type", () => {
    expect(rendererBuildError({ stages: [EVERY_TYPE_STAGE] })).toBeNull();
  });

  it("links a stage declaring a texture", () => {
    expect(rendererBuildError({ stages: [TEXTURE_STAGE] })).toBeNull();
  });

  it("links a stage carrying prepasses", () => {
    expect(rendererBuildError({ stages: [PREPASS_STAGE] })).toBeNull();
  });

  it("links two stages that share uniform and helper names", () => {
    expect(rendererBuildError({ stages: COLLIDING_STAGES })).toBeNull();
  });

  it("links an extension denoiser replacing the built-in one", () => {
    expect(
      rendererBuildError({
        stages: [builtinStage(BUILTIN_DENOISE_ID), EXTENSION_NR_STAGE],
      }),
    ).toBeNull();
  });

  it("links the shipped stages alongside extension stages", () => {
    expect(
      rendererBuildError({
        stages: [...builtinStages(), TEXTURE_STAGE, PREPASS_STAGE, ...COLLIDING_STAGES],
        pipeline: REPLACEMENT_PIPELINE,
      }),
    ).toBeNull();
  });
});
