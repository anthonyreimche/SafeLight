// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage's mask copy (mask-stage-instances.ts) compiles as the stage's own
// GLSL under its own uniforms, applied only where its mask covers and blended
// in by that coverage. What it can share with the stage (lookup textures,
// helpers that read no uniform, pass programs) it shares.

import { describe, expect, it } from "vitest";
import { defaultMaskAdjustments, type Mask } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { maskInstances } from "./mask-stage-instances";
import { uniformPrefix } from "./shader-compiler";
import { V2_VARIANT } from "./shaders";
import { buildStageInjection } from "./stage-injection";

const GAIN: ProcessingStageContribution = {
  id: "acme.gain",
  name: "Gain",
  phase: "scene-linear",
  glsl: "lin *= amount;",
  uniforms: [{ key: "amount", glslType: "float", default: 1 }],
  mask: { maskable: true },
};

const mask = (id: string, bag: Record<string, unknown>): Mask => ({
  id,
  name: id,
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [],
  bag,
});

/** The stage set with one copy of `s` per bag given, built for version 2. */
function build(s: ProcessingStageContribution, ...bags: Record<string, unknown>[]) {
  const masks = bags.map((bag, i) => mask(`m${i}`, bag));
  const { stages } = maskInstances([s], masks, V2_VARIANT);
  return buildStageInjection(stages, V2_VARIANT);
}

const one = (s: ProcessingStageContribution) => build(s, { [`${s.id}.amount`]: 2 });
const copyPfx = (s: ProcessingStageContribution, n = 0) => uniformPrefix(`${s.id}@${n}`);
const count = (text: string, part: string) => text.split(part).length - 1;

