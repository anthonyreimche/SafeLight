// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The GLSL baseline and its TypeScript mirror must agree: the mirror is what
// the unit tests pin the look to, the GLSL is what the user sees.

import { describe, expect, it } from "vitest";
import type { DevelopParams } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { baselineRefit, baselineTone } from "../baseline-tone";
import { toneShadows } from "../local-tone";
import {
  LINEAR_PROBE_PIPELINE,
  NEGATING_PIPELINE,
  PIXEL_TOLERANCE,
  type Frame,
  floatImage,
  identityParams,
  pixelAt,
  withRenderer,
} from "./webgl.test-support";
import type { WebGLRenderer, WebGLRendererOpts } from "./renderer";

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

  // Colours outside the sRGB primaries reach the baseline as negative channels.
  // Values are exact in half float, the precision of the source texture.
  for (const value of [-0.03125, -0.125, -0.25]) {
    it(`carries scene-linear ${value} below black as the mirror does`, () => {
      const expected = -baselineTone(value);
      const frame = renderFlat(value, { stages: [], pipeline: NEGATING_PIPELINE });
      for (const channel of centre(frame)) {
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

// Process version 2 and later: baselineTone, then after clip recovery the refit
// and the camera maker's gain (baseline-tone.ts). Read at the scene point,
// linear, so each value is the working colour the display transform receives.
const V3 = { processVersionCap: 3 } as const;
const grey = (value: number, baselineExposure?: number) => ({
  ...floatImage(16, 16, () => [value, value, value]),
  ...(baselineExposure === undefined ? {} : { baselineExposure }),
});
const refitTone = (x: number): number => baselineRefit(baselineTone(x));

function scene(renderer: WebGLRenderer): [number, number, number] {
  renderer.render();
  const frame = renderer.readFloatFrame("scene");
  if (!frame) throw new Error("readFloatFrame returned null");
  return centre(frame);
}

function renderScene(
  image: ReturnType<typeof grey>,
  params: DevelopParams,
  opts: WebGLRendererOpts = V3,
): [number, number, number] {
  return withRenderer(opts, (renderer) => {
    renderer.setImage(image);
    renderer.setParams(params);
    return scene(renderer);
  });
}

const expectGrey = (got: readonly number[], expected: number) => {
  for (const channel of got) expect(Math.abs(channel - expected) / expected).toBeLessThan(0.01);
};

describe("the version 1 baseline on the GPU", () => {
  it("stays on the frozen curve, whatever the camera", () => {
    expectGrey(renderScene(grey(0.09, 0.31), identityParams({ processVersion: 1 })), baselineTone(0.09));
  });
});

for (const version of [2, 3] as const) describe(`the camera baseline on the GPU, version ${version}`, () => {
  const versionParams = (over: Partial<DevelopParams> = {}) => identityParams({ processVersion: version, ...over });

  for (const value of [0.02, 0.09, 0.18, 0.5]) {
    it(`renders scene-linear ${value} where the refit mirror lands it`, () => {
      expectGrey(renderScene(grey(value), versionParams()), refitTone(value));
    });
  }

  for (const [value, ev] of [[0.09, 0.31], [0.18, -0.28]] as const) {
    it(`raises ${value} by the camera's ${ev} EV on top`, () => {
      expectGrey(renderScene(grey(value, ev), versionParams()), refitTone(value) * 2 ** ev);
    });
  }

  it("restores each resident source's own gain when it is bound again", () => {
    const got = withRenderer(V3, (renderer) => {
      renderer.uploadSource("sony:0", grey(0.09, 0.31));
      renderer.uploadSource("canon:0", grey(0.09));
      renderer.setParams(versionParams());
      renderer.bindSource("sony:0");
      const sony = scene(renderer);
      renderer.bindSource("canon:0");
      return { sony, canon: scene(renderer) };
    });
    expectGrey(got.sony, refitTone(0.09) * 2 ** 0.31);
    expectGrey(got.canon, refitTone(0.09));
  });

  it("keeps the gain out of a display transform that owns its own baseline", () => {
    expectGrey(renderScene(grey(0.09, 0.31), versionParams(), { ...V3, stages: [], pipeline: LINEAR_PROBE_PIPELINE }), 0.09);
  });

  // On a flat frame the region is the pixel, so Shadows at 100 (all region)
  // gives the pixel's own curve, unless the region base missed the refit or
  // the gain and sits a curve and a stop away.
  it("measures Highlights and Shadows regions in the pixel's units", () => {
    const pixel = refitTone(0.04) * 2;
    expectGrey(renderScene(grey(0.04, 1), versionParams({ shadows: 100 })), toneShadows(pixel, 1));
  });

  // A decode stage's passes read the source through the shared pass prelude,
  // which knows only baselineTone. Handing that read straight back as `lin`
  // must change nothing.
  it("agrees with what a decode stage's passes read of the source", () => {
    const passthrough: ProcessingStageContribution = {
      id: "test.passthrough",
      name: "Pass-through",
      phase: "decode",
      glsl: "lin = mix(lin, stageResult, amount);",
      uniforms: [{ key: "amount", glslType: "float", default: 0 }],
      passes: [{ glsl: "c = readPrev(vUv);" }],
    };
    const got = withRenderer({ ...V3, stages: [passthrough] }, (renderer) => {
      renderer.setImage(grey(0.09, 0.31));
      renderer.setParams(versionParams());
      renderer.setContributedParams({ "test.passthrough.amount": 1 });
      return scene(renderer);
    });
    expectGrey(got, refitTone(0.09) * 2 ** 0.31);
  });
});
