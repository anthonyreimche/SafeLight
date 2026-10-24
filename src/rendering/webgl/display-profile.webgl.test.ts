// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A Linux display profile converts the frames the live view shows, through the
// output-space stage export already uses, and nothing that measures them: the
// histogram and Upright read the plain output, and an export space wins.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION } from "@/catalog/types";
import { outputDecode } from "@/rendering/color-space";
import { DISPLAY_CURVE_CODE, type MonitorTransform } from "@/rendering/display-profile";
import { outputPixel } from "@/rendering/output-map";
import { apply3, decodePerceptual, type Vec3 } from "@/rendering/stage-space";
import type { WebGLRenderer } from "./renderer";
import {
  OPEN_PROBE,
  PIXEL_TOLERANCE,
  adobeDisplay,
  floatImage,
  identityParams,
  pixelAt,
  toHalf,
  withRenderer,
  worstDifference,
  type Frame,
} from "./webgl.test-support";

const COLOURS: [number, number, number][] = [
  [0.18, 0.18, 0.18],
  [0.4, 0.1, 0.06],
  [0.06, 0.3, 0.1],
  [0.08, 0.1, 0.45],
  [0.5, 0.4, 0.2],
  [0.3, 0.3, 0.6],
  [0.12, 0.25, 0.25],
  [0.6, 0.55, 0.5],
];
const SOURCE = floatImage(COLOURS.length, 1, (x) => COLOURS[x]);

function capture(renderer: WebGLRenderer): Frame {
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

/** What the output stage makes of a plain (display sRGB) frame for `t`. */
function converted(plain: Frame, t: MonitorTransform): Frame {
  const decode = outputDecode("srgb");
  const data = new Float32Array(plain.data);
  const m = t.matrix;
  for (let o = 0; o < data.length; o += 4) {
    const lin = [decode(data[o]), decode(data[o + 1]), decode(data[o + 2])];
    for (let row = 0; row < 3; row++) {
      const v = m[row] * lin[0] + m[3 + row] * lin[1] + m[6 + row] * lin[2];
      data[o + row] = Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.19921875);
    }
  }
  return { ...plain, data };
}

const VERSIONS = [LEGACY_PROCESS_VERSION, CURRENT_PROCESS_VERSION];

describe("display profile on the live renderer", () => {
  for (const processVersion of VERSIONS) {
    it(`converts version ${processVersion} frames into the monitor's profile`, () => {
      const t = adobeDisplay();
      withRenderer({ stages: [] }, (renderer) => {
        renderer.setImage(SOURCE);
        renderer.setParams(identityParams({ processVersion }));
        const plain = capture(renderer);
        renderer.setMonitorTransform(t);
        const shown = capture(renderer);
        expect(worstDifference(shown, plain)).toBeGreaterThan(0.02);
        expect(worstDifference(shown, converted(plain, t))).toBeLessThan(PIXEL_TOLERANCE);

        renderer.setMonitorTransform(null);
        expect(worstDifference(capture(renderer), plain)).toBe(0);
      });
    });
  }

  // Colours Adobe RGB can't hold: a green past every gamut, a blue and a green
  // the knee compresses, and light over range. Version 2 clamps them; version 3
  // maps them into the monitor's gamut, at the pixel's lightness and hue.
  const BEYOND_ADOBE: Vec3[] = [[-1, 1, -1], [-0.4, 0.6, 1], [-0.8, 1, 0], [2.5, 1.2, 0.6]];
  const BEYOND_SCENE = floatImage(BEYOND_ADOBE.length * 4, 4, (x) => BEYOND_ADOBE[Math.floor(x / 4)]);

  it("maps version 3 frames into the monitor's gamut, where version 2 still clamps", () => {
    const t = adobeDisplay();
    const m = t.matrix;
    const monitorMatrix = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    for (const c of BEYOND_ADOBE) {
      const shown = apply3(monitorMatrix, [decodePerceptual(c[0]), decodePerceptual(c[1]), decodePerceptual(c[2])]);
      expect(shown.some((v) => v < 0 || v > 1), `${c} is outside the monitor`).toBe(true);
    }
    withRenderer({ stages: [], pipeline: OPEN_PROBE, processVersionCap: 3 }, (renderer) => {
      renderer.setImage(BEYOND_SCENE);
      renderer.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      const plain = capture(renderer);
      renderer.setMonitorTransform(t);
      const v2 = capture(renderer);
      expect(worstDifference(v2, converted(plain, t))).toBeLessThan(PIXEL_TOLERANCE);

      renderer.setParams(identityParams({ processVersion: 3 }));
      const v3 = capture(renderer);
      BEYOND_ADOBE.forEach((c, i) => {
        const want = outputPixel([toHalf(c[0]), toHalf(c[1]), toHalf(c[2])], monitorMatrix, DISPLAY_CURVE_CODE[t.curve]);
        const got = pixelAt(v3, i * 4 + 1, 2);
        for (let ch = 0; ch < 3; ch++) expect(Math.abs(got[ch] - want[ch]), `${c} ch ${ch}`).toBeLessThan(2e-3);
      });
      expect(worstDifference(v3, v2), "version 3 differs from the clamp").toBeGreaterThan(0.02);
    });
  });

  it("measures the histogram on the plain output, and still shows the conversion after", () => {
    withRenderer({ stages: [] }, (renderer) => {
      renderer.setImage(SOURCE);
      renderer.setParams(identityParams());
      renderer.render();
      const plain = renderer.computeHistogram();

      renderer.setMonitorTransform(adobeDisplay());
      const shown = capture(renderer);
      renderer.render();
      const measured = renderer.computeHistogram();
      for (const channel of ["r", "g", "b", "luma"] as const) {
        expect(Array.from(measured[channel]), channel).toEqual(Array.from(plain[channel]));
      }
      expect(worstDifference(capture(renderer), shown)).toBe(0);
    });
  });

  it("finds Upright's lines in the plain output", () => {
    withRenderer({ stages: [] }, (renderer) => {
      renderer.setImage(SOURCE);
      renderer.setParams(identityParams());
      renderer.render();
      const plain = renderer.readDownscaledPixels(8);

      renderer.setMonitorTransform(adobeDisplay());
      renderer.render();
      const measured = renderer.readDownscaledPixels(8);
      expect(measured && Array.from(measured.data)).toEqual(plain && Array.from(plain.data));
    });
  });

  it("leaves an export's output space alone", () => {
    withRenderer({ stages: [] }, (renderer) => {
      renderer.setImage(SOURCE);
      renderer.setParams(identityParams());
      renderer.setOutputColorSpace("prophoto-rgb");
      const exported = capture(renderer);
      renderer.setMonitorTransform(adobeDisplay());
      expect(worstDifference(capture(renderer), exported)).toBe(0);
    });
  });
});
