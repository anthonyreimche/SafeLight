// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A float capture at "decode" hands back the linear colour the decode and
// noise-reduction stages leave: their work is in it, white balance, exposure
// and every later tool's is not.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { CapturePoint } from "@/rendering/float-frame";
import {
  LINEAR_PROBE_PIPELINE,
  PIXEL_TOLERANCE,
  basicStagesFor,
  floatImage,
  identityParams,
  pixelAt,
  withRenderer,
} from "./webgl.test-support";

const HALVING: ProcessingStageContribution = {
  id: "test.halving",
  name: "Halving decode stage",
  phase: "decode",
  glsl: "lin *= 0.5;",
  uniforms: [],
};

const TEXEL = [0.2, 0.3, 0.1] as const;

function captured(point: CapturePoint, exposure: number): number[] {
  return withRenderer(
    { stages: [...basicStagesFor(CURRENT_PROCESS_VERSION), HALVING], pipeline: LINEAR_PROBE_PIPELINE },
    (renderer) => {
      renderer.setImage(floatImage(16, 16, () => TEXEL));
      renderer.setParams(identityParams({ exposure, processVersion: CURRENT_PROCESS_VERSION }));
      const frame = renderer.readFloatFrame(point);
      if (!frame) throw new Error("readFloatFrame returned null");
      return pixelAt(frame, 8, 8);
    },
  );
}

describe('capture point "decode"', () => {
  it("holds the decode stages' work and not the exposure after them", () => {
    const at = captured("decode", 1);
    at.forEach((v, i) => expect(Math.abs(v - TEXEL[i] * 0.5)).toBeLessThan(PIXEL_TOLERANCE));
  });

  it("differs from the scene the display transform receives", () => {
    const scene = captured("scene", 1);
    expect(scene[1]).toBeGreaterThan(TEXEL[1] * 0.5 * 1.5);
  });
});
