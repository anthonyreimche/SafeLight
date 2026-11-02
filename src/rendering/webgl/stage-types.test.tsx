// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The uniform shapes the core tools need from the stage path: arrays (HSL's
// eight bands), matrices bound from the bag, and per-photo textures a stage's
// derive fills (the tone curve's lookup table). stage-types.webgl.test.ts
// binds them on a real context.

import { afterEach, describe, expect, it, vi } from "vitest";
import { freshParams } from "@/catalog/types";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { checkStageContract } from "@/extensions/stage-validation";
import { unregisterExtension } from "@/extensions/registry";
import { deriveStageValues } from "../stage-derive";
import { windowDeriveContext } from "../window-derive";
import { uniformPrefix } from "./shader-compiler";
import { V2_VARIANT } from "./shaders";
import { isStandIn } from "./core-reads";
import { buildStageInjection } from "./stage-injection";

/** The stage's own declarations, without core's stand-ins (core-reads.ts). */
const ownDeclarations = (uniforms: string) =>
  uniforms
    .split("\n")
    .filter((l) => !isStandIn(l))
    .join("\n");

const BANDS: ProcessingStageContribution = {
  id: "safelight.hsl.bands",
  name: "Bands",
  phase: "display-adjust",
  glsl: "c *= uBandGain[0];",
  uniforms: [{ key: "uBandGain", glslType: "float", length: 8, default: [1, 1, 1, 1, 1, 1, 1, 1] }],
};

const LUT: StageTextureData = { data: new Uint8Array(256 * 4), width: 256, height: 1, format: "rgba8", version: 1 };

const CURVE: ProcessingStageContribution = {
  id: "safelight.tone-curve.curve",
  name: "Curve",
  phase: "display-adjust",
  glsl: "c = texture(uCurveLut, vec2(c.r, 0.5)).rgb;",
  uniforms: [],
  textures: [{ key: "uCurveLut", kind: "photo" }],
  derive: () => ({ uCurveLut: LUT }),
};

const owned = (extensionId: string, s: ProcessingStageContribution) => ({ ...s, extensionId });

afterEach(() => {
  unregisterExtension("safelight.tone-curve");
  vi.restoreAllMocks();
});

describe("array uniforms", () => {
  it("are declared with their length, raw for an official stage", () => {
    const { injection, bindings } = buildStageInjection([owned("safelight.hsl", BANDS)], V2_VARIANT);
    expect(ownDeclarations(injection.uniforms)).toBe("uniform float uBandGain[8];");
    expect(bindings[0]).toMatchObject({ glslName: "uBandGain", glslType: "float", length: 8 });
  });

  it("are declared with their length under an extension's prefix", () => {
    const stage = { ...BANDS, id: "acme.bands", glsl: "c *= uBandGain[0];" };
    const { injection, bindings } = buildStageInjection([owned("acme", stage)], V2_VARIANT);
    expect(ownDeclarations(injection.uniforms)).toBe(`uniform float ${uniformPrefix("acme.bands")}uBandGain[8];`);
    expect(bindings[0].length).toBe(8);
  });

  it("are refused a length that isn't a whole number from 1 to 64", () => {
    for (const length of [0, 65, 2.5, "8"]) {
      const stage = { ...BANDS, id: "acme.bands", uniforms: [{ ...BANDS.uniforms[0], length: length as number }] };
      expect(checkStageContract(stage, "acme").error).toBe(
        `stage "acme.bands": uniform "uBandGain" has length ${JSON.stringify(length)}, which must be a whole number from 1 to 64`,
      );
    }
  });

  it("may run to 256 on an official stage", () => {
    const sized = (length: number) => ({ ...BANDS, uniforms: [{ ...BANDS.uniforms[0], length }] });
    expect(checkStageContract(sized(96), "safelight.hsl").error).toBeNull();
    expect(checkStageContract(sized(257), "safelight.hsl").error).toBe(
      'stage "safelight.hsl.bands": uniform "uBandGain" has length 257, which must be a whole number from 1 to 256',
    );
  });

  it("are refused on matrices and samplers", () => {
    const stage = { ...BANDS, uniforms: [{ key: "uM", glslType: "mat3" as const, length: 2, default: [] }] };
    expect(checkStageContract(stage, "safelight.hsl").error).toBe(
      'stage "safelight.hsl.bands": uniform "uM" is a mat3, which can\'t be an array',
    );
  });
});

describe("per-photo textures", () => {
  it("are declared raw with their binding on an official stage", () => {
    const { injection, textureBindings } = buildStageInjection([owned("safelight.tone-curve", CURVE)], V2_VARIANT);
    expect(ownDeclarations(injection.uniforms)).toBe("uniform sampler2D uCurveLut;");
    expect(textureBindings).toEqual([
      { qualifiedKey: "safelight.tone-curve.curve.uCurveLut", glslName: "uCurveLut", kind: "photo" },
    ]);
  });

  it("are filled by the stage's derive", () => {
    const stage = owned("safelight.tone-curve", CURVE);
    expect(deriveStageValues(freshParams(), [stage], windowDeriveContext)).toEqual({ "safelight.tone-curve.curve.uCurveLut": LUT });
  });

  it("are refused to a stage without derive to fill them", () => {
    const stage = { ...CURVE, id: "acme.curve", derive: undefined };
    expect(checkStageContract(stage, "acme").error).toBe(
      'stage "acme.curve": texture "uCurveLut" is a photo texture, which only a stage of Safelight\'s own fills (derive)',
    );
  });
});
