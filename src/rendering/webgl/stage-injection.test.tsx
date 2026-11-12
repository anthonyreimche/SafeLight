// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The program cache is keyed on the injection signature, and an unchanged
// signature skips refreshing the bindings and prepass state too, so anything
// about a stage that reaches the compiled program or those bindings must change
// it. A stage that swapped only its helpers (Spektrafilm's per-stock constants)
// used to keep running the first program it compiled.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROCESSING_PHASE_ORDER,
  type ProcessingPhase,
  type ProcessingStageContribution,
  type StagePass,
  type StageSpace,
  type UniformDeclaration,
} from "@/extensions/types";
import { BUILTIN_DENOISE_ID, DENOISE_STAGE } from "./builtin-denoise";
import { uniformPrefix } from "./shader-compiler";
import { simpleHash } from "./hash";
import { V1_VARIANT, V2_VARIANT, V3_VARIANT, type ShaderVariant } from "./shaders";
import { PHASES, buildStageInjection, stageSignature } from "./stage-injection";
import { essentialStages } from "./essential-stages.fixtures";
import { LOCAL_TONE_GLSL } from "../local-tone";

const AMOUNT: UniformDeclaration = { key: "amount", glslType: "float", default: 0 };
const PASS: StagePass = { glsl: "c = readPrev(vUv);", helpers: "float passWeight() { return 1.0; }" };

const STAGE: ProcessingStageContribution = {
  id: "acme.look",
  name: "Look",
  phase: "scene-linear",
  glsl: "lin = lookScale(lin, amount);",
  helpers: "vec3 lookScale(vec3 c, float a) { return c * (1.0 + a); }",
  uniforms: [AMOUNT],
  passes: [PASS],
};

const CORE: ProcessingStageContribution = {
  id: "core.look",
  name: "Core look",
  phase: "scene-linear",
  glsl: "lin = coreScale(lin);",
  helpers: "vec3 coreScale(vec3 c) { return c * 2.0; }",
  uniforms: [],
};

const sig = (s: ProcessingStageContribution) => buildStageInjection([s]).sig;

describe("stage signature", () => {
  it("stays put for an identical copy", () => {
    expect(sig({ ...STAGE })).toBe(sig(STAGE));
  });

  const changes: [string, ProcessingStageContribution][] = [
    ["glsl", { ...STAGE, glsl: "lin = lookScale(lin, amount * 2.0);" }],
    ["helpers", { ...STAGE, helpers: "vec3 lookScale(vec3 c, float a) { return c * (2.0 + a); }" }],
    ["a uniform's type", { ...STAGE, uniforms: [{ ...AMOUNT, glslType: "int" }] }],
    ["a uniform's default", { ...STAGE, uniforms: [{ ...AMOUNT, default: 0.5 }] }],
    ["the texture set", { ...STAGE, textures: [{ key: "ramp", kind: "lut" }] }],
    ["phase", { ...STAGE, phase: "tone-map" }],
    ["priority", { ...STAGE, priority: 10 }],
    ["a pass's glsl", { ...STAGE, passes: [{ ...PASS, glsl: "c = readPrev(vUv) * 0.5;" }] }],
    ["a pass's helpers", { ...STAGE, passes: [{ ...PASS, helpers: "float passWeight() { return 2.0; }" }] }],
    ["a pass's iterations", { ...STAGE, passes: [{ ...PASS, iterations: 3 }] }],
    ["space", { ...STAGE, space: { encoding: "linear", primaries: "rec2020" } }],
    ["reads", { ...STAGE, reads: "current" }],
  ];
  for (const [what, changed] of changes) {
    it(`changes when only ${what} changes`, () => {
      expect(sig(changed)).not.toBe(sig(STAGE));
    });
  }

  // Pass programs are keyed on the signature and are the same for every
  // version; the renderer keys the develop program on the version itself.
  it("stays put across process versions, even where their injections differ", () => {
    const legacy: ProcessingStageContribution = {
      id: "acme.legacy",
      name: "Legacy",
      phase: "effects",
      glsl: "c *= 0.5;",
      uniforms: [],
      passes: [PASS],
    };
    const v1 = buildStageInjection([legacy], V1_VARIANT);
    const v2 = buildStageInjection([legacy], V2_VARIANT);
    expect(v2.injection.effects).not.toBe(v1.injection.effects);
    expect(v2.sig).toBe(v1.sig);
  });

  describe("for a core stage", () => {
    it("stays put for an identical copy", () => {
      expect(sig({ ...CORE })).toBe(sig(CORE));
    });

    it("changes when only helpers change", () => {
      expect(sig({ ...CORE, helpers: "vec3 coreScale(vec3 c) { return c * 3.0; }" })).not.toBe(sig(CORE));
    });
  });
});

// A stage that declares `space` gets its variable converted in ahead of its
// block and back out after it. On version 2 nothing upstream clips display
// values, so an extension stage that declared nothing gets them clipped.

const flagged = (over: Partial<ProcessingStageContribution>): ProcessingStageContribution => ({
  id: "acme.flagged",
  name: "Flagged",
  phase: "scene-linear",
  glsl: "lin *= 1.0;",
  uniforms: [],
  ...over,
});

/** The snippets in the order they appear in `glsl`; each must appear once. */
function inOrder(glsl: string, snippets: readonly string[]): string[] {
  for (const s of snippets) expect(glsl.split(s).length - 1, s).toBe(1);
  return [...snippets].sort((a, b) => glsl.indexOf(a) - glsl.indexOf(b));
}

describe("space wrappers", () => {
  it("wraps a stage that declares a space, and only that stage", () => {
    const { injection } = buildStageInjection([
      flagged({ space: { encoding: "linear", primaries: "rec2020" }, glsl: "lin *= 2.0;" }),
      flagged({ id: "acme.plain", priority: 200, glsl: "lin *= 3.0;" }),
    ]);
    const order = [
      "lin = (SL_REC709_TO_REC2020 * lin);",
      "lin *= 2.0;",
      "lin = (SL_REC2020_TO_REC709 * lin);",
      "lin *= 3.0;",
    ];
    expect(inOrder(injection.sceneLinear, order)).toEqual(order);
    expect(injection.needsSpaceHelpers).toBe(true);
  });

  it("converts back before clipping ahead of a legacy display stage", () => {
    const linear = flagged({
      id: "acme.linear",
      phase: "effects",
      priority: 10,
      space: { encoding: "linear" },
      glsl: "c *= 2.0;",
    });
    const legacy = flagged({
      id: "acme.legacy",
      phase: "effects",
      priority: 20,
      glsl: "c *= 3.0;",
    });
    const { injection } = buildStageInjection([linear, legacy], V2_VARIANT);
    const order = [
      "c = slDecodePerceptual(c);",
      "c *= 2.0;",
      "c = slEncodePerceptual(c);",
      "c = clamp(c, 0.0, 1.0);",
      "c *= 3.0;",
    ];
    expect(inOrder(injection.effects, order)).toEqual(order);
  });

  it("converts once for adjacent stages that share a space", () => {
    const wide = { encoding: "linear" as const, primaries: "rec2020" as const };
    const { injection } = buildStageInjection([
      flagged({ id: "acme.a", priority: 10, space: wide }),
      flagged({ id: "acme.b", priority: 20, space: wide }),
    ]);
    expect(injection.sceneLinear.split("SL_REC709_TO_REC2020").length - 1).toBe(1);
    expect(injection.sceneLinear.split("SL_REC2020_TO_REC709").length - 1).toBe(1);
  });

  // The last stage of a group has no successor to convert out of its space, so
  // the end of the group hands the variable back to working values.
  const LAST_STAGES: {
    group: "noiseReduction" | "sceneLinear" | "effects";
    phase: ProcessingPhase;
    space: StageSpace;
    glsl: string;
    order: string[];
  }[] = [
    {
      group: "noiseReduction",
      phase: "decode",
      space: { encoding: "linear", primaries: "rec2020" },
      glsl: "lin *= 2.0;",
      order: [
        "lin = (SL_REC709_TO_REC2020 * lin);",
        "lin *= 2.0;",
        "lin = (SL_REC2020_TO_REC709 * lin);",
      ],
    },
    {
      group: "sceneLinear",
      phase: "tone-map",
      space: { encoding: "linear", primaries: "rec2020" },
      glsl: "lin *= 2.0;",
      order: [
        "lin = (SL_REC709_TO_REC2020 * lin);",
        "lin *= 2.0;",
        "lin = (SL_REC2020_TO_REC709 * lin);",
      ],
    },
    {
      group: "effects",
      phase: "effects",
      space: { encoding: "linear" },
      glsl: "c *= 2.0;",
      order: ["c = slDecodePerceptual(c);", "c *= 2.0;", "c = slEncodePerceptual(c);"],
    },
  ];
  for (const { group, phase, space, glsl, order } of LAST_STAGES) {
    it(`hands the ${group} group back to working values after its last stage`, () => {
      const { injection } = buildStageInjection([flagged({ phase, space, glsl })]);
      expect(inOrder(injection[group], order)).toEqual(order);
    });
  }

  it("emits nothing for a space that is the working space", () => {
    const { injection } = buildStageInjection([flagged({ space: { encoding: "linear" } })]);
    expect(injection.sceneLinear).not.toContain("SL_");
    expect(injection.needsSpaceHelpers).toBe(false);
  });

  it("clips ahead of a legacy display stage on version 2 only", () => {
    const legacy = flagged({ id: "acme.legacy", phase: "effects", glsl: "c *= 1.0;" });
    const clip = "c = clamp(c, 0.0, 1.0);";
    expect(buildStageInjection([legacy], V2_VARIANT).injection.effects).toContain(clip);
    expect(buildStageInjection([legacy], V1_VARIANT).injection.effects).not.toContain(clip);
    const declared = { ...legacy, space: { encoding: "perceptual" as const } };
    expect(buildStageInjection([declared], V2_VARIANT).injection.effects).not.toContain(clip);
  });

  it("never clips ahead of a core or official stage", () => {
    const core = flagged({ id: "core.vignette", phase: "effects", glsl: "c = c;" });
    expect(buildStageInjection([core], V2_VARIANT).injection.effects).not.toContain("clamp");
    expect(buildStageInjection(essentialStages(3), V2_VARIANT).injection.effects).not.toContain("clamp");
  });

  it("feeds a declaring stage's passes the source in its space", () => {
    const { prepass } = buildStageInjection([
      flagged({ space: { encoding: "perceptual" }, passes: [{ glsl: "c = readPrev(vUv);" }] }),
    ]);
    expect(prepass[0].passes[0].fragmentSource).toContain(
      "return uPrevRaw ? slEncodePerceptual(toLin(s)) : s;",
    );
  });
});

