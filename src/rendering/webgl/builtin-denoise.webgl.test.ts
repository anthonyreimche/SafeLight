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
  differing,
  floatImage,
  glHarness,
  identityParams,
  liveFrame,
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

/** The variance of red and of blue against green, away from the border: the
 *  chroma noise Colour NR removes while it keeps luma. */
function chromaVariance(frame: Frame): number {
  let total = 0;
  for (const ch of [0, 2]) {
    const d: number[] = [];
    for (let y = 4; y < frame.height - 4; y++) {
      for (let x = 4; x < frame.width - 4; x++) {
        const o = (y * frame.width + x) * 4;
        d.push(frame.data[o + ch] - frame.data[o + 1]);
      }
    }
    const m = d.reduce((a, b) => a + b, 0) / d.length;
    total += d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length;
  }
  return total;
}

/** An extension's noise reduction that changes nothing: it runs a pass of its
 *  own and keeps none of the result, so a frame with it differs from one
 *  without NR only by what the core block does. */
const NO_OP_NR: ProcessingStageContribution = {
  id: "test.no-op-nr",
  name: "No-op noise reduction",
  phase: "noise-reduction",
  glsl: "if (amount > 0.0) lin += 0.0 * stageResult;",
  uniforms: [{ key: "amount", glslType: "float", default: 0 }],
  passes: [{ glsl: "c = c;" }],
};

/** The built-in denoiser under an extension's id, swapping its result in
 *  whatever the NR sliders say, with the bag that feeds it as `p` feeds the
 *  denoiser. With the sliders at 0 the core block has nothing to do, so its
 *  frame is the denoiser's result with no core NR after it. */
const TWIN_ID = "test.denoise-twin";
const twinStages = (): ProcessingStageContribution[] =>
  builtinStages().map((s) => (s.id === BUILTIN_DENOISE_ID ? { ...s, id: TWIN_ID, glsl: "lin = stageResult;" } : s));
const twinBag = (p: DevelopParams): Record<string, number> =>
  Object.fromEntries(Object.entries(denoiseBag(p)).map(([k, v]) => [k.replace(BUILTIN_DENOISE_ID, TWIN_ID), v]));