describe("a stage's mask copy", () => {
  it("runs only where its mask covers, blended in by the coverage", () => {
    const text = one(GAIN).injection.sceneLinear;
    const slot = `${copyPfx(GAIN)}slMaskSlot`;
    expect(text).toContain(`int slInstSlot = ${slot};`);
    expect(text).toContain("if (slInstSlot >= 0 && mcovs[slInstSlot] > 0.0) {");
    expect(text).toContain("vec3 slInstPre = lin;");
    expect(text).toContain("lin = mix(slInstPre, lin, mcovs[slInstSlot]);");
  });

  it("declares its mask slot and hands the renderer its name", () => {
    const built = one(GAIN);
    const slot = `${copyPfx(GAIN)}slMaskSlot`;
    expect(built.injection.uniforms).toContain(`uniform int ${slot};`);
    expect(built.maskSlots).toEqual([{ stageId: `${GAIN.id}@0`, glslName: slot }]);
  });

  // The prefix is the id hash's high digits, which a copy number at the end
  // of the id leaves alone.
  it("gives every copy of a stage its own namespace", () => {
    const built = build(GAIN, ...Array.from({ length: 12 }, () => ({ [`${GAIN.id}.amount`]: 2 })));
    const names = built.bindings.map((b) => b.glslName);
    expect(new Set(names).size).toBe(13);
  });

  it("reads its own uniforms, bound from its own keys", () => {
    const built = one(GAIN);
    expect(built.injection.sceneLinear).toContain(`lin *= ${copyPfx(GAIN)}amount;`);
    expect(built.bindings.map((b) => b.qualifiedKey)).toEqual([`${GAIN.id}.amount`, `${GAIN.id}@0.amount`]);
  });

  it("leaves the stage's own block as it was", () => {
    const alone = buildStageInjection([GAIN], V2_VARIANT).injection.sceneLinear;
    expect(one(GAIN).injection.sceneLinear.startsWith(alone)).toBe(true);
    expect(buildStageInjection([GAIN], V2_VARIANT).maskSlots).toEqual([]);
  });

  it("blends the display value in a display stage", () => {
    const display = { ...GAIN, phase: "display-adjust", glsl: "c *= amount;" } as const;
    const text = one(display).injection.effects;
    expect(text).toContain("vec3 slInstPre = c;");
    expect(text).toContain("c = mix(slInstPre, c, mcovs[slInstSlot]);");
  });

  // A display stage that declares no space gets clipped values on version 2.
  // Its copy clips only what its mask covers, and blends with the unclipped value.
  it("clips a legacy display stage's input inside its mask only", () => {
    const legacy = { ...GAIN, phase: "display-adjust", glsl: "c *= amount;" } as const;
    const built = one(legacy);
    const [ahead, copy] = built.injection.effects.split("{\nint slInstSlot");
    expect(count(ahead, "c = clamp(c, 0.0, 1.0);")).toBe(1);
    expect(copy).toContain("vec3 slInstPre = c;\nc = clamp(c, 0.0, 1.0);");
    expect(built.steps.filter((s) => s.kind === "clamp")).toHaveLength(1);
  });

  it("keeps the variables it would produce to itself", () => {
    const producer: ProcessingStageContribution = {
      ...GAIN,
      glsl: "float level = amount;\nlin *= level;",
      produces: [{ name: "acmeLevel", glslType: "float", producer: "level" }],
    };
    const text = one(producer).injection.sceneLinear;
    expect(count(text, "isv_acmeLevel = (level")).toBe(1);
    expect(text).toContain("float isv_acmeLevel = isv_acmeLevel;");
  });

  it("samples the stage's lookup texture rather than declaring its own", () => {
    const lut: ProcessingStageContribution = {
      ...GAIN,
      glsl: "lin = texture(ramp, lin.rg).rgb * amount;",
      textures: [{ key: "ramp", kind: "lut" }],
    };
    const built = one(lut);
    const parentRamp = `${uniformPrefix(lut.id)}ramp`;
    expect(count(built.injection.uniforms, "uniform sampler2D")).toBe(1);
    expect(built.injection.sceneLinear).toContain(`texture(${parentRamp}, lin.rg).rgb * ${copyPfx(lut)}amount`);
    expect(built.textureBindings.map((t) => t.qualifiedKey)).toEqual([`${lut.id}.ramp`]);
  });

  it("calls the stage's helpers when they read no uniform", () => {
    const helped = { ...GAIN, glsl: "lin = twice(lin) * amount;", helpers: "vec3 twice(vec3 v) { return v * 2.0; }" };
    const built = one(helped);
    expect(count(built.injection.helpers, "vec3 _")).toBe(1);
    const parentHelper = built.injection.helpers.match(/vec3 (\w+)\(/)![1];
    expect(count(built.injection.sceneLinear, `${parentHelper}(lin)`)).toBe(2);
  });

  it("calls the stage's helpers when only their comments name a uniform", () => {
    const helpers = "// scales by the amount\nvec3 twice(vec3 v) { /* amount-free */ return v * 2.0; }";
    const helped = { ...GAIN, glsl: "lin = twice(lin) * amount;", helpers };
    expect(count(one(helped).injection.helpers, "vec3 _")).toBe(1);
  });

  it("gets its own helpers when they read a uniform", () => {
    const helped = { ...GAIN, glsl: "lin = scaled(lin);", helpers: "vec3 scaled(vec3 v) { return v * amount; }" };
    const built = one(helped);
    expect(count(built.injection.helpers, "vec3 _")).toBe(2);
    expect(built.injection.helpers).toContain(`return v * ${copyPfx(helped)}amount;`);
  });

  describe("with passes", () => {
    const blurred: ProcessingStageContribution = {
      ...GAIN,
      glsl: "lin = mix(lin, stageResult, amount);",
      passes: [{ glsl: "c = readPrev(vUv) * radius;", uniforms: [{ key: "radius", glslType: "float", default: 0 }] }],
    };

    it("draws the stage's pass programs, driven by its own keys", () => {
      const [stage, copy] = one(blurred).prepass;
      expect(copy.stageId).toBe(`${blurred.id}@0`);
      expect(copy.passesOf).toBe(blurred.id);
      expect(copy.passes[0].fragmentSource).toBe(stage.passes[0].fragmentSource);
      expect(copy.passes[0].bindings).toEqual([
        { ...stage.passes[0].bindings[0], qualifiedKey: `${blurred.id}@0.radius` },
      ]);
    });

    it("reads its own result", () => {
      const built = one(blurred);
      const own = `${copyPfx(blurred)}stageResult`;
      expect(built.prepass[1].resultUniform).toBe(own);
      expect(built.injection.sceneLinear).toContain(`vec3 stageResult = texture(${own}, srcUv).rgb;`);
    });

    it("reads its own result where the glsl names the stage's sampler", () => {
      const named = { ...blurred, glsl: `lin = texelFetch(${uniformPrefix(blurred.id)}stageResult, ivec2(0), 0).rgb;` };
      const text = one(named).injection.sceneLinear;
      expect(text).toContain(`texelFetch(${copyPfx(named)}stageResult, ivec2(0), 0)`);
    });

    it("reads the image as the stage before it left it", () => {
      const current = { ...blurred, reads: "current" } as const;
      const built = build(current, { [`${current.id}.amount`]: 1 }, { [`${current.id}.amount`]: 1 });
      const [stage, first, second] = built.prepass;
      expect([stage.split?.index, first.split?.index, second.split?.index]).toEqual([0, 1, 2]);
      expect(second.split?.upstreamStageIds).toEqual([current.id, `${current.id}@0`]);
    });
  });
});
