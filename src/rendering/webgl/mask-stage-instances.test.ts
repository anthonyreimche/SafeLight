// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which masks run which extension stage: a maskable stage gets one copy per
// mask whose bag holds one of its keys, numbered in mask order, so the
// program only changes with how many masks use each stage.

import { describe, expect, it } from "vitest";
import { MAX_MASKS, defaultMaskAdjustments, type Mask } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { isMaskInstance, maskInstances } from "./mask-stage-instances";
import { V1_VARIANT, V2_VARIANT } from "./shaders";

const stage = (
  id: string,
  over: Partial<ProcessingStageContribution> = {},
): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "scene-linear",
  glsl: "lin *= amount;",
  uniforms: [{ key: "amount", glslType: "float", default: 1 }],
  mask: { maskable: true },
  ...over,
});

const mask = (id: string, bag?: Record<string, unknown>, over: Partial<Mask> = {}): Mask => ({
  id,
  name: id,
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [],
  ...(bag ? { bag } : {}),
  ...over,
});

const ids = (stages: readonly ProcessingStageContribution[]) => stages.map((s) => s.id);

describe("maskInstances", () => {
  it("hands back the very stage list when no mask uses a stage", () => {
    const stages = [stage("gain")];
    const got = maskInstances(stages, [mask("a"), mask("b", { "other.amount": 2 })], V2_VARIANT);
    expect(got.stages).toBe(stages);
    expect(got.bag).toEqual({});
    expect(got.sig).toBe("");
  });

  it("adds a copy right after the stage for a mask whose bag holds one of its keys", () => {
    const stages = [stage("gain"), stage("later")];
    const got = maskInstances(stages, [mask("a", { "gain.amount": 2 })], V2_VARIANT);
    expect(ids(got.stages)).toEqual(["gain", "gain@0", "later"]);
    const copy = got.stages[1];
    expect(isMaskInstance(copy) && copy.instanceOf).toBe("gain");
    expect(copy.after).toEqual(["gain"]);
    expect(copy.glsl).toBe(stages[0].glsl);
    expect(got.sig).toBe("gain@0");
  });

  it("numbers copies in mask order and chains each after the one before", () => {
    const masks = [mask("a", { "gain.amount": 2 }), mask("b"), mask("c", { "gain.amount": 3 })];
    const got = maskInstances([stage("gain")], masks, V2_VARIANT);
    expect(ids(got.stages)).toEqual(["gain", "gain@0", "gain@1"]);
    expect(got.stages[2].after).toEqual(["gain@0"]);
    expect(got.slots.get("gain@0")).toBe(0);
    expect(got.slots.get("gain@1")).toBe(2);
  });

  it("moves each mask's values under its copy's keys", () => {
    const masks = [mask("a", { "gain.amount": 2 }), mask("b", { "gain.amount": 3, "x.y": 1 })];
    const got = maskInstances([stage("gain")], masks, V2_VARIANT);
    expect(got.bag).toEqual({ "gain@0.amount": 2, "gain@1.amount": 3 });
  });

  it("counts a key the stage declares only on a pass", () => {
    const blur = stage("blur", {
      uniforms: [],
      passes: [{ glsl: "", uniforms: [{ key: "radius", glslType: "float", default: 0 }] }],
    });
    const got = maskInstances([blur], [mask("a", { "blur.radius": 4 })], V2_VARIANT);
    expect(ids(got.stages)).toEqual(["blur", "blur@0"]);
    expect(got.bag).toEqual({ "blur@0.radius": 4 });
  });

  it("matches whole qualified keys, not a stage id that prefixes another", () => {
    const stages = [stage("bw"), stage("bw.tone", { uniforms: [{ key: "x", glslType: "float", default: 0 }] })];
    const got = maskInstances(stages, [mask("a", { "bw.tone.x": 1 })], V2_VARIANT);
    expect(ids(got.stages)).toEqual(["bw", "bw.tone", "bw.tone@0"]);
  });

  it("leaves out a key the mask holds as undefined", () => {
    const got = maskInstances([stage("gain")], [mask("a", { "gain.amount": undefined })], V2_VARIANT);
    expect(got.sig).toBe("");
  });

  it("copies the stage whole, produced variables included (the injection keeps them local)", () => {
    const producer = stage("te", { produces: [{ name: "teMask", glslType: "float", producer: "1.0" }] });
    const got = maskInstances([producer], [mask("a", { "te.amount": 2 })], V2_VARIANT);
    expect(got.stages[1].produces).toEqual(producer.produces);
  });

  it("copies only stages that opted in", () => {
    const plain = stage("plain", { mask: undefined });
    const got = maskInstances([plain], [mask("a", { "plain.amount": 2 })], V2_VARIANT);
    expect(got.sig).toBe("");
  });

  it.each(["geometry", "decode", "noise-reduction"] as const)(
    "never copies a %s stage, which runs before mask coverage exists",
    (phase) => {
      const early = stage("early", { phase });
      const got = maskInstances([early], [mask("a", { "early.amount": 2 })], V2_VARIANT);
      expect(got.sig).toBe("");
    },
  );

  it.each(["scene-linear", "tone-map", "display-adjust", "effects", "output-encode"] as const)(
    "copies a %s stage",
    (phase) => {
      const late = stage("late", { phase });
      const got = maskInstances([late], [mask("a", { "late.amount": 2 })], V2_VARIANT);
      expect(got.sig).toBe("late@0");
    },
  );

  it("makes no copies on a version 1 photo", () => {
    const stages = [stage("gain")];
    const got = maskInstances(stages, [mask("a", { "gain.amount": 2 })], V1_VARIANT);
    expect(got.stages).toBe(stages);
    expect(got.bag).toEqual({});
  });

  it("keeps a hidden or fully transparent mask's copy but gives it no mask to apply in", () => {
    const masks = [
      mask("a", { "gain.amount": 2 }, { visible: false }),
      mask("b", { "gain.amount": 2 }, { opacity: 0 }),
    ];
    const got = maskInstances([stage("gain")], masks, V2_VARIANT);
    expect(got.sig).toBe("gain@0,gain@1");
    expect(got.slots.get("gain@0")).toBe(-1);
    expect(got.slots.get("gain@1")).toBe(-1);
  });

  it("keeps its signature when the masks swap places, so only the slots move", () => {
    const a = mask("a", { "gain.amount": 2 });
    const b = mask("b");
    const before = maskInstances([stage("gain")], [a, b], V2_VARIANT);
    const after = maskInstances([stage("gain")], [b, a], V2_VARIANT);
    expect(after.sig).toBe(before.sig);
    expect(before.slots.get("gain@0")).toBe(0);
    expect(after.slots.get("gain@0")).toBe(1);
  });

  it("keeps its signature when a mask's values change", () => {
    const before = maskInstances([stage("gain")], [mask("a", { "gain.amount": 2 })], V2_VARIANT);
    const after = maskInstances([stage("gain")], [mask("a", { "gain.amount": 5 })], V2_VARIANT);
    expect(after.sig).toBe(before.sig);
  });

  it("reads only the masks the shader has room for", () => {
    const masks = Array.from({ length: MAX_MASKS + 2 }, (_, i) => mask(`m${i}`, { "gain.amount": i }));
    const got = maskInstances([stage("gain")], masks, V2_VARIANT);
    expect(got.stages).toHaveLength(1 + MAX_MASKS);
  });
});
