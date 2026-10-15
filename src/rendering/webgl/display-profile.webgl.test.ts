// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A Linux display profile converts the frames the live view shows, through the
// output-space stage export already uses, and nothing that measures them: the
// histogram and Upright read the plain output, and an export space wins.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION } from "@/catalog/types";
import { buildIccProfile, outputDecode } from "@/rendering/color-space";
import { parseDisplayProfile, type MonitorTransform } from "@/rendering/display-profile";
import type { WebGLRenderer } from "./renderer";
import {
  PIXEL_TOLERANCE,
  floatImage,
  identityParams,
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

function adobeDisplay(): MonitorTransform {
  const parsed = parseDisplayProfile(buildIccProfile("adobe-rgb"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.profile.transform;
}

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
