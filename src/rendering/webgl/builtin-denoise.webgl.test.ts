// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The built-in denoiser is the only shipped stage that runs prepasses, so this
// is also the coverage for the multi-pass framework: three pass programs, five
// ping-pong iterations in the middle one, and the inline swap of `lin` for the
// result. A break anywhere in that chain leaves the output identical to the
// undenoised frame, which is what the smoothing assertions detect.

import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_DEVELOP_PARAMS,
  LEGACY_PROCESS_VERSION,
  type DevelopParams,
} from "@/catalog/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";
import { baselineTone } from "../baseline-tone";
import { BUILTIN_DENOISE_ID, denoiseBag } from "./builtin-denoise";
import {
  LINEAR_PROBE_PIPELINE,
  NEGATING_PIPELINE,
  PIXEL_TOLERANCE,
  type FloatImage,
  type Frame,
  builtinStage,
  builtinStages,
  floatImage,
  identityParams,
  pixelAt,
  withRenderer,
  worstDifference,
} from "./webgl.test-support";

const SIZE = 32;
const BASE = 0.2;
// Amplitude matters: the a-trous edge-stop works in the variance-stabilised
// domain, where a ±0.006 swing around 0.2 reads as noise and anything much
// larger reads as an edge to preserve. This is the order of real sensor noise.
const NOISE = 0.006;

/** A flat field with a per-texel checker of noise on top: high spatial
 *  frequency, zero mean, so a denoiser has something to remove and an exposure
 *  shift would show up as a change in the frame's mean. */
const NOISY = floatImage(SIZE, SIZE, (x, y) => {
  const v = BASE + ((x + y) % 2 === 0 ? NOISE : -NOISE);
  return [v, v, v];
});

/** Mean absolute difference between horizontally adjacent pixels, away from the
 *  border where the a-trous taps clamp. Falls as the noise is removed. */
function roughness(frame: Frame): number {
  let total = 0;
  let count = 0;
  for (let y = 4; y < frame.height - 4; y++) {
    for (let x = 4; x < frame.width - 5; x++) {
      const a = frame.data[(y * frame.width + x) * 4 + 1];
      const b = frame.data[(y * frame.width + x + 1) * 4 + 1];
      total += Math.abs(a - b);
      count++;
    }
  }
  return total / count;
}

function mean(frame: Frame): number {
  let total = 0;
  for (let i = 1; i < frame.data.length; i += 4) total += frame.data[i];
  return total / (frame.width * frame.height);
}