// Without float render targets the prepass ping-pong is RGBA8, and the forward
// pass's VST luma, always above 1, saturates there. Swapped in for `lin`, it
// turned this mid grey black at the shipping Colour NR on every version, so the
// denoiser sits out there and the core block, which reads only the source's
// mips, does the noise reduction instead. An extension's noise reduction still
// replaces the core block.
describe("the denoiser on a GPU without float render targets", () => {
  const MID_GREY = floatImage(SIZE, SIZE, () => [0.18, 0.18, 0.18]);
  const IN_ITS_PLACE =
    "[render] The denoiser needs float render targets; this GPU has none, so the simpler " +
    "built-in noise reduction is used instead.";

  interface Setup {
    /** Hides EXT_color_buffer_float from the renderer, which reads it once
     *  when it is built, as a GPU without float colour buffers would. */
    refuseFloat: boolean;
    stages?: ProcessingStageContribution[];
    /** Entries beside the ones the denoiser takes from the params. */
    bag?: Record<string, number>;
    pipeline?: ResolvedPipeline;
  }
  const NO_FLOAT: Setup = { refuseFloat: true };
  const FLOAT: Setup = { refuseFloat: false };

  interface Shown {
    /** The canvas, RGBA, top-down, with its size. */
    frame: Frame;
    passes: number;
    warnings: number;
  }

  /** Two live frames of `image`, fed as Develop feeds the denoiser: the second
   *  frame's canvas, the pass draws both took and the warnings they logged that
   *  the core block stands in for the denoiser. */
  function twoFrames(
    image: FloatImage,
    params: DevelopParams,
    { refuseFloat, stages = builtinStages(), bag = {}, pipeline = BUILTIN_RESOLVED }: Setup,
  ): Shown {
    const { gl } = glHarness();
    const getExtension = gl.getExtension.bind(gl);
    if (refuseFloat) {
      gl.getExtension = ((name: string) =>
        name === "EXT_color_buffer_float" ? null : getExtension(name)) as typeof gl.getExtension;
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      return withRenderer({ stages, pipeline, processVersionCap: 3 }, (r) => {
        r.setImage(image);
        r.setParams(params);
        r.setContributedParams({ ...denoiseBag(params), ...bag });
        liveFrame(r);
        const px = liveFrame(r);
        return {
          frame: { data: Float32Array.from(px), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
          passes: r.renderDrawCounts.pass,
          warnings: warn.mock.calls.filter((call) => call[0] === IN_ITS_PLACE).length,
        };
      });
    } finally {
      gl.getExtension = getExtension;
      warn.mockRestore();
    }
  }

  const centre = ({ frame }: Shown) => pixelAt(frame, frame.width >> 1, frame.height >> 1);

  for (const processVersion of [1, 2, 3]) {
    it(`leaves a grey as it is at the default Colour NR on version ${processVersion}, warning once`, () => {
      const off = twoFrames(MID_GREY, atVersion(processVersion, { colorNR: 0 }), NO_FLOAT);
      const on = twoFrames(MID_GREY, atVersion(processVersion), NO_FLOAT);
      const [r, g, b] = centre(off);
      expect(Math.max(Math.abs(r - g), Math.abs(g - b)), "grey without NR").toBeLessThanOrEqual(1);
      expect(g).toBeGreaterThan(100);
      const moved = Math.max(...centre(on).map((code, ch) => Math.abs(code - centre(off)[ch])));
      expect(moved, `${centre(on)} against ${centre(off)}`).toBeLessThanOrEqual(2);
      expect(on.passes).toBe(0);
      expect(on.warnings).toBe(1);
    });

    // The luminance branch measures detail against the source's mips, which
    // never carry the RAW baseline tone, so the renderer turns it off behind the
    // baseline (next test). It is checked where nothing tones `lin`: under a
    // transform that skips the baseline, as a bitmap has none.
    it(`smooths colour and luminance noise in the core block on version ${processVersion}`, () => {
      const colour = (colorNR: number) => twoFrames(NOISY_COLOUR, atVersion(processVersion, { colorNR }), NO_FLOAT);
      const luma = (luminanceNR: number) =>
        twoFrames(NOISY, atVersion(processVersion, { colorNR: 0, luminanceNR }), {
          ...NO_FLOAT,
          pipeline: LINEAR_PROBE_PIPELINE,
        });
      const [colourOff, colourOn] = [colour(0), colour(25)].map((s) => chromaVariance(s.frame));
      const [lumaOff, lumaOn] = [luma(0), luma(25)].map((s) => roughness(s.frame));
      expect(colourOn, `chroma variance ${colourOn} against ${colourOff}`).toBeLessThan(colourOff * 0.8);
      expect(lumaOn, `roughness ${lumaOn} against ${lumaOff}`).toBeLessThan(lumaOff * 0.5);
    });

    // Behind the baseline the branch reads the tone's lift as detail and shrinks
    // it, shifting the shadows of a field that has no noise to remove.
    it(`keeps Luminance NR off behind the RAW baseline on version ${processVersion}`, () => {
      for (const level of [0.01, 0.05, 0.08, 0.2]) {
        const grey = floatImage(SIZE, SIZE, () => [level, level, level]);
        const off = twoFrames(grey, atVersion(processVersion), NO_FLOAT);
        for (const luminanceNR of [25, 100]) {
          const on = twoFrames(grey, atVersion(processVersion, { luminanceNR }), NO_FLOAT);
          expect(differing(on.frame.data, off.frame.data), `grey ${level} at Luminance NR ${luminanceNR}`).toBe(0);
        }
      }
    });
  }

  it("leaves the core block off behind an extension's noise reduction", () => {
    const setup: Setup = {
      refuseFloat: true,
      stages: [...builtinStages(), NO_OP_NR],
      bag: { [`${NO_OP_NR.id}.amount`]: 1 },
    };
    for (const processVersion of [1, 2, 3]) {
      const off = twoFrames(NOISY_COLOUR, atVersion(processVersion, { colorNR: 0 }), setup);
      const on = twoFrames(NOISY_COLOUR, atVersion(processVersion, { luminanceNR: 25 }), setup);
      expect(on.passes, "the extension's pass").toBeGreaterThan(0);
      expect(on.warnings).toBe(0);
      expect(differing(on.frame.data, off.frame.data), `version ${processVersion}`).toBe(0);
    }
  });

  it("still denoises a noisy patch where float render targets exist", () => {
    const off = twoFrames(NOISY, atVersion(3, { colorNR: 0 }), FLOAT);
    const on = twoFrames(NOISY, atVersion(3, { colorNR: 0, luminanceNR: 100 }), FLOAT);
    expect(on.passes).toBeGreaterThan(0);
    expect(on.warnings).toBe(0);
    expect(roughness(off.frame)).toBeGreaterThan(1);
    expect(roughness(on.frame)).toBeLessThan(roughness(off.frame) * 0.75);
  });

  it("keeps the core block out of the denoiser's result where float render targets exist", () => {
    for (const processVersion of [1, 2, 3]) {
      const params = atVersion(processVersion, { luminanceNR: 25 });
      const denoised = twoFrames(NOISY_COLOUR, params, FLOAT);
      const reference = twoFrames(
        NOISY_COLOUR,
        { ...params, colorNR: 0, luminanceNR: 0 },
        { ...FLOAT, stages: twinStages(), bag: twinBag(params) },
      );
      expect(denoised.passes).toBeGreaterThan(0);
      expect(reference.passes).toBeGreaterThan(0);
      expect(differing(denoised.frame.data, reference.frame.data), `version ${processVersion}`).toBe(0);
    }
  });
});
