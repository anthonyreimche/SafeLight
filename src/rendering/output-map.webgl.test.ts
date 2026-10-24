// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Version 3's output stage on the real renderer. The probe transform hands the
// working colour through as display values and skips the core shoulder, so `c`
// at the output stage is the scene as the RGBA16F source holds it, and the
// TypeScript twin (output-map.ts) predicts every pixel.

import { describe, expect, it } from "vitest";
import { mat3Invert } from "./transform";
import { OUT_SPACE_CODE, outMatrix, type ColorSpaceId } from "./color-space";
import { gamutMap, lmsMatrices, outputPixel } from "./output-map";
import { apply3, decodePerceptual, type Vec3 } from "./stage-space";
import {
  OPEN_PROBE, builtinStages, each, expectColour, floatImage, identityParams, patchPixel, rendererBuildError,
  toHalf, withRenderer, type Frame,
} from "./webgl/webgl.test-support";
import { LEGACY_EXTENSION_STAGES } from "./webgl/v1-identity.fixtures";

// The reviewer's colours (linear Adobe RGB, as working Rec.709) in five bands,
// then in-gamut colours, over-range light and negatives. slOutput reads every
// patch as a perceptual value, which pulls the reviewer's colours inside
// Display P3 and ProPhoto, so the last three carry the boundary search there: a
// green outside every target, a blue the knee compresses (short of Rec.2020's
// boundary) in sRGB, P3 and Adobe RGB, and a green inside ProPhoto but past its
// knee.
const ADOBE_TO_SRGB = mat3Invert(outMatrix("adobe-rgb"));
const PATCHES: Vec3[] = [
  ...([[0, 1, 0], [0, 0.8, 0.8], [0.05, 0.45, 0.3], [0.02, 0.25, 0.35], [0.9, 0.55, 0]] as Vec3[]).map((a) => apply3(ADOBE_TO_SRGB, a)),
  [0.1, 0.3, 0.05], [0.6, 0.35, 0.25], [0.5, 0.5, 0.5], [2.5, 1.2, 0.6], [-0.2, 0.6, -0.1],
  [-1, 1, -1], [-0.4, 0.6, 1], [-0.8, 1, 0],
];
/** The patches the boundary search maps in `space`, by the twin. Lightness at
 *  or past white or black maps straight to white or black, so a neutral result
 *  doesn't count. */
function mappedPatches(space: ColorSpaceId): number[] {
  const out = outMatrix(space);
  return PATCHES.flatMap((p, i) => {
    const lin = apply3(out, each(each(p, toHalf), decodePerceptual));
    const [r, g, b] = gamutMap(lin, lmsMatrices(out));
    const moved = [r, g, b].some((v, k) => v !== Math.min(Math.max(lin[k], 0), 1));
    return moved && !(r === g && g === b) ? [i] : [];
  });
}
const W = PATCHES.length * 4;
const H = 4;
const SCENE = floatImage(W, H, (x) => PATCHES[Math.floor(x / 4)]);

function frame(processVersion: number, space: ColorSpaceId): Frame {
  return withRenderer({ stages: builtinStages(), pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
    r.setImage(SCENE);
    r.setOutputColorSpace(space);
    r.setParams(identityParams({ processVersion }));
    const f = r.captureFloatFrame();
    if (!f) throw new Error("captureFloatFrame returned null");
    return f;
  });
}

describe("version 3 output on the GPU", () => {
  it("compiles for the built-ins, with the stock transform, and every legacy stage phase", () => {
    expect(rendererBuildError({ stages: [...builtinStages(), ...LEGACY_EXTENSION_STAGES], pipeline: OPEN_PROBE, processVersionCap: 3 })).toBeNull();
    expect(rendererBuildError({ stages: builtinStages(), processVersionCap: 3 })).toBeNull();
  });

  // T6
  for (const space of ["srgb", "display-p3", "adobe-rgb", "prophoto-rgb"] as const) {
    it(`matches the TypeScript twin, ${space}`, () => {
      expect(mappedPatches(space), "patches the boundary search maps").not.toEqual([]);
      const f = frame(3, space);
      PATCHES.forEach((p, i) => {
        expectColour(patchPixel(f, i), outputPixel(each(p, toHalf), outMatrix(space), OUT_SPACE_CODE[space]), `patch ${i}`);
      });
    });
  }

  // T7: an Adobe RGB export holds the colours outside sRGB that version 2's clamp drops.
  it("keeps colours outside sRGB in an Adobe RGB export, where version 2 drops them", () => {
    const outsideSrgb = (f: Frame, patch: number): boolean => {
      const lin = each(patchPixel(f, patch), (v) => Math.pow(v, 2.19921875));
      return apply3(ADOBE_TO_SRGB, lin).some((v) => v < -0.02);
    };
    const v3 = frame(3, "adobe-rgb");
    const v2 = frame(2, "adobe-rgb");
    for (const patch of [0, 1]) {
      expect(outsideSrgb(v3, patch), `v3 patch ${patch}`).toBe(true);
      expect(outsideSrgb(v2, patch), `v2 patch ${patch}`).toBe(false);
    }
  });
});