function renderWith(
  stages: ProcessingStageContribution[],
  params: DevelopParams,
): Frame {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    renderer.setImage(NOISY);
    renderer.setParams(params);
    renderer.setContributedParams(denoiseBag(params));
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

function renderDenoised(params: DevelopParams): Frame {
  return renderWith([builtinStage(BUILTIN_DENOISE_ID)], params);
}

describe("denoiseBag", () => {
  it("stays empty while both amounts are zero, so the prepass is skipped", () => {
    expect(denoiseBag(identityParams({ luminanceNR: 0, colorNR: 0 }))).toEqual({});
  });

  it("carries the luminance sliders once the amount is non-zero", () => {
    const bag = denoiseBag(
      identityParams({
        luminanceNR: 40,
        luminanceNRDetail: 30,
        luminanceNRContrast: 20,
        luminanceNRShadows: 10,
        luminanceNRHighlights: 5,
      }),
    );
    expect(bag[`${BUILTIN_DENOISE_ID}.lumAmount`]).toBe(40);
    expect(bag[`${BUILTIN_DENOISE_ID}.lumDetail`]).toBe(30);
    expect(bag[`${BUILTIN_DENOISE_ID}.lumContrast`]).toBe(20);
    expect(bag[`${BUILTIN_DENOISE_ID}.lumShadows`]).toBe(10);
    expect(bag[`${BUILTIN_DENOISE_ID}.lumHighlights`]).toBe(5);
    expect(bag[`${BUILTIN_DENOISE_ID}.vstScale`]).toBeGreaterThan(0);
    expect(bag[`${BUILTIN_DENOISE_ID}.colAmount`]).toBeUndefined();
  });

  it("carries the colour sliders independently of the luminance ones", () => {
    const bag = denoiseBag(
      identityParams({ colorNR: 60, colorNRDetail: 70, colorNRSmoothness: 80 }),
    );
    expect(bag[`${BUILTIN_DENOISE_ID}.colAmount`]).toBe(60);
    expect(bag[`${BUILTIN_DENOISE_ID}.colDetail`]).toBe(70);
    expect(bag[`${BUILTIN_DENOISE_ID}.colSmooth`]).toBe(80);
    expect(bag[`${BUILTIN_DENOISE_ID}.lumAmount`]).toBeUndefined();
  });
});

describe("the denoise prepass", () => {
  it("smooths high-frequency noise when luminance NR is applied", () => {
    const failures = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const off = renderDenoised(identityParams({ luminanceNR: 0, colorNR: 0 }));
      const on = renderDenoised(identityParams({ luminanceNR: 100, colorNR: 0 }));
      // A failed pass program is caught and logged rather than thrown, which
      // would silently leave the frame undenoised.
      expect(failures).not.toHaveBeenCalled();
      expect(roughness(off)).toBeGreaterThan(NOISE);
      expect(roughness(on)).toBeLessThan(roughness(off) * 0.75);
    } finally {
      failures.mockRestore();
    }
  });

  it("leaves the frame's overall level alone", () => {
    const off = renderDenoised(identityParams({ luminanceNR: 0, colorNR: 0 }));
    const on = renderDenoised(identityParams({ luminanceNR: 100, colorNR: 0 }));
    expect(mean(on)).toBeCloseTo(mean(off), 2);
  });

  it("costs nothing while the sliders are untouched", () => {
    const params = identityParams({ luminanceNR: 0, colorNR: 0 });
    const registered = renderDenoised(params);
    const absent = renderWith([], params);
    for (let i = 0; i < registered.data.length; i++) {
      expect(registered.data[i]).toBe(absent.data[i]);
    }
  });
});

/** Render `image` through the shipped stages, fed the way Develop feeds them:
 *  the typed NR sliders reach the denoiser through its param bag. */
