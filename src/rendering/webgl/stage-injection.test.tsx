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
import { useRegistry } from "@/extensions/registry";
import {
  PROCESSING_PHASE_ORDER,
  type ProcessingPhase,
  type ProcessingStageContribution,
  type StagePass,
  type StageSpace,
  type UniformDeclaration,
} from "@/extensions/types";
import { BUILTIN_DENOISE_ID, DENOISE_STAGE } from "./builtin-denoise";
import { compileShaderSource, getActiveStages } from "./shader-compiler";
import { V1_VARIANT, V2_VARIANT, type ShaderVariant } from "./shaders";
import { CORE_DISPLAY_CLAMP, PHASES, buildStageInjection } from "./stage-injection";
import { builtinStage } from "./webgl.test-support";

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

  it("never clips ahead of core vignette and grain", () => {
    const core = flagged({ id: "core.vignette", phase: "effects", glsl: "c = c;" });
    expect(buildStageInjection([core], V2_VARIANT).injection.effects).not.toContain("clamp");
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

// The shipped Vignette and Grain end in the clamp the old core always applied.
// Version 1 compiles their helpers as written. Version 2 drops that line, so what
// they make reaches the stages after them with its full range. The line is found
// as text, so the helpers and the builder have to agree on it.
describe("the clamp that closes the core Vignette and Grain helpers", () => {
  const SHIPPED = ["core.vignette", "core.grain"].map(builtinStage);
  const CLAMP = "return clamp(c, 0.0, 1.0);";
  const occurrences = (text: string, snippet: string): number => text.split(snippet).length - 1;
  const helpersOf = (stages: ProcessingStageContribution[], variant: ShaderVariant): string =>
    buildStageInjection(stages, variant).injection.helpers;

  it("is the line version 1 compiles", () => {
    expect(CORE_DISPLAY_CLAMP).toBe(CLAMP);
  });

  for (const stage of SHIPPED) {
    it(`closes ${stage.id} once`, () => {
      expect(occurrences(stage.helpers ?? "", CORE_DISPLAY_CLAMP)).toBe(1);
    });
  }

  it("stays under version 1, which emits the helpers as written", () => {
    const helpers = helpersOf(SHIPPED, V1_VARIANT);
    for (const stage of SHIPPED) expect(helpers).toContain(stage.helpers);
    expect(occurrences(helpers, CORE_DISPLAY_CLAMP)).toBe(SHIPPED.length);
  });

  it("goes under version 2, and nothing else changes", () => {
    const helpers = helpersOf(SHIPPED, V2_VARIANT);
    expect(helpers).not.toMatch(/return\s+clamp\(c,/);
    for (const stage of SHIPPED) {
      const unclamped = (stage.helpers ?? "").replace(CORE_DISPLAY_CLAMP, "return c;");
      expect(helpers).toContain(unclamped);
    }
  });

  it("goes from every place a core stage has it", () => {
    const twice = flagged({
      id: "core.twice",
      phase: "effects",
      glsl: "c = both(c);",
      helpers: `vec3 both(vec3 c) {\n  if (c.r > 2.0) ${CLAMP}\n  c *= 0.5;\n  ${CLAMP}\n}`,
    });
    expect(occurrences(helpersOf([twice], V1_VARIANT), CLAMP)).toBe(2);
    const v2 = helpersOf([twice], V2_VARIANT);
    expect(occurrences(v2, CLAMP)).toBe(0);
    expect(occurrences(v2, "return c;")).toBe(2);
  });

  it("stays in an extension stage's helpers under both versions", () => {
    const clipper = flagged({
      id: "acme.clipper",
      phase: "effects",
      glsl: "c = clipToWhite(c);",
      helpers: `vec3 clipToWhite(vec3 c) {\n  ${CLAMP}\n}`,
    });
    for (const variant of [V1_VARIANT, V2_VARIANT]) {
      expect(helpersOf([clipper], variant)).toContain(CLAMP);
    }
  });

  // Pass programs are keyed on the signature, so it can't see the version: the
  // line goes when the helpers are emitted, and the stage itself never changes.
  it("doesn't change the signature", () => {
    const v1 = buildStageInjection(SHIPPED, V1_VARIANT);
    const v2 = buildStageInjection(SHIPPED, V2_VARIANT);
    expect(v2.injection.helpers).not.toBe(v1.injection.helpers);
    expect(v2.sig).toBe(v1.sig);
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

    // compileShaderSource and getActiveStages are the other two places that order
    // stages, and they order through the same sort, so the three cannot disagree.
    describe("in the test-only compiler and the registry bridge", () => {
      const stages = [
        flagged({ id: "acme.late", priority: 10, after: ["acme.base"] }),
        flagged({ id: "acme.base" }),
        flagged({ id: "acme.loop.a", priority: 20, after: ["acme.loop.b"] }),
        flagged({ id: "acme.loop.b", priority: 30, after: ["acme.loop.a"] }),
        flagged({ id: "acme.fx", phase: "effects", priority: 1 }),
      ];
      const expected = ["acme.loop.a", "acme.loop.b", "acme.base", "acme.late", "acme.fx"];

      it("gives the order the injection gives", () => {
        quietWarn();
        expect(orderOf(stages)).toEqual(expected);
        expect(compileShaderSource(stages).stageIds).toEqual(expected);
      });

      it("hands the registry's stages over in that order", () => {
        quietWarn();
        const before = useRegistry.getState().processingStages;
        try {
          useRegistry.setState({
            processingStages: Object.fromEntries(
              stages.map((s) => [s.id, { ...s, extensionId: "acme" }]),
            ),
          });
          expect(getActiveStages().map((s) => s.id)).toEqual(expected);
        } finally {
          useRegistry.setState({ processingStages: before });
        }
      });
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
