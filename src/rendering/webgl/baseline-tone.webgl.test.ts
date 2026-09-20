// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The GLSL baseline and its TypeScript mirror must agree: the mirror is what
// the unit tests pin the look to, the GLSL is what the user sees.

import { describe, expect, it } from "vitest";
import { baselineTone } from "../baseline-tone";
import {
  LINEAR_PROBE_PIPELINE,
  PIXEL_TOLERANCE,
  type Frame,
  floatImage,
  identityParams,
  pixelAt,
  withRenderer,
} from "./webgl.test-support";
import type { WebGLRendererOpts } from "./renderer";

const toSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** A flat RAW float source at `value`, rendered at default params. */
function renderFlat(value: number, opts?: WebGLRendererOpts): Frame {
  return withRenderer(opts, (renderer) => {
    renderer.setImage(floatImage(16, 16, () => [value, value, value]));
    renderer.setParams(identityParams());
    renderer.render();
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

function centre(frame: Frame): [number, number, number] {
  return pixelAt(frame, Math.floor(frame.width / 2), Math.floor(frame.height / 2));
}

describe("default baseline tone on the GPU", () => {
  for (const value of [0.02, 0.09, 0.18, 0.5]) {
    it(`renders scene-linear ${value} where the TypeScript mirror lands it`, () => {
      const expected = toSrgb(baselineTone(value));
      for (const channel of centre(renderFlat(value))) {
        expect(Math.abs(channel - expected)).toBeLessThan(PIXEL_TOLERANCE);
      }
    });
  }

  it("stays out of a display transform that owns its own baseline", () => {
    const frame = renderFlat(0.09, { stages: [], pipeline: LINEAR_PROBE_PIPELINE });
    for (const channel of centre(frame)) {
      expect(Math.abs(channel - 0.09)).toBeLessThan(PIXEL_TOLERANCE);
    }
  });
});