// Names core's own program reads that a tool's stage declares (local tone reads
// White Balance's sliders, main() Basic's presence sliders and Detail's
// sharpening preview, version 2's scene luma the tone block's shoulder gain). While no stage declares one, the
// injection stands in its neutral value, so the program compiles and reads the
// tool as off.
describe("name fallbacks", () => {
  const FALLBACKS = ["#define uTemperature uAsShotTemperature", "#define uTint 0.0"];
  const PRESENCE = ["#define uTexture 0.0", "#define uClarity 0.0", "#define uDehaze 0.0"];
  const SHOULDER = "#define slShoulderGain 1.0";
  const VIZ = "#define sharpenViz 0.0";
  const GEOMETRY = "#define cropTransformUV(o) (o)";
  const VARIANT_OF: Record<1 | 2 | 3, ShaderVariant> = { 1: V1_VARIANT, 2: V2_VARIANT, 3: V3_VARIANT };
  const uniformsOf = (stages: ProcessingStageContribution[], variant = V3_VARIANT) =>
    buildStageInjection(stages, variant).injection.uniforms;

  it("stand in White Balance's, Basic's, Detail's and Crop's names while no stage declares them", () => {
    const uniforms = uniformsOf([]);
    for (const line of [...FALLBACKS, ...PRESENCE, SHOULDER, VIZ, GEOMETRY]) expect(uniforms).toContain(line);
  });

  it("leave the shoulder gain out of a version 1 program, which never reads it", () => {
    const uniforms = uniformsOf([], V1_VARIANT);
    expect(uniforms).not.toContain(SHOULDER);
    for (const line of [...PRESENCE, VIZ]) expect(uniforms).toContain(line);
  });

  it.each([1, 2, 3] as const)("stand aside for the stages of line %i that declare them", (line) => {
    const uniforms = uniformsOf(essentialStages(line), VARIANT_OF[line]);
    for (const l of [...FALLBACKS, ...PRESENCE, SHOULDER, VIZ, GEOMETRY]) expect(uniforms).not.toContain(l);
    expect(uniforms).toContain("uniform float uTemperature;");
    expect(uniforms).toContain("uniform float uTexture;");
  });

  // Crop's geometry function is a helper of its stage: the official stage's
  // helpers declare it, an extension's (namespaced) helpers don't.
  it("count an official stage's helpers as declaring a function, not an extension's", () => {
    const helper = "vec2 cropTransformUV(vec2 o) { return o; }";
    const official = { ...flagged({ id: "safelight.crop.geometry", glsl: "", helpers: helper, anchor: "geometry" }), extensionId: "safelight.crop" };
    expect(uniformsOf([official])).not.toContain(GEOMETRY);
    expect(uniformsOf([flagged({ helpers: helper })])).toContain(GEOMETRY);
  });

  it("stand in for a name an extension's stage only prefixes, or declares in its own scope", () => {
    const own = flagged({
      id: "acme.warm",
      phase: "scene-linear",
      glsl: "float slShoulderGain = 2.0;",
      uniforms: [{ key: "uTemperature", glslType: "float", default: 0 }],
    });
    const uniforms = uniformsOf([own]);
    expect(uniforms).toContain(FALLBACKS[0]);
    expect(uniforms).toContain(SHOULDER);
  });
});

// An installed release renders every photo with its one text, so a later line
// runs in a version 1 program too. Basic's line 2 and 3 tone block calls the
// local tone curves only version 2's template declares: a version 1 program
// that carries it gets them, with no camera refit, gain or shadows lift, as
// version 1 has none.
describe("version 2 helpers in a version 1 program", () => {
  const V1_DEFINES = ["#define slBaselineRefit(x) (x)", "#define uBaselineGain 1.0", "#define uBaselineShadows 0.0"];
  const built = (line: 1 | 2 | 3, variant: ShaderVariant) => buildStageInjection(essentialStages(line), variant).injection;

  it.each([2, 3] as const)("come with line %i's tone block", (line) => {
    const { uniforms, helpers } = built(line, V1_VARIANT);
    for (const define of V1_DEFINES) expect(uniforms).toContain(define);
    expect(helpers).toContain(LOCAL_TONE_GLSL);
  });

  it("stay out of a version 1 program with line 1, whose text is frozen", () => {
    const { uniforms, helpers } = built(1, V1_VARIANT);
    for (const define of V1_DEFINES) expect(uniforms).not.toContain(define);
    expect(helpers).not.toContain("slToneHighlights");
  });

  it("stay out of a version 2 or 3 program, whose template has them", () => {
    for (const variant of [V2_VARIANT, V3_VARIANT]) {
      const { uniforms, helpers } = built(3, variant);
      for (const define of V1_DEFINES) expect(uniforms).not.toContain(define);
      expect(helpers).not.toContain("slToneHighlights");
    }
  });
});

// A release carries one text (one per process version it was written for), so
// the injection emits an official stage's helpers as written under every
// version: Effects of line 1 keeps the clamp that closes its helpers, line 3
// ends them in `return c;`.

describe("an official stage's helpers", () => {
  const CLAMP = "return clamp(c, 0.0, 1.0);";
  const helpersOf = (stages: ProcessingStageContribution[], variant: ShaderVariant): string =>
    buildStageInjection(stages, variant).injection.helpers;

  it.each([1, 3] as const)("are emitted as written, line %i under every version", (line) => {
    const stages = essentialStages(line);
    for (const variant of [V1_VARIANT, V2_VARIANT, V3_VARIANT]) {
      const helpers = helpersOf(stages, variant);
      for (const stage of stages) if (stage.helpers) expect(helpers).toContain(stage.helpers);
    }
  });

  it("keep Effects' closing clamp on line 1 only", () => {
    const effects = (line: 1 | 3) => essentialStages(line).filter((s) => s.extensionId === "safelight.effects");
    expect(effects(1).every((s) => s.helpers?.includes(CLAMP))).toBe(true);
    expect(effects(3).some((s) => s.helpers?.includes(CLAMP))).toBe(false);
  });
});

// A pass reads the decoded source with readSource whatever the stage reads,
// converted as a source reader's first read is. Only a pass that names it gets
// the sampler, so every other pass program keeps its text.
describe("readSource in a pass", () => {
  it("is declared only where a pass names it", () => {
    const { prepass } = buildStageInjection([
      flagged({ reads: "current", passes: [{ glsl: "c = readPrev(vUv);" }, { glsl: "c = readSource(vUv);" }] }),
    ]);
    const [plain, reader] = prepass[0].passes.map((p) => p.fragmentSource);
    expect(plain).not.toContain("uSourceImage");
    expect(plain).not.toContain("readSource");
    expect(reader).toContain("uniform sampler2D uSourceImage;");
    expect(reader).toContain("vec3 readSource(vec2 uv) {");
  });

  it("is declared for a helper that names it", () => {
    const { prepass } = buildStageInjection([
      flagged({ passes: [{ glsl: "c = srcAt(vUv);", helpers: "vec3 srcAt(vec2 uv) { return readSource(uv); }" }] }),
    ]);
    expect(prepass[0].passes[0].fragmentSource).toContain("uniform sampler2D uSourceImage;");
  });

  it("converts the source into the stage's space, as the first read does", () => {
    const { prepass } = buildStageInjection([
      flagged({ reads: "current", space: { encoding: "perceptual" }, passes: [{ glsl: "c = readSource(vUv);" }] }),
    ]);
    expect(prepass[0].passes[0].fragmentSource).toContain("return slEncodePerceptual(toLin(texture(uSourceImage, uv).rgb));");
  });
});