function renderShipped(
  image: FloatImage,
  params: DevelopParams,
  pipeline: ResolvedPipeline,
  stages: ProcessingStageContribution[] = builtinStages(),
): Frame {
  return withRenderer({ stages, pipeline }, (renderer) => {
    renderer.setImage(image);
    renderer.setParams(params);
    renderer.setContributedParams(denoiseBag(params));
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

/** The denoiser as it shipped before it carried signed values: clamped at
 *  black on the way into the prepass, on the way out and at the swap. */
function clampedAtBlack(
  stage: ProcessingStageContribution,
): ProcessingStageContribution {
  if (!stage.passes) throw new Error(`${stage.id} has no passes`);
  const [forward, atrous, inverse] = stage.passes;
  return {
    ...stage,
    glsl: stage.glsl.replace("lin = stageResult;", "lin = max(stageResult, 0.0);"),
    passes: [
      { ...forward, glsl: `c = max(c, 0.0);\n${forward.glsl}` },
      atrous,
      { ...inverse, glsl: `${inverse.glsl}\nc = max(c, 0.0);` },
    ],
  };
}

/** A colourful patch with independent noise in every channel, from a fixed
 *  seed; no channel comes within 0.06 of black. */
const NOISY_COLOUR = (() => {
  let seed = 0x2f6b1d;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 2 ** 32 - 0.5) * 0.04;
  };
  return floatImage(SIZE, SIZE, () => [
    0.35 + noise(),
    0.18 + noise(),
    0.08 + noise(),
  ]);
})();

// Colours outside the sRGB primaries reach the denoiser as channels below
// black. Colour NR is on by default, so clipping them there would undo the
// decode keeping them.
describe("the denoiser with channels below black", () => {
  const OUT_OF_GAMUT = floatImage(SIZE, SIZE, () => [0.3, 0.2, -0.0625]);

  it("keeps a negative channel through at the default Colour NR", () => {
    const centre = (params: DevelopParams) =>
      pixelAt(renderShipped(OUT_OF_GAMUT, params, NEGATING_PIPELINE), 16, 16);
    const off = centre({ ...DEFAULT_DEVELOP_PARAMS, colorNR: 0 });
    const on = centre(DEFAULT_DEVELOP_PARAMS);

    expect(DEFAULT_DEVELOP_PARAMS.colorNR).toBeGreaterThan(0);
    expect(off[2]).toBeGreaterThan(0.02);
    for (const channel of on) expect(Number.isFinite(channel)).toBe(true);
    expect(Math.abs(on[2] - off[2])).toBeLessThan(PIXEL_TOLERANCE);
  });

  it("hands a saturated cyan's negative red to the display transform", () => {
    const cyan = floatImage(SIZE, SIZE, () => [-0.05, 0.4, 0.5]);
    const frame = renderShipped(cyan, DEFAULT_DEVELOP_PARAMS, NEGATING_PIPELINE);
    const [red] = pixelAt(frame, 16, 16);

    expect(Math.abs(red + baselineTone(-0.05))).toBeLessThan(PIXEL_TOLERANCE);
  });

  it("denoises input above black exactly as the clamped stage did", () => {
    const shipped = builtinStage(BUILTIN_DENOISE_ID);
    const clamped = clampedAtBlack(shipped);
    expect(clamped.glsl).toContain("max(stageResult, 0.0)");

    for (const params of [
      DEFAULT_DEVELOP_PARAMS,
      identityParams({ luminanceNR: 60, colorNR: 80 }),
    ]) {
      const render = (p: DevelopParams, stage: ProcessingStageContribution) =>
        renderShipped(NOISY_COLOUR, p, LINEAR_PROBE_PIPELINE, [stage]).data;
      const now = render(params, shipped);
      const before = render(params, clamped);
      const undenoised = render({ ...params, luminanceNR: 0, colorNR: 0 }, shipped);
      let moved = 0;
      for (let i = 0; i < now.length; i++) {
        expect(Math.abs(now[i] - before[i])).toBeLessThan(PIXEL_TOLERANCE);
        moved = Math.max(moved, Math.abs(now[i] - undenoised[i]));
      }
      expect(moved).toBeGreaterThan(1e-3);
    }
  });
});

/** A decode stage whose work is plain to see: it scales each channel of `lin`
 *  by `tint`, handing the stages after it a changed `lin` the way a chromatic
 *  aberration or moiré correction does. */
const TINT_STAGE: ProcessingStageContribution = {
  id: "test.tint",
  name: "Decode tint",
  phase: "decode",
  glsl: "lin *= tint;",
  uniforms: [{ key: "tint", glslType: "vec3", default: [1, 1, 1] }],
};

const WARM = [1.5, 1, 0.5];
const GREY = floatImage(SIZE, SIZE, () => [BASE, BASE, BASE]);

interface TintedOptions {
  image?: FloatImage;
  tint?: number[];
  pipeline?: ResolvedPipeline;
}

/** One frame with the decode stage at `tint` and the denoiser fed as Develop
 *  feeds it, and the split draws the frame took. */
function renderTinted(
  stages: ProcessingStageContribution[],
  params: DevelopParams,
  { image = GREY, tint = WARM, pipeline = LINEAR_PROBE_PIPELINE }: TintedOptions = {},
): { frame: Frame; splits: number } {
  return withRenderer({ stages, pipeline }, (renderer) => {
    renderer.setImage(image);
    renderer.setParams(params);
    renderer.setContributedParams({ ...denoiseBag(params), [`${TINT_STAGE.id}.tint`]: tint });
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return { frame, splits: renderer.renderDrawCounts.split };
  });
}

/** Colour NR at its shipping default of 25 unless `over` says otherwise. */
const atVersion = (processVersion: number, over: Partial<DevelopParams> = {}): DevelopParams =>
  identityParams({ processVersion, colorNR: 25, ...over });

// While Luminance or Colour NR is above 0 the denoiser swaps `lin` for its own
// result. On version 1 its passes make that result from the source, so whatever
// a decode stage did to `lin` is lost. On version 2 they start from the image as
// the decode stages left it.
describe("the denoiser behind a decode stage", () => {
  const denoiser = builtinStage(BUILTIN_DENOISE_ID);
  const centre = (frame: Frame) => pixelAt(frame, SIZE / 2, SIZE / 2);

  it("keeps the decode stage's change on version 2", () => {
    const v2 = (colorNR: number) => atVersion(CURRENT_PROCESS_VERSION, { colorNR });
    const decoded = renderTinted([TINT_STAGE, denoiser], v2(0));
    const denoised = renderTinted([TINT_STAGE, denoiser], v2(25));
    const want = centre(decoded.frame);
    const got = centre(denoised.frame);
    expect(want[0] - want[2]).toBeGreaterThan(0.1);
    // A flat field gives the smoothing nothing to remove.
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 2);
    expect(worstDifference(denoised.frame, decoded.frame)).toBeLessThan(PIXEL_TOLERANCE);
  });

  it("still loses the decode stage's change on version 1", () => {
    const v1 = atVersion(LEGACY_PROCESS_VERSION);
    const both = renderTinted([TINT_STAGE, denoiser], v1);
    const alone = renderTinted([denoiser], v1);
    const decoded = renderTinted([TINT_STAGE, denoiser], { ...v1, colorNR: 0 });
    expect(both.splits).toBe(0);
    expect(worstDifference(both.frame, alone.frame)).toBeLessThan(PIXEL_TOLERANCE);
    expect(worstDifference(both.frame, decoded.frame)).toBeGreaterThan(0.05);
  });

  // The split holds `lin` after the linearisation and the baseline tone, so the
  // first pass must take it as it is. The built-in transform keeps the baseline,
  // which a second application would shift well past the tolerance.
  it("hands the passes the values the source would, when the decode stage changes nothing", () => {
    const params = atVersion(CURRENT_PROCESS_VERSION, { luminanceNR: 60 });
    const opts = { image: NOISY_COLOUR, tint: [1, 1, 1], pipeline: BUILTIN_RESOLVED };
    const throughSplit = renderTinted([TINT_STAGE, denoiser], params, opts);
    const fromSource = renderTinted([denoiser], params, opts);
    const undenoised = renderTinted([denoiser], { ...params, luminanceNR: 0, colorNR: 0 }, opts);
    expect(throughSplit.splits).toBe(1);
    expect(fromSource.splits).toBe(0);
    // Denoising moves the frame by more than twice the tolerance, so a split path
    // that stopped denoising could not pass the comparison below.
    expect(worstDifference(fromSource.frame, undenoised.frame)).toBeGreaterThan(
      2 * PIXEL_TOLERANCE,
    );
    expect(worstDifference(throughSplit.frame, fromSource.frame)).toBeLessThan(PIXEL_TOLERANCE);
  });

  // The split sits ahead of every core edit, so only the decode stages, the
  // source, the retouch and the denoiser's own pass params redraw it.
  it("draws its split once, and again only when the decode stage changes", () => {
    const params = atVersion(CURRENT_PROCESS_VERSION);
    const bag = (tint: number[]) => ({ ...denoiseBag(params), [`${TINT_STAGE.id}.tint`]: tint });
    withRenderer({ stages: [TINT_STAGE, denoiser], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(GREY);
      r.setParams(params);
      r.setContributedParams(bag(WARM));
      r.render();
      expect(r.renderDrawCounts).toEqual({ split: 1, pass: 7 });
      r.setParams({ ...params, exposure: 1 });
      r.setContributedParams(bag(WARM));
      r.render();
      expect(r.renderDrawCounts).toEqual({ split: 1, pass: 7 });
      r.setContributedParams(bag([2, 1, 0.5]));
      r.render();
      expect(r.renderDrawCounts).toEqual({ split: 2, pass: 14 });
    });
  });

  it("draws what it always has with no decode stage ahead of it", () => {
    for (const processVersion of [LEGACY_PROCESS_VERSION, CURRENT_PROCESS_VERSION]) {
      const params = atVersion(processVersion);
      withRenderer({ stages: [denoiser], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(GREY);
        r.setParams(params);
        r.setContributedParams(denoiseBag(params));
        r.render();
        r.setParams({ ...params, exposure: 1 });
        r.render();
        expect(r.renderDrawCounts).toEqual({ split: 0, pass: 7 });
      });
    }
  });
});