// A four-channel pass mutates a vec4 c that starts as readPrev4(vUv) and is
// written whole, so its alpha carries state to the next draw. Every other pass
// keeps the vec3 program text the version 1 freeze pins.
describe("a four-channel pass", () => {
  const passesOf = (channels?: 3 | 4) =>
    buildStageInjection([flagged({ passes: [{ glsl: "c.a = 0.5;", ...(channels ? { channels } : {}) }] })]).prepass[0]
      .passes[0].fragmentSource;

  it("mutates a vec4 and writes it whole", () => {
    const source = passesOf(4);
    expect(source).toContain("vec4 readPrev4(vec2 uv) {");
    expect(source).toContain("vec4 fetchPrev4(ivec2 texel) {");
    expect(source).toContain("vec4 c = fetchPrev4(ivec2(gl_FragCoord.xy));");
    expect(source).toContain("fragColor = c;");
    expect(source).not.toContain("fragColor = vec4(c, 1.0);");
  });

  it("leaves a three-channel pass as it was", () => {
    expect(passesOf(3)).toBe(passesOf());
    expect(passesOf()).not.toContain("readPrev4");
    expect(passesOf()).toContain("fragColor = vec4(c, 1.0);");
  });
});

// ANGLE on D3D11 marks every `if` around a loop that reaches an implicit-
// derivative op [flatten], so a pass that calls fetchPrev4 in a loop ran every
// branch on every draw. The helpers a four-channel pass gets reach none: they
// read with texelFetch, or textureGrad with the pass texel as the gradient.
describe("the helpers a four-channel pass gets", () => {
  const GRADIENT_OP = /\b(?:texture|textureProj|textureOffset|textureProjOffset|dFdx|dFdy|fwidth)\s*\(/;
  const SAMPLING_OP = /\btexture\w*\s*\(|\btexelFetch\w*\s*\(/g;
  const ALLOWED_SAMPLING = new Set(["texelFetch", "textureGrad", "textureLod", "textureSize"]);

  /** Every function the source defines, by name, with its body. */
  function functionsOf(source: string): Map<string, string> {
    const out = new Map<string, string>();
    const head = /\b(?:void|float|int|bool|[iu]?vec[234]|mat[234])\s+(\w+)\s*\([^)]*\)\s*\{/g;
    for (let m = head.exec(source); m; m = head.exec(source)) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < source.length && depth > 0; i++) depth += source[i] === "{" ? 1 : source[i] === "}" ? -1 : 0;
      out.set(m[1], source.slice(m.index + m[0].length, i - 1));
    }
    return out;
  }

  /** Whether `name`'s body, or any function it calls, has a gradient op. */
  function reachesGradient(fns: Map<string, string>, name: string, seen = new Set<string>()): boolean {
    const body = fns.get(name);
    if (body === undefined || seen.has(name)) return false;
    seen.add(name);
    if (GRADIENT_OP.test(body)) return true;
    return [...body.matchAll(/\b(\w+)\s*\(/g)].some(([, callee]) => callee !== name && reachesGradient(fns, callee, seen));
  }

  const sources = (space?: StageSpace) =>
    buildStageInjection([
      flagged({
        ...(space ? { space } : {}),
        passes: [{ channels: 4, glsl: "c.rgb += fetchInput(ivec2(gl_FragCoord.xy));" }, { channels: 4, glsl: "c.a = 0.5;" }],
      }),
    ]).prepass[0];

  it.each([undefined, { encoding: "perceptual" as const, primaries: "rec2020" as const }])(
    "reach no gradient op from the first draw's read (space %o)",
    (space) => {
      const built = sources(space);
      for (const source of [...built.passes.map((p) => p.fragmentSource), built.inputSource ?? ""]) {
        const fns = functionsOf(source);
        for (const helper of ["fetchPrev4", "readPrev4", "main"]) {
          expect(fns.has(helper), helper).toBe(true);
          expect(reachesGradient(fns, helper), helper).toBe(false);
        }
        if (fns.has("fetchInput")) expect(reachesGradient(fns, "fetchInput"), "fetchInput").toBe(false);
        for (const name of ["fetchPrev4", "readPrev4", "fetchInput"]) {
          for (const [op] of (fns.get(name) ?? "").matchAll(SAMPLING_OP)) {
            expect(ALLOWED_SAMPLING.has(op.replace(/\s*\($/, "")), `${name}: ${op}`).toBe(true);
          }
        }
      }
    },
  );

  it("take the pass texel as the gradient of the first draw's sample", () => {
    const [pass] = sources().passes;
    expect(pass.fragmentSource).toContain("textureGrad(uPrevPass, uv, vec2(uTexel.x, 0.0), vec2(0.0, uTexel.y))");
  });
});

// A pass that names its region gets a vertex program of its own, which places
// the draw's quad over that region; every other pass draws the whole frame with
// the shared one.
describe("a pass's region", () => {
  const pass = (over: Partial<StagePass>) =>
    buildStageInjection([
      flagged({
        passes: [
          {
            glsl: "c.a = edge;",
            helpers: "int widthOf(float e) { return int(e); }",
            uniforms: [{ key: "edge", glslType: "float", default: 4 }],
            channels: 4,
            ...over,
          },
        ],
      }),
    ]).prepass[0].passes[0];

  it("is drawn whole without one", () => {
    expect(pass({}).vertexSource).toBeUndefined();
  });

  it("is computed in the vertex program from the pass's uniforms and helpers", () => {
    const built = pass({ region: "return ivec4(0, 0, widthOf(edge), 1 << 20);" });
    const source = built.vertexSource ?? "";
    expect(source).toMatch(/^#version 300 es\n/);
    expect(source).toMatch(/ivec4 passRegion\(\) \{\s*return ivec4\(0, 0, _\w+_widthOf\(u_\w+_edge\), 1 << 20\);\s*\}/);
    expect(source).toMatch(/uniform float u_\w+_edge;/);
    expect(source).toContain("vec4 fetchPrev4(ivec2 texel) {");
    expect(source).toContain("uniform bool uWholeDraw;");
    expect(built.fragmentSource).toBe(pass({}).fragmentSource);
  });

  it("declares integers at the fragment program's precision, so shared uniforms link", () => {
    expect(pass({ region: "return ivec4(0);" }).vertexSource).toContain("precision mediump int;");
  });
});

// fetchInput reads the stage's input exactly, on any draw. Only a pass that
// names it gets its samplers and the flag, so every other pass program keeps
// its text, and only a stage with such a pass gets a program to draw its input.
describe("fetchInput in a pass", () => {
  const FETCH = "c = fetchInput(ivec2(gl_FragCoord.xy));";
  const PLAIN: StagePass = { glsl: "c = readPrev(vUv);" };
  const stageOf = (passes: StagePass[], over: Partial<ProcessingStageContribution> = {}) =>
    buildStageInjection([flagged({ passes, ...over })]).prepass[0];

  it("is declared only where a pass names it", () => {
    const [plain, fetcher] = stageOf([PLAIN, { glsl: FETCH }]).passes;
    expect(plain.fetchesInput).toBeUndefined();
    expect(plain.fragmentSource).not.toContain("fetchInput");
    expect(plain.fragmentSource).not.toContain("uInputImage");
    expect(plain.fragmentSource).not.toContain("uSourceImage");
    expect(fetcher.fetchesInput).toBe(true);
    expect(fetcher.fragmentSource).toContain("uniform sampler2D uSourceImage;");
    expect(fetcher.fragmentSource).toContain("uniform sampler2D uInputImage;");
    expect(fetcher.fragmentSource).toContain("uniform bool uInputIsSource;");
    expect(fetcher.fragmentSource).toContain("vec3 fetchInput(ivec2 texel) {");
  });

  it("leaves a pass that doesn't name it as it was", () => {
    expect(stageOf([PLAIN, { glsl: FETCH }]).passes[0].fragmentSource).toBe(stageOf([PLAIN]).passes[0].fragmentSource);
  });

  it("is declared for a helper that names it", () => {
    const helpers = "vec3 inputAt(ivec2 t) { return fetchInput(t); }";
    const [pass] = stageOf([{ glsl: "c = inputAt(ivec2(0));", helpers }]).passes;
    expect(pass.fetchesInput).toBe(true);
    expect(pass.fragmentSource).toContain("vec3 fetchInput(ivec2 texel) {");
  });

  it("shares the source sampler with readSource", () => {
    const [pass] = stageOf([{ glsl: `${FETCH} c += readSource(vUv);` }]).passes;
    expect(pass.fragmentSource.split("uniform sampler2D uSourceImage;").length - 1).toBe(1);
    expect(pass.fragmentSource).toContain("vec3 readSource(vec2 uv) {");
    expect(pass.fragmentSource).toContain("vec3 fetchInput(ivec2 texel) {");
  });

  it("converts the source into the stage's space, as the first read does", () => {
    const [pass] = stageOf([{ glsl: FETCH }], { space: { encoding: "perceptual" } }).passes;
    expect(pass.fragmentSource).toContain("slEncodePerceptual(toLin(texelFetch(uSourceImage,");
  });

  it("gives the stage a program that draws its input as its first draw reads it", () => {
    expect(stageOf([PLAIN]).inputSource).toBeUndefined();
    const three = stageOf([PLAIN, { glsl: FETCH }]).inputSource ?? "";
    expect(three).toContain("vec3 c = uPrevRaw ? readPrev(vUv)");
    expect(three).not.toContain("fetchInput");
    const four = stageOf([{ glsl: "c.a = 1.0;", channels: 4 }, { glsl: FETCH }]).inputSource ?? "";
    expect(four).toContain("vec4 c = fetchPrev4(ivec2(gl_FragCoord.xy));");
  });

  it("is declared in a region's vertex program too", () => {
    const [pass] = stageOf([{ glsl: FETCH, region: "return ivec4(0, 0, 4, 4);" }]).passes;
    expect(pass.vertexSource).toContain("vec3 fetchInput(ivec2 texel) {");
  });
});

// A kept pass reaches the runner as a flag on its pass; its program is the
// same as without it.
describe("a kept pass", () => {
  const stageOf = (keep?: boolean) =>
    buildStageInjection([
      flagged({ passes: [{ glsl: "c *= 2.0;", ...(keep === undefined ? {} : { keep }) }, { glsl: "c *= 3.0;" }] }),
    ]).prepass[0];

  it("carries keep to the runner", () => {
    expect(stageOf(true).passes.map((p) => p.keep)).toEqual([true, undefined]);
    expect(stageOf(false).passes.map((p) => p.keep)).toEqual([undefined, undefined]);
  });

  it("compiles as it would without it", () => {
    expect(stageOf(true).passes.map((p) => p.fragmentSource)).toEqual(stageOf().passes.map((p) => p.fragmentSource));
  });
});

// A stage that reads the current image from a later process version reads the
// source on older ones: no exit, no split, and a prepass keyed on the source.
describe("readsCurrentFrom", () => {
  const fromV2 = flagged({ reads: "current", readsCurrentFrom: 2, passes: [{ glsl: "c = readPrev(vUv);" }] });

  it("reads the source on an older version", () => {
    const { injection, prepass } = buildStageInjection([fromV2], V1_VARIANT);
    expect(injection.uniforms).not.toContain("uSplitAt");
    expect(injection.splitCount ?? 0).toBe(0);
    expect(prepass[0].split).toBeUndefined();
  });

  it("reads the current image from that version on", () => {
    for (const variant of [V2_VARIANT, V3_VARIANT]) {
      const { prepass } = buildStageInjection([fromV2], variant);
      expect(prepass[0].split).toEqual({ index: 0, cut: "scene", upstreamStageIds: [] });
    }
  });

  it("is part of the stage's signature", () => {
    expect(sig(fromV2)).not.toBe(sig({ ...fromV2, readsCurrentFrom: undefined }));
  });
});

describe("split exits", () => {
  const current = (over: Partial<ProcessingStageContribution>): ProcessingStageContribution =>
    flagged({ reads: "current", passes: [{ glsl: "c = readPrev(vUv);" }], ...over });

  it("adds nothing without a stage reading the current image", () => {
    const { injection, prepass } = buildStageInjection([
      flagged({ passes: [{ glsl: "c = c;" }] }),
    ]);
    expect(injection.uniforms).not.toContain("uSplitAt");
    expect(injection.splitCount ?? 0).toBe(0);
    expect(prepass[0].split).toBeUndefined();
  });

  it("stops the program at the stage's input", () => {
    const { injection, prepass } = buildStageInjection([current({})]);
    expect(injection.uniforms).toContain("uniform int uSplitAt;");
    expect(injection.splitCount).toBe(1);
    const exit = "if (uSplitAt == 0) { fragColor = vec4(lin, 1.0); return; }";
    const at = injection.sceneLinear.indexOf(exit);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(injection.sceneLinear.indexOf("lin *= 1.0;"));
    expect(prepass[0].split).toEqual({ index: 0, cut: "scene", upstreamStageIds: [] });
  });

  it("cuts decode and noise-reduction readers ahead of the core edits", () => {
    const { injection, prepass } = buildStageInjection([
      current({ id: "acme.decode", phase: "decode" }),
      current({ id: "acme.denoise", phase: "noise-reduction" }),
      current({ id: "acme.scene" }),
    ]);
    expect(prepass.map((p) => [p.stageId, p.split?.cut])).toEqual([
      ["acme.decode", "decode"],
      ["acme.denoise", "decode"],
      ["acme.scene", "scene"],
    ]);
    expect(injection.noiseReduction).toContain("if (uSplitAt == 1) { fragColor = vec4(lin, 1.0);");
  });

  it("writes the input in the stage's space", () => {
    const { injection } = buildStageInjection([
      current({ space: { encoding: "linear", primaries: "rec2020" } }),
    ]);
    expect(injection.sceneLinear).toContain("fragColor = vec4((SL_REC709_TO_REC2020 * lin), 1.0);");
  });

  it("puts an effects stage's split at the end of display-adjust", () => {
    const adjust = flagged({ id: "acme.adjust", phase: "display-adjust", glsl: "c *= 0.5;" });
    const vignette = flagged({
      id: "core.vignette",
      phase: "effects",
      priority: 50,
      glsl: "c = c;",
    });
    const effect = current({
      id: "acme.effect",
      phase: "effects",
      priority: 40,
      glsl: "c = c * 1.0;",
    });
    const { injection, prepass } = buildStageInjection([adjust, vignette, effect]);
    const fx = injection.effects;
    const exit = fx.indexOf("if (uSplitAt == 0)");
    expect(exit).toBeGreaterThan(fx.indexOf("c *= 0.5;"));
    expect(exit).toBeLessThan(fx.indexOf("c = c * 1.0;"));
    const split = prepass.find((p) => p.stageId === "acme.effect")!.split!;
    expect(split.cut).toBe("display");
    expect(split.upstreamStageIds).toEqual(["acme.adjust"]);
  });

  it("puts output-frame splits ahead of every effects and output-encode stage", () => {
    const adjust = flagged({ id: "acme.adjust", phase: "display-adjust", glsl: "c *= 0.5;" });
    const vignette = flagged({
      id: "core.vignette",
      phase: "effects",
      priority: 30,
      glsl: "c *= 0.25;",
    });
    const effect = current({
      id: "acme.effect",
      phase: "effects",
      priority: 40,
      glsl: "c *= 0.75;",
    });
    const encode = current({ id: "acme.encode", phase: "output-encode", glsl: "c *= 0.125;" });
    const { injection, prepass } = buildStageInjection([adjust, vignette, effect, encode]);
    const order = [
      "c *= 0.5;",
      "if (uSplitAt == 0) { fragColor = vec4(c, 1.0); return; }",
      "if (uSplitAt == 1) { fragColor = vec4(c, 1.0); return; }",
      "c *= 0.25;",
      "c *= 0.75;",
      "c *= 0.125;",
    ];
    expect(inOrder(injection.effects, order)).toEqual(order);
    const upstream = prepass.map((p) => p.split?.upstreamStageIds);
    expect(upstream).toEqual([["acme.adjust"], ["acme.adjust"]]);
  });

  it("hands a legacy display stage clipped values on version 2", () => {
    const { injection } = buildStageInjection(
      [current({ phase: "display-adjust", glsl: "c = c;" })],
      V2_VARIANT,
    );
    expect(injection.effects).toContain("fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);");
  });

  // The exit converts from working values, so a stage in the same space just
  // before it hands its variable back first.
  // An exit that converts calls the space helpers, so they must be compiled in
  // even when nothing else converts (a core stage's own block never does), and
  // not when the exit stays in working values.
  it("compiles the space helpers in for an exit into a stage's space, and only then", () => {
    const wide = { encoding: "linear" as const, primaries: "rec2020" as const };
    const spaced = buildStageInjection([current({ id: "core.reader", space: wide })]);
    expect(spaced.injection.sceneLinear).toContain(
      "fragColor = vec4((SL_REC709_TO_REC2020 * lin), 1.0);",
    );
    expect(spaced.injection.needsSpaceHelpers).toBe(true);
    const plain = buildStageInjection([current({ id: "core.reader" })]);
    expect(plain.injection.needsSpaceHelpers).toBe(false);
  });

  it("returns to working values ahead of an exit", () => {
    const wide = { encoding: "linear" as const, primaries: "rec2020" as const };
    const { injection } = buildStageInjection([
      flagged({ id: "acme.a", priority: 10, space: wide, glsl: "lin *= 2.0;" }),
      current({ id: "acme.b", priority: 20, space: wide, glsl: "lin *= 3.0;" }),
    ]);
    const statements = injection.sceneLinear
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^(lin |if )/.test(line));
    expect(statements).toEqual([
      "lin = (SL_REC709_TO_REC2020 * lin);",
      "lin *= 2.0;",
      "lin = (SL_REC2020_TO_REC709 * lin);",
      "if (uSplitAt == 0) { fragColor = vec4((SL_REC709_TO_REC2020 * lin), 1.0); return; }",
      "lin = (SL_REC709_TO_REC2020 * lin);",
      "lin *= 3.0;",
      "lin = (SL_REC2020_TO_REC709 * lin);",
    ]);
  });

  it("leaves geometry stages, which a split draw skips, out of its upstream", () => {
    const warp = flagged({ id: "acme.warp", phase: "geometry", glsl: "srcUv.x += 0.0;" });
    const { prepass } = buildStageInjection([warp, current({ id: "acme.reader" })]);
    expect(prepass[0].split?.upstreamStageIds).toEqual([]);
  });

  it("leaves core stages, whose values come from typed params, out of its upstream", () => {
    const { prepass } = buildStageInjection([
      flagged({ id: "acme.before", priority: 10 }),
      flagged({ id: "core.middle", priority: 20 }),
      current({ id: "acme.reader", priority: 30 }),
    ]);
    expect(prepass[0].split?.upstreamStageIds).toEqual(["acme.before"]);
  });

  it("numbers splits in pipeline order", () => {
    const { prepass } = buildStageInjection([
      current({ id: "acme.late", priority: 300 }),
      current({ id: "acme.early", priority: 5 }),
    ]);
    expect(prepass.map((p) => [p.stageId, p.split?.index])).toEqual([
      ["acme.early", 0],
      ["acme.late", 1],
    ]);
  });
});

// The builder asks three things of a phase: which group its block joins, which
// values its stages see, and whether it runs in the output frame. One row
// answers all three, so the answers cannot drift apart.
describe("phase table", () => {
  const EXPECTED: Record<
    ProcessingPhase,
    { group: string; domain: string | null; outputFrame: boolean }
  > = {
    geometry: { group: "srcUv", domain: null, outputFrame: false },
    decode: { group: "noiseReduction", domain: "scene", outputFrame: false },
    "noise-reduction": { group: "noiseReduction", domain: "scene", outputFrame: false },
    "scene-linear": { group: "sceneLinear", domain: "scene", outputFrame: false },
    "tone-map": { group: "sceneLinear", domain: "scene", outputFrame: false },
    "display-adjust": { group: "effects", domain: "display", outputFrame: false },
    effects: { group: "effects", domain: "display", outputFrame: true },
    "output-encode": { group: "effects", domain: "display", outputFrame: true },
  };

  for (const phase of PROCESSING_PHASE_ORDER) {
    it(`maps ${phase}`, () => {
      expect(PHASES[phase]).toEqual(EXPECTED[phase]);
    });
  }

  it("has a row for every phase and none besides", () => {
    expect(Object.keys(PHASES).sort()).toEqual([...PROCESSING_PHASE_ORDER].sort());
  });

  // Each colour group remembers one held space, so the phases sharing a group
  // must hand their stages the same kind of values.
  it("keeps every colour group in a single domain", () => {
    const domains = new Map<string, Set<string | null>>();
    for (const { group, domain } of Object.values(PHASES)) {
      const seen = domains.get(group) ?? new Set<string | null>();
      domains.set(group, seen.add(domain));
    }
    for (const [group, seen] of domains) expect([...seen], group).toHaveLength(1);
  });

  // Extensions are plain JavaScript and the registry doesn't check `phase`, so
  // building must survive a name the table lacks (or one that is only an
  // inherited property of it, like "toString").
  const unlistedPhase = (name: string): ProcessingPhase => name as ProcessingPhase;

  for (const name of ["post-effects", "toString"]) {
    it(`injects a stage naming the unlisted phase "${name}" into effects`, () => {
      const stage = flagged({ id: "acme.unlisted", phase: unlistedPhase(name), glsl: "c *= 2.0;" });
      const { injection } = buildStageInjection([stage]);
      expect(injection.effects).toContain("c *= 2.0;");
    });
  }

  // The fallback row is the effects group holding scene values: a perceptual
  // space is a conversion there, where in display-adjust it is the working space.
  it("hands an unlisted phase's stage scene values", () => {
    const space = { encoding: "perceptual" as const };
    const unlisted = buildStageInjection([
      flagged({ id: "acme.unlisted", phase: unlistedPhase("post-effects"), space }),
    ]);
    expect(unlisted.injection.effects).toContain("lin = slEncodePerceptual(lin);");
    const adjust = buildStageInjection([
      flagged({ id: "acme.adjust", phase: "display-adjust", space }),
    ]);
    expect(adjust.injection.effects).not.toContain("slEncodePerceptual");
    expect(adjust.injection.needsSpaceHelpers).toBe(false);
  });

  it("cuts an unlisted phase's reader among scene values, not at the end of display-adjust", () => {
    const { injection, prepass } = buildStageInjection([
      flagged({
        id: "acme.unlisted",
        phase: unlistedPhase("post-effects"),
        reads: "current",
        passes: [{ glsl: "c = readPrev(vUv);" }],
      }),
    ]);
    const exit = "if (uSplitAt == 0) { fragColor = vec4(lin, 1.0); return; }";
    expect(injection.effects).toContain(exit);
    expect(prepass[0].split).toEqual({ index: 0, cut: "scene", upstreamStageIds: [] });
  });
});

// An extension that owns noise reduction replaces the built-in denoiser; the
// two never stack.
describe("the built-in denoiser", () => {
  const nr = (over: Partial<ProcessingStageContribution>) =>
    flagged({ phase: "noise-reduction", ...over });
  const prepassIds = (stages: ProcessingStageContribution[]) =>
    buildStageInjection(stages).prepass.map((p) => p.stageId);

  it("runs when nothing else owns noise reduction", () => {
    const built = buildStageInjection([DENOISE_STAGE]);
    expect(built.prepass.map((p) => p.stageId)).toEqual([BUILTIN_DENOISE_ID]);
    expect(built.hasNoiseReduction).toBe(true);
  });

  it("bows out for an extension's noise-reduction stage", () => {
    const built = buildStageInjection([DENOISE_STAGE, nr({ id: "acme.nr" })]);
    expect(built.prepass).toEqual([]);
    expect(built.sig).not.toContain(BUILTIN_DENOISE_ID);
    expect(built.hasNoiseReduction).toBe(true);
  });

  it("stays beside a core noise-reduction stage and a decode stage", () => {
    expect(prepassIds([DENOISE_STAGE, nr({ id: "core.nr" })])).toEqual([BUILTIN_DENOISE_ID]);
    expect(prepassIds([DENOISE_STAGE, flagged({ id: "acme.decode", phase: "decode" })])).toEqual([
      BUILTIN_DENOISE_ID,
    ]);
  });

  // Its inline swaps `lin` for its own result. On version 2 its passes start from
  // what the decode stages left, or their work would be lost; version 1 keeps
  // reading the source, and so does a stage set with no decode stage.
  describe("behind a decode stage", () => {
    const decode = flagged({ id: "acme.decode", phase: "decode" });
    const denoiserSplit = (stages: ProcessingStageContribution[], variant: ShaderVariant) =>
      buildStageInjection(stages, variant).prepass.find((p) => p.stageId === BUILTIN_DENOISE_ID)
        ?.split;

    it("reads the current image on version 2", () => {
      expect(denoiserSplit([DENOISE_STAGE, decode], V2_VARIANT)).toEqual({
        index: 0,
        cut: "decode",
        upstreamStageIds: ["acme.decode"],
      });
    });

    const SOURCE_READS: [string, ProcessingStageContribution[], ShaderVariant][] = [
      ["on version 1", [DENOISE_STAGE, decode], V1_VARIANT],
      ["alone on version 1", [DENOISE_STAGE], V1_VARIANT],
      ["alone on version 2", [DENOISE_STAGE], V2_VARIANT],
    ];
    for (const [when, stages, variant] of SOURCE_READS) {
      it(`reads the source ${when}, with no split in the program`, () => {
        const { injection } = buildStageInjection(stages, variant);
        expect(denoiserSplit(stages, variant)).toBeUndefined();
        expect(injection.splitCount ?? 0).toBe(0);
        expect(injection.uniforms).not.toContain("uSplitAt");
      });
    }

    // The extension stage displaces the denoiser before the readers are chosen,
    // so no split of the denoiser's is left in the program.
    it("leaves no split when an extension owns noise reduction", () => {
      const stages = [DENOISE_STAGE, decode, nr({ id: "acme.nr" })];
      const { injection, prepass } = buildStageInjection(stages, V2_VARIANT);
      expect(prepass.some((p) => p.stageId === BUILTIN_DENOISE_ID)).toBe(false);
      expect(injection.splitCount ?? 0).toBe(0);
      expect(injection.uniforms).not.toContain("uSplitAt");
    });

    it("reads the source behind a geometry stage alone", () => {
      const warp = flagged({ id: "acme.warp", phase: "geometry", glsl: "srcUv.x += 0.0;" });
      expect(denoiserSplit([DENOISE_STAGE, warp], V2_VARIANT)).toBeUndefined();
    });

    it("exits after the decode stage, ahead of its own block", () => {
      const { injection } = buildStageInjection([DENOISE_STAGE, decode], V2_VARIANT);
      const order = [
        "lin *= 1.0;",
        "if (uSplitAt == 0) { fragColor = vec4(lin, 1.0); return; }",
        "lin = stageResult;",
      ];
      expect(inOrder(injection.noiseReduction, order)).toEqual(order);
      expect(injection.splitCount).toBe(1);
      expect(injection.uniforms).toContain("uniform int uSplitAt;");
    });

    it("numbers its split after a decode reader's, which feeds it", () => {
      const reader = flagged({
        id: "acme.reader",
        phase: "decode",
        reads: "current",
        passes: [{ glsl: "c = readPrev(vUv);" }],
      });
      const { prepass } = buildStageInjection([DENOISE_STAGE, reader], V2_VARIANT);
      expect(prepass.map((p) => [p.stageId, p.split])).toEqual([
        ["acme.reader", { index: 0, cut: "decode", upstreamStageIds: [] }],
        [BUILTIN_DENOISE_ID, { index: 1, cut: "decode", upstreamStageIds: ["acme.reader"] }],
      ]);
    });

    it("keeps the signature the same for both versions", () => {
      const stages = [DENOISE_STAGE, decode];
      expect(buildStageInjection(stages, V2_VARIANT).sig).toBe(
        buildStageInjection(stages, V1_VARIANT).sig,
      );
    });
  });
});

describe("pipeline order", () => {
  // Registration order breaks ties, not ids, and spelling out the default
  // priority (100) is no different from leaving it out.
  it("keeps the order given for equal phase and priority", () => {
    const { injection } = buildStageInjection([
      flagged({ id: "acme.z", glsl: "lin *= 2.0;" }),
      flagged({ id: "acme.a", priority: 100, glsl: "lin *= 3.0;" }),
      flagged({ id: "acme.m", glsl: "lin *= 5.0;" }),
    ]);
    const order = ["lin *= 2.0;", "lin *= 3.0;", "lin *= 5.0;"];
    expect(inOrder(injection.sceneLinear, order)).toEqual(order);
  });

  /** The stage ids in the order the injection wrote them, read off the signature. */
  const orderOf = (stages: ProcessingStageContribution[]): string[] =>
    buildStageInjection(stages).sig.split("|").map((part) => part.split(":")[0]);

  it("orders by phase, then priority, then the order given, as it always has", () => {
    expect(
      orderOf([
        flagged({ id: "acme.fx.late", phase: "effects", priority: 200 }),
        flagged({ id: "acme.scene.b" }),
        flagged({ id: "acme.scene.fast", priority: 10 }),
        flagged({ id: "acme.decode", phase: "decode" }),
        flagged({ id: "acme.scene.a", priority: 100 }),
        flagged({ id: "acme.fx.early", phase: "effects", priority: 5 }),
      ]),
    ).toEqual([
      "acme.decode",
      "acme.scene.fast",
      "acme.scene.b",
      "acme.scene.a",
      "acme.fx.early",
      "acme.fx.late",
    ]);
  });

  // `after` is a soft dependency inside a phase. The sort itself is pinned in
  // stage-order.test.ts; this is what the injection does with the order it gets.
  describe("after", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });
    // sortStages remembers the cycles it has reported, so a test that counts
    // warnings names stages that no other test in this file does.
    const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

    it("runs a stage after the stage it names, against its priority", () => {
      const stages = [
        flagged({ id: "acme.late", priority: 10, after: ["acme.base"], glsl: "lin *= 2.0;" }),
        flagged({ id: "acme.base", glsl: "lin *= 3.0;" }),
      ];
      expect(orderOf(stages)).toEqual(["acme.base", "acme.late"]);
      const order = ["lin *= 3.0;", "lin *= 2.0;"];
      expect(inOrder(buildStageInjection(stages).injection.sceneLinear, order)).toEqual(order);
    });

    it("ignores an id from another phase", () => {
      const warn = quietWarn();
      const stages = [
        flagged({ id: "acme.scene", priority: 10, after: ["acme.fx"] }),
        flagged({ id: "acme.fx", phase: "effects" }),
      ];
      expect(orderOf(stages)).toEqual(["acme.scene", "acme.fx"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("ignores an id that isn't registered", () => {
      const warn = quietWarn();
      const stages = [
        flagged({ id: "acme.first", priority: 10, after: ["acme.gone"] }),
        flagged({ id: "acme.second", priority: 20 }),
      ];
      expect(orderOf(stages)).toEqual(["acme.first", "acme.second"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("ignores the entries between a cycle's stages, and warns once, naming them", () => {
      const warn = quietWarn();
      const stages = [
        flagged({ id: "acme.a", priority: 10, after: ["acme.b"] }),
        flagged({ id: "acme.b", priority: 20, after: ["acme.a"] }),
      ];
      expect(orderOf(stages)).toEqual(["acme.a", "acme.b"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('"acme.a"');
      expect(warn.mock.calls[0][0]).toContain('"acme.b"');
    });

    // The renderer builds the injection per process version, and each renderer
    // builds its own.
    it("reports a cycle once across builds, whichever process version builds it", () => {
      const warn = quietWarn();
      const stages = [
        flagged({ id: "acme.once.a", priority: 10, after: ["acme.once.b"] }),
        flagged({ id: "acme.once.b", priority: 20, after: ["acme.once.a"] }),
      ];
      for (const variant of [V1_VARIANT, V2_VARIANT, V2_VARIANT]) {
        expect(buildStageInjection(stages, variant).sig).toContain("acme.once.a");
      }
      expect(warn).toHaveBeenCalledTimes(1);
    });

    // A reader's split is numbered by its place in the order, and the reader
    // ahead of it feeds it.
    it("numbers the splits in the order it gives", () => {
      const reader = (id: string, over: Partial<ProcessingStageContribution>) =>
        flagged({
          id,
          phase: "decode",
          reads: "current",
          passes: [{ glsl: "c = readPrev(vUv);" }],
          ...over,
        });
      const { prepass } = buildStageInjection([
        reader("acme.first", { priority: 10, after: ["acme.second"] }),
        reader("acme.second", { priority: 20 }),
      ]);
      expect(prepass.map((p) => [p.stageId, p.split])).toEqual([
        ["acme.second", { index: 0, cut: "decode", upstreamStageIds: [] }],
        ["acme.first", { index: 1, cut: "decode", upstreamStageIds: ["acme.second"] }],
      ]);
    });

    // The denoiser goes before the stages are ordered: a stage that names it, and
    // that it names back, would otherwise be reported as a cycle through a stage
    // that is not in the program.
    it("lets an extension's noise reduction displace the denoiser before ordering", () => {
      const warn = quietWarn();
      const stages = [
        { ...DENOISE_STAGE, after: ["acme.nr"] },
        flagged({ id: "acme.nr", phase: "noise-reduction", after: [BUILTIN_DENOISE_ID] }),
      ];
      expect(orderOf(stages)).toEqual(["acme.nr"]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("prepass passes", () => {
  // `iterations` is how many ping-pong draws a pass takes: never fewer than one.
  it("runs every pass at least once", () => {
    const counted = [0, -4, 3].map((iterations) => ({ ...PASS, iterations }));
    const { prepass } = buildStageInjection([flagged({ passes: [PASS, ...counted] })]);
    expect(prepass[0].passes.map((p) => p.iterations)).toEqual([1, 1, 1, 3]);
  });
});

// A version 2 program whose stages would pass the sampler budget reads their
// prepass results from their layers of one shared array, so its sampler count
// stops growing with the stage set. A set that fits keeps a sampler per stage,
// as version 1 always does: the array is one large texture, where a sampler
// per stage is several small ones. A stage that names its result sampler (to
// texelFetch it) keeps it either way.
describe("version 2 stage results", () => {
  const OTHER: ProcessingStageContribution = { ...STAGE, id: "acme.other", name: "Other" };
  const ARRAY = "uniform highp sampler2DArray uStageResults;";
  const layered = (s: ProcessingStageContribution): string => `${uniformPrefix(s.id)}stageResultLayer`;
  const sampled = (s: ProcessingStageContribution): string => `${uniformPrefix(s.id)}stageResult`;

  it("gives every prepass stage a layer of one shared array", () => {
    const { injection, prepass } = buildStageInjection([STAGE, OTHER], V2_VARIANT, 1);
    expect(injection.uniforms.split(ARRAY)).toHaveLength(2);
    for (const s of [STAGE, OTHER]) {
      const layer = layered(s);
      expect(injection.uniforms).toContain(`uniform int ${layer};`);
      expect(injection.uniforms).not.toContain(`uniform sampler2D ${uniformPrefix(s.id)}stageResult;`);
      expect(injection.sceneLinear).toContain(
        `vec3 stageResult = ${layer} < 0 ? texture(uImage, srcUv).rgb : ` +
          `texture(uStageResults, vec3(srcUv, float(${layer}))).rgb;`,
      );
    }
    expect(prepass.map((p) => p.layerUniform)).toEqual([layered(STAGE), layered(OTHER)]);
  });

  it("keeps the sampler of a stage that reads it by name", () => {
    const sampler = `${uniformPrefix(STAGE.id)}stageResult`;
    const named = { ...STAGE, glsl: `lin += texelFetch(${sampler}, ivec2(0), 0).rgb * amount;` };
    const { injection, prepass } = buildStageInjection([named], V2_VARIANT, 0);
    expect(injection.uniforms).toContain(`uniform sampler2D ${sampler};`);
    expect(injection.uniforms).not.toContain("sampler2DArray");
    expect(prepass[0].layerUniform).toBeUndefined();
  });

  it("keeps a sampler per stage on version 2 while the set fits the budget", () => {
    const { injection, prepass } = buildStageInjection([STAGE, OTHER], V2_VARIANT, 2);
    expect(injection.uniforms).not.toContain("sampler2DArray");
    for (const s of [STAGE, OTHER]) {
      expect(injection.uniforms).toContain(`uniform sampler2D ${sampled(s)};`);
      expect(injection.uniforms).not.toContain(layered(s));
      expect(injection.sceneLinear).toContain(
        `vec3 stageResult = texture(${sampled(s)}, srcUv).rgb;`,
      );
    }
    expect(prepass.map((p) => p.layerUniform)).toEqual([undefined, undefined]);
  });

  // A lut or dynamic texture is a sampler too; coverage rides the brush atlas.
  it("counts stage textures against the budget", () => {
    const table: ProcessingStageContribution = {
      ...flagged({ id: "acme.table" }),
      textures: [
        { key: "table", kind: "lut", width: 1, height: 1, format: "rgba8" },
        { key: "brush", kind: "coverage" },
      ],
    };
    const layersAt = (budget: number): (string | undefined)[] =>
      buildStageInjection([STAGE, table], V2_VARIANT, budget).prepass.map((p) => p.layerUniform);
    expect(layersAt(1)).toEqual([layered(STAGE)]);
    expect(layersAt(2)).toEqual([undefined]);
  });

  it("leaves version 1 with a sampler per stage", () => {
    const { injection, prepass } = buildStageInjection([STAGE, OTHER], V1_VARIANT);
    expect(injection.uniforms).not.toContain("sampler2DArray");
    for (const s of [STAGE, OTHER]) {
      expect(injection.uniforms).toContain(`uniform sampler2D ${uniformPrefix(s.id)}stageResult;`);
    }
    expect(prepass.map((p) => p.layerUniform)).toEqual([undefined, undefined]);
  });
});

// A post-transform stage can read the scene's headroom as slSceneLuma. Version
// 2's main() declares it; version 1's frozen text can't, so the injector
// declares it inside the block of a display stage that names it.
describe("slSceneLuma", () => {
  const reader = flagged({
    id: "acme.hdr",
    phase: "output-encode",
    space: { encoding: "perceptual" },
    glsl: "c = vec3(slSceneLuma);",
  });

  it("is declared from lin inside a version 1 display stage that reads it", () => {
    const { injection } = buildStageInjection([reader], V1_VARIANT);
    expect(injection.effects).toContain("float slSceneLuma = max(luma(lin), 0.0);");
  });

  for (const phase of ["display-adjust", "effects", "output-encode"] as const) {
    it(`is declared inside a version 1 ${phase} stage that reads it`, () => {
      const stage = flagged({ phase, glsl: "c *= slSceneLuma;" });
      const { injection } = buildStageInjection([stage], V1_VARIANT);
      expect(injection.effects).toBe("{\nfloat slSceneLuma = max(luma(lin), 0.0);\nc *= slSceneLuma;\n}");
    });
  }

  it("is declared once in each block when several stages read it on version 1", () => {
    const readers = [
      flagged({ id: "acme.a", phase: "display-adjust", glsl: "c *= slSceneLuma;" }),
      flagged({ id: "acme.b", phase: "effects", glsl: "c += slSceneLuma;" }),
      flagged({ id: "acme.c", phase: "output-encode", glsl: "c = vec3(slSceneLuma);" }),
    ];
    const { injection } = buildStageInjection(readers, V1_VARIANT);
    // Each declaration opens its own braces and the block closes before the
    // next one starts, so no two share a scope: the output is exactly these.
    const block = /\{\nfloat slSceneLuma = max\(luma\(lin\), 0\.0\);\n[^{}]*\}/g;
    expect(injection.effects.match(block)).toHaveLength(3);
    expect(injection.effects.replace(block, "").trim()).toBe("");
  });

  it("is left to main() on version 2", () => {
    const { injection } = buildStageInjection([reader], V2_VARIANT);
    expect(injection.effects).not.toContain("float slSceneLuma");
  });

  it("is not declared for a stage that doesn't name it", () => {
    const plain = flagged({ id: "acme.plain", phase: "output-encode", glsl: "c *= 1.0;" });
    expect(buildStageInjection([plain], V1_VARIANT).injection.effects).not.toContain("slSceneLuma");
  });

  it("is not declared before the display transform", () => {
    const early = flagged({ glsl: "lin *= slSceneLuma;" });
    expect(buildStageInjection([early], V1_VARIANT).injection.sceneLinear).not.toContain("float slSceneLuma");
  });
});

// A producer's value reaches a later stage's glsl through a global the core
// declares once per program; nothing changes for a stage set that uses none.
describe("inter-stage variables", () => {
  const PRODUCER: ProcessingStageContribution = {
    id: "acme.maker",
    name: "Maker",
    phase: "scene-linear",
    priority: 10,
    glsl: "float made = lin.g * amount;",
    uniforms: [AMOUNT],
    produces: [{ name: "acmeMade", glslType: "float", producer: "made" }],
  };
  const CONSUMER: ProcessingStageContribution = {
    id: "acme.reader",
    name: "Reader",
    phase: "output-encode",
    glsl: "c = vec3(isv_acmeMade);",
    uniforms: [],
    consumes: ["acmeMade"],
  };

  afterEach(() => vi.restoreAllMocks());

  it("declares each variable once, ahead of the helpers", () => {
    const { injection } = buildStageInjection([PRODUCER, CONSUMER, STAGE]);
    expect(injection.helpers.match(/float isv_acmeMade = 0\.0;/g)).toHaveLength(1);
    expect(injection.helpers.indexOf("isv_acmeMade")).toBeLessThan(injection.helpers.indexOf("lookScale"));
  });

  it.each([
    ["vec2", "vec2(0.0)"],
    ["vec3", "vec3(0.0)"],
    ["vec4", "vec4(0.0)"],
  ] as const)("zero-initializes a %s", (glslType, zero) => {
    const stage = { ...PRODUCER, produces: [{ name: "acmeMade", glslType, producer: `${glslType}(1.0)` }] };
    expect(buildStageInjection([stage]).injection.helpers).toContain(`${glslType} isv_acmeMade = ${zero};`);
  });

  it("assigns the producer's expression inside its block, after its glsl", () => {
    const pfx = uniformPrefix(PRODUCER.id);
    const { injection } = buildStageInjection([PRODUCER]);
    expect(injection.sceneLinear).toContain(`float made = lin.g * ${pfx}amount;\nisv_acmeMade = (made\n);\n}`);
  });

  // The closing parenthesis sits on its own line so a trailing // comment in the
  // expression can't swallow it.
  it("keeps a trailing line comment in a producer from swallowing the assignment's end", () => {
    const stage = { ...PRODUCER, produces: [{ name: "acmeMade", glslType: "float" as const, producer: "made // the mask" }] };
    expect(buildStageInjection([stage]).injection.sceneLinear).toContain("isv_acmeMade = (made // the mask\n);\n}");
  });

  it("namespaces the producer's uniforms like the glsl's", () => {
    const pfx = uniformPrefix(PRODUCER.id);
    const stage = { ...PRODUCER, produces: [{ name: "acmeMade", glslType: "float" as const, producer: "amount * 2.0" }] };
    expect(buildStageInjection([stage]).injection.sceneLinear).toContain(`isv_acmeMade = (${pfx}amount * 2.0\n);`);
  });

  it("declares a variable the producer assigns in its own glsl, and adds no assignment", () => {
    const stage = { ...PRODUCER, glsl: "isv_acmeMade = lin.g;", produces: [{ name: "acmeMade", glslType: "float" as const }] };
    const { injection } = buildStageInjection([stage]);
    expect(injection.helpers).toContain("float isv_acmeMade = 0.0;");
    expect(injection.sceneLinear.match(/isv_acmeMade =/g)).toHaveLength(1);
  });

  it("leaves the consumer's isv_ names as written", () => {
    expect(buildStageInjection([PRODUCER, CONSUMER]).injection.effects).toContain("c = vec3(isv_acmeMade);");
  });

  it("leaves out a consumer whose variable no stage produces, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orphan = { ...CONSUMER, id: "acme.orphan" };
    const built = buildStageInjection([orphan, STAGE]);
    buildStageInjection([orphan, STAGE]);
    expect(built.injection.effects).not.toContain("isv_acmeMade");
    expect(built.injection.helpers).not.toContain("isv_");
    expect(built.sig).not.toContain("acme.orphan");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/stage 'acme\.orphan' consumes 'acmeMade', which no stage left in the set produces; it is left out/);
  });

  it("leaves out the consumers of a variable whose only producer is itself left out", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first: ProcessingStageContribution = {
      ...PRODUCER,
      id: "acme.chain-a",
      glsl: "float chained = lin.g;",
      uniforms: [],
      produces: [{ name: "acmeChained", glslType: "float", producer: "chained" }],
      consumes: ["acmeMissing"],
    };
    const second: ProcessingStageContribution = {
      ...CONSUMER,
      id: "acme.chain-b",
      glsl: "c = vec3(isv_acmeChained);",
      consumes: ["acmeChained"],
    };
    const built = buildStageInjection([first, second, STAGE]);
    buildStageInjection([first, second, STAGE]);
    expect(JSON.stringify(built.injection)).not.toContain("isv_");
    expect(built.sig).not.toContain("acme.chain");
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      "[render] stage 'acme.chain-a' consumes 'acmeMissing', which no stage left in the set produces; it is left out",
      "[render] stage 'acme.chain-b' consumes 'acmeChained', which no stage left in the set produces; it is left out",
    ]);
  });

  it("keeps the built-in denoiser when the noise-reduction stage that would replace it is left out", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const nr = flagged({ id: "acme.nr-orphan", phase: "noise-reduction", consumes: ["acmeNever"] });
    const built = buildStageInjection([DENOISE_STAGE, nr]);
    expect(built.sig).toContain(BUILTIN_DENOISE_ID);
    expect(built.sig).not.toContain("acme.nr-orphan");
    expect(built.prepass.map((p) => p.stageId)).toEqual([BUILTIN_DENOISE_ID]);
    expect(built.hasNoiseReduction).toBe(true);
  });

  it("warns once about a consumer ordered ahead of its producer, and keeps it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const early = { ...CONSUMER, id: "acme.early", phase: "scene-linear" as const, priority: 5, glsl: "lin = vec3(isv_acmeMade);" };
    const built = buildStageInjection([early, PRODUCER]);
    buildStageInjection([early, PRODUCER]);
    expect(built.injection.sceneLinear).toContain("lin = vec3(isv_acmeMade);");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/stage 'acme\.early' runs ahead of the producer of 'acmeMade', so it reads zero/);
  });

  it("adds nothing to a stage set that uses no variable", () => {
    for (const variant of [V1_VARIANT, V2_VARIANT]) {
      expect(JSON.stringify(buildStageInjection([STAGE, CORE], variant).injection)).not.toContain("isv_");
    }
  });

  it("keeps the signature of a stage that uses no variable", () => {
    const before = simpleHash(
      JSON.stringify([STAGE.phase, 100, STAGE.glsl, STAGE.helpers, STAGE.uniforms, [], STAGE.passes, null, "source"]),
    );
    expect(stageSignature(STAGE)).toBe(before);
    expect(stageSignature({ ...STAGE, produces: undefined, consumes: undefined })).toBe(before);
  });

  it("changes the signature of a stage that produces or consumes a variable", () => {
    expect(sig({ ...STAGE, produces: [{ name: "acmeMade", glslType: "float", producer: "1.0" }] })).not.toBe(sig(STAGE));
    expect(sig({ ...STAGE, consumes: ["acmeMade"], produces: [{ name: "acmeMade", glslType: "float" }] })).not.toBe(
      sig({ ...STAGE, produces: [{ name: "acmeMade", glslType: "float" }] }),
    );
  });

  // The renderer derives which prepasses run from the rule, so a stage
  // registered again with another rule must not sign as the same stage.
  it("changes the signature of a stage only when it declares dormantWhen", () => {
    expect(stageSignature({ ...STAGE, dormantWhen: undefined })).toBe(stageSignature(STAGE));
    expect(stageSignature({ ...STAGE, dormantWhen: { amount: 0 } })).not.toBe(stageSignature(STAGE));
  });
});

describe("pass draw counts", () => {
  const DRAWS: UniformDeclaration = { key: "draws", glslType: "int", default: 3 };

  it("hands the renderer the count's bag key, its default and its max", () => {
    const stage = { ...STAGE, uniforms: [AMOUNT, DRAWS], passes: [{ ...PASS, iterations: { key: "draws", max: 6 } }] };
    const [prepass] = buildStageInjection([stage]).prepass;
    expect(prepass.passes[0].iterations).toBe(6);
    expect(prepass.passes[0].drawCount).toEqual({ qualifiedKey: "acme.look.draws", max: 6, fallback: 3 });
  });

  it("finds the key among the pass's own uniforms", () => {
    const pass = { ...PASS, uniforms: [{ ...DRAWS, default: 1 }], iterations: { key: "draws", max: 2 } };
    const [prepass] = buildStageInjection([{ ...STAGE, passes: [pass] }]).prepass;
    expect(prepass.passes[0].drawCount).toEqual({ qualifiedKey: "acme.look.draws", max: 2, fallback: 1 });
  });

  it("keeps a fixed count as it was", () => {
    const [prepass] = buildStageInjection([{ ...STAGE, passes: [{ ...PASS, iterations: 4 }] }]).prepass;
    expect(prepass.passes[0].iterations).toBe(4);
    expect(prepass.passes[0].drawCount).toBeUndefined();
  });

  // The worker loops once per draw, so a fixed count nothing bounds (Infinity,
  // 1e9) would never return.
  it.each([
    [Infinity, 1],
    [-Infinity, 1],
    [NaN, 1],
    [1e9, 1024],
    [1025, 1024],
    [1024, 1024],
    [2.7, 2],
    [0.4, 1],
  ])("bounds a fixed count of %s to %s draws", (iterations, draws) => {
    const [prepass] = buildStageInjection([{ ...STAGE, passes: [{ ...PASS, iterations }] }]).prepass;
    expect(prepass.passes[0].iterations).toBe(draws);
  });

  it.each([NaN, Infinity, -Infinity])("falls back to 0 draws while the count's default is %s", (value) => {
    const stage = {
      ...STAGE,
      uniforms: [AMOUNT, { ...DRAWS, default: value }],
      passes: [{ ...PASS, iterations: { key: "draws", max: 6 } }],
    };
    const [prepass] = buildStageInjection([stage]).prepass;
    expect(prepass.passes[0].drawCount?.fallback).toBe(0);
  });
});

// Heal's spot arrays are sized by constants the program names (MAX_SPOTS): an
// official stage may define them, and size an array uniform by one.
describe("an official stage's constants", () => {
  const healish = (): ProcessingStageContribution & { extensionId: string } => ({
    id: "safelight.heal.retouch",
    name: "Heal",
    phase: "scene-linear",
    anchor: "white-balance",
    glsl: "",
    defines: { MAX_SPOTS: 32 },
    uniforms: [{ key: "uSpotA", glslType: "vec4", length: 32, size: "MAX_SPOTS", default: new Array(128).fill(0) }],
    extensionId: "safelight.heal",
  });

  it("are defined ahead of the uniforms they size", () => {
    const { uniforms } = buildStageInjection([healish()], V3_VARIANT).injection;
    const define = uniforms.indexOf("#define MAX_SPOTS 32");
    expect(define).toBeGreaterThanOrEqual(0);
    expect(uniforms.indexOf("uniform vec4 uSpotA[MAX_SPOTS];")).toBeGreaterThan(define);
  });

  it("bind the array by its length", () => {
    const built = buildStageInjection([healish()], V3_VARIANT);
    expect(built.bindings.find((b) => b.qualifiedKey === "safelight.heal.retouch.uSpotA")).toMatchObject({ length: 32 });
  });

  it("are an extension's own constants only when it is official", () => {
    const { uniforms } = buildStageInjection([{ ...healish(), extensionId: "acme.heal", id: "acme.heal" } as ProcessingStageContribution], V3_VARIANT).injection;
    expect(uniforms).not.toContain("#define MAX_SPOTS 32");
  });
});

// A paint texture is a sampler of the stage's own, read through a helper under
// its key that picks the layer's tile.
describe("paint textures", () => {
  const PAINTER = flagged({
    id: "acme.paint",
    phase: "effects",
    glsl: "vec4 p = layers(0, srcUv); c = mix(c, p.rgb, p.a);",
    textures: [{ key: "layers", kind: "paint" }],
  });
  const name = `${uniformPrefix(PAINTER.id)}layers`;

  it("declares a sampler and a layer-reading helper under the key", () => {
    const built = buildStageInjection([PAINTER], V2_VARIANT);
    expect(built.injection.uniforms).toContain(`uniform sampler2D ${name}_tex;`);
    expect(built.injection.helpers).toContain(`vec4 ${name}(int layer, vec2 uv)`);
    expect(built.injection.effects).toContain(`${name}(0, srcUv)`);
    expect(built.textureBindings).toEqual([{ qualifiedKey: "acme.paint.layers", glslName: name, kind: "paint" }]);
  });

  it("counts against the sampler budget", () => {
    const layersAt = (budget: number): (string | undefined)[] =>
      buildStageInjection([STAGE, PAINTER], V2_VARIANT, budget).prepass.map((p) => p.layerUniform);
    expect(layersAt(1)).toEqual([`${uniformPrefix(STAGE.id)}stageResultLayer`]);
    expect(layersAt(2)).toEqual([undefined]);
  });
});

// The detail gain (Dynamic detail) scales what reaches it in `lin`; a stage ahead
// of it that rebuilds the colour from base-resolution passes would have the gain
// put the original's native noise back.
describe("rebuilders", () => {
  const stage = (id: string, phase: ProcessingStageContribution["phase"]): ProcessingStageContribution => ({
    id,
    name: id,
    phase,
    glsl: "",
    uniforms: [],
  });

  it("names an extension's decode stage", () => {
    expect(buildStageInjection([stage("ext.raw-denoise", "decode")], V2_VARIANT).rebuilders).toEqual(["ext.raw-denoise"]);
  });

  it("names an extension's noise-reduction stage", () => {
    expect(buildStageInjection([stage("ext.wavelet", "noise-reduction")], V2_VARIANT).rebuilders).toEqual(["ext.wavelet"]);
  });

  it("names no display stage, nor the built-in denoiser", () => {
    expect(buildStageInjection([stage("ext.look", "display-adjust")], V2_VARIANT).rebuilders).toEqual([]);
    expect(buildStageInjection([DENOISE_STAGE], V2_VARIANT).rebuilders).toEqual([]);
    expect(buildStageInjection([], V2_VARIANT).rebuilders).toEqual([]);
  });
});
