// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 2 against version 1 on the GPU. Version 1 photos keep every
// clamp; version 2 photos skip identity tools and clip only inside the tools
// that need [0, 1]. Read back through LINEAR_PROBE_PIPELINE, or through a
// transform that pushes values past white, where the versions differ.

import { describe, expect, it } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_MASK_PANELS,
  LEGACY_PROCESS_VERSION,
  defaultColorGrading,
  defaultHSL,
  defaultMaskAdjustments,
  defaultToneCurves,
  type DevelopParams,
  type Mask,
  type MaskAdjustments,
} from "@/catalog/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import { DENOISE_STAGE, denoiseBag } from "./builtin-denoise";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  builtinStages,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  trackGlObjects,
  withRenderer,
  worstDifference,
  type FloatImage,
  type Frame,
} from "./webgl.test-support";

const V1 = { processVersion: LEGACY_PROCESS_VERSION };
const V2 = { processVersion: CURRENT_PROCESS_VERSION };

/** Doubles the working colour and owns its roll-off, so a scene value of 0.6
 *  reaches the display stage at 1.2: above white, where the versions differ. */
const DOUBLING_PIPELINE: ResolvedPipeline = {
  id: "test.double",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin * 2.0; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
  sig: "test.double",
};

/** A warm ramp inside [0, 1], where tools that clamp agree across versions.
 *  Its hue is 30°, the centre of the orange HSL band. */
const RAMP = floatImage(32, 8, (x) => {
  const v = 0.05 + (x / 31) * 0.7;
  return [v, v * 0.9, v * 0.8];
});

/** An extra point on the diagonal: still identity, but a user curve, so
 *  both versions sample the LUT. */
const USER_IDENTITY_CURVE = {
  ...defaultToneCurves(),
  rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
};

/** A mask over the whole frame: inverted, with no components. */
function wholeFrameMask(adj: Partial<MaskAdjustments>): Mask {
  return {
    id: "whole",
    name: "Whole frame",
    visible: true,
    invert: true,
    opacity: 100,
    adj: { ...defaultMaskAdjustments(), ...adj },
    panels: [...DEFAULT_MASK_PANELS],
    components: [],
  };
}

function capture(renderer: WebGLRenderer): Frame {
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

function frameOf(pipeline: ResolvedPipeline, source: FloatImage, params: DevelopParams): Frame {
  return withRenderer({ stages: [], pipeline }, (renderer) => {
    renderer.setImage(source);
    renderer.setParams(params);
    return capture(renderer);
  });
}

describe("process version 2", () => {
  it("skips the identity tone curve instead of resampling through its 8-bit LUT", () => {
    const flat = floatImage(16, 16, () => [0.3, 0.3, 0.3]);
    const [v1] = pixelAt(frameOf(LINEAR_PROBE_PIPELINE, flat, identityParams(V1)), 8, 8);
    const [v2] = pixelAt(frameOf(LINEAR_PROBE_PIPELINE, flat, identityParams(V2)), 8, 8);
    expect(Math.abs(v2 - 0.3)).toBeLessThan(2.5e-4);
    expect(Math.abs(v1 - 0.3)).toBeGreaterThan(5e-4);
  });

  it("lets sharpening work on the true value above white, not the clipped one", () => {
    // The left half reaches the display stage at 1.2, the right at 1.8. Beside
    // the edge the unsharp mask pulls the left side down: from 1.2 it stays
    // above white; from a clipped 1.0 it lands visibly below.
    const edge = floatImage(32, 32, (x) => (x < 16 ? [0.6, 0.6, 0.6] : [0.9, 0.9, 0.9]));
    const sharpened = (over: Partial<DevelopParams>) =>
      identityParams({ sharpening: 100, sharpenDetail: 100, ...over });
    const v1 = pixelAt(frameOf(DOUBLING_PIPELINE, edge, sharpened(V1)), 15, 16);
    const v2 = pixelAt(frameOf(DOUBLING_PIPELINE, edge, sharpened(V2)), 15, 16);
    for (const ch of v1) expect(ch).toBeLessThan(0.99);
    for (const ch of v2) expect(ch).toBeGreaterThan(0.999);
  });

  it("matches version 1 inside [0, 1] when clamping tools are in use", () => {
    const params = (over: Partial<DevelopParams>) =>
      identityParams({ contrast: 40, saturation: 20, toneCurve: USER_IDENTITY_CURVE, ...over });
    const a = frameOf(LINEAR_PROBE_PIPELINE, RAMP, params(V1));
    const b = frameOf(LINEAR_PROBE_PIPELINE, RAMP, params(V2));
    expect(worstDifference(a, b)).toBeLessThan(5e-4);
  });

  // The activity flags are plain uniforms: one the program doesn't declare
  // under that name reads as off, and the tool would silently stop working.
  it("still applies HSL, grading and a mask's display adjustments when they're in use", () => {
    const hsl = defaultHSL();
    const grading = defaultColorGrading();
    const tools: [string, Partial<DevelopParams>][] = [
      ["HSL", { hsl: { ...hsl, saturation: { ...hsl.saturation, orange: -80 } } }],
      ["grading", { colorGrading: { ...grading, midtones: { hue: 200, sat: 60, luma: 0 } } }],
      ["mask", { masks: [wholeFrameMask({ saturation: -80 })] }],
    ];
    const render = (over: Partial<DevelopParams>) =>
      frameOf(
        LINEAR_PROBE_PIPELINE,
        RAMP,
        identityParams({ toneCurve: USER_IDENTITY_CURVE, ...over }),
      );
    const untouched = render(V2);
    for (const [tool, over] of tools) {
      const v2 = render({ ...V2, ...over });
      expect(worstDifference(v2, render({ ...V1, ...over })), tool).toBeLessThan(5e-4);
      expect(worstDifference(v2, untouched), tool).toBeGreaterThan(0.01);
    }
  });

  it("switches programs per photo without disturbing either", () => {
    const flat = floatImage(16, 16, () => [0.3, 0.25, 0.2]);
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flat);
      renderer.setParams(identityParams(V1));
      const first = capture(renderer);
      renderer.setParams(identityParams(V2));
      const other = capture(renderer);
      renderer.setParams(identityParams(V1));
      const again = capture(renderer);
      renderer.setParams(identityParams(V2));
      const otherAgain = capture(renderer);
      expect(Array.from(again.data)).toEqual(Array.from(first.data));
      expect(Array.from(otherAgain.data)).toEqual(Array.from(other.data));
      expect(Array.from(other.data)).not.toEqual(Array.from(first.data));
    });
  });

  // Pass programs are the same for both versions, so photos alternating
  // between versions must not rebuild them: Develop runs the denoiser's passes
  // at the default Color NR.
  it("compiles nothing more once photos of both versions have been drawn", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer({ stages: builtinStages(), pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
        renderer.setImage(floatImage(16, 16, () => [0.3, 0.25, 0.2]));
        const draw = (version: Partial<DevelopParams>) => {
          const params = identityParams({ ...version, colorNR: 25 });
          renderer.setParams(params);
          renderer.setContributedParams(denoiseBag(params));
          renderer.render();
        };
        const atStart = tally.created.program;
        draw(V1);
        const passCount = DENOISE_STAGE.passes?.length ?? 0;
        expect(passCount).toBeGreaterThan(0);
        expect(tally.created.program - atStart).toBe(1 + passCount);
        draw(V2);
        const afterBoth = tally.created.program;
        draw(V1);
        draw(V2);
        expect(tally.created.program).toBe(afterBoth);
      });
    } finally {
      tally.restore();
    }
  });
});

// A renderer compiles the develop program of the version it is asked to draw and
// none ahead of time: a version 1 photo must not pay for the version 2 program
// first, a full compile (slow on ANGLE) on every export batch and worker start.
// No stages keeps prepass programs out of the counts.
describe("the develop program a renderer compiles", () => {
  const FLAT = floatImage(16, 16, () => [0.3, 0.25, 0.2]);
  const OPTS = { stages: [], pipeline: BUILTIN_RESOLVED };

  it("builds one program per version drawn, and none at construction", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer(OPTS, (renderer) => {
        expect(tally.created.program, "at construction").toBe(0);
        renderer.setImage(FLAT);
        const draw = (version: Partial<DevelopParams>) => {
          renderer.setParams(identityParams(version));
          renderer.render();
        };
        draw(V1);
        expect(tally.created.program, "after a version 1 frame").toBe(1);
        draw(V2);
        expect(tally.created.program, "after a version 2 frame").toBe(2);
        draw(V1);
        draw(V2);
        expect(tally.created.program, "after switching back and forth").toBe(2);
      });
    } finally {
      tally.restore();
    }
  });

  // A fresh renderer holds the built-in transform's signature, an empty stage
  // signature and the version 2 variant, so this first frame matches all three:
  // only the missing program says nothing has been built yet.
  it("builds the version 2 program for a version 2 photo drawn first", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const frame = withRenderer(OPTS, (renderer) => {
        renderer.setImage(FLAT);
        renderer.setParams(identityParams(V2));
        return capture(renderer);
      });
      expect(tally.created.program).toBe(1);
      expect(pixelAt(frame, 8, 8)[1]).toBeGreaterThan(0.1);
    } finally {
      tally.restore();
    }
  });

  // The warm-up callers (worker init, batch export, the histogram) build ahead of
  // the first frame, with no image and nothing drawn; the frame then finds its
  // program built.
  it("builds a version's program on request, with no image and no draw", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer(OPTS, (renderer) => {
        renderer.prepareProgram(LEGACY_PROCESS_VERSION);
        expect(tally.created.program, "after preparing version 1").toBe(1);
        renderer.prepareProgram(CURRENT_PROCESS_VERSION);
        expect(tally.created.program, "after preparing version 2").toBe(2);
        renderer.prepareProgram(LEGACY_PROCESS_VERSION);
        expect(tally.created.program, "after preparing version 1 again").toBe(2);
        renderer.setImage(FLAT);
        for (const version of [V1, V2, V1]) {
          renderer.setParams(identityParams(version));
          renderer.render();
        }
        expect(tally.created.program, "after drawing both").toBe(2);
      });
    } finally {
      tally.restore();
    }
  });
});

// A tool whose math needs [0, 1] clamps its own input on version 2, so it gets
// what version 1's clamp after the transform gave it. The source reaches the
// display stage over white: (1.2, 1.0, 0.8) on the left, (1.4, 0.4, 0.2) on
// the right. There's no user curve: its own clamp would hide the input clamps
// of the tools after it, so the tolerance absorbs version 1's LUT drift.
describe("a tool that needs [0, 1], on values over white", () => {
  const OVER_WHITE = floatImage(32, 16, (x) => (x < 16 ? [0.6, 0.5, 0.4] : [0.7, 0.2, 0.1]));
  const hsl = defaultHSL();
  const coolHighlights = { hue: 200, sat: 60, luma: 0 };
  const TOOLS: [string, Partial<DevelopParams>][] = [
    ["Whites", { whites: 100 }],
    ["Blacks", { blacks: -100 }],
    ["Contrast", { contrast: 40 }],
    ["Dehaze", { dehaze: 40 }],
    ["HSL", { hsl: { ...hsl, saturation: { ...hsl.saturation, yellow: -60 } } }],
    ["Colour Grading", { colorGrading: { ...defaultColorGrading(), highlights: coolHighlights } }],
    ["a mask's Contrast", { masks: [wholeFrameMask({ contrast: 100 })] }],
  ];

  for (const [tool, over] of TOOLS) {
    it(`renders ${tool} on version 2 as version 1 does`, () => {
      const v1 = frameOf(DOUBLING_PIPELINE, OVER_WHITE, identityParams({ ...V1, ...over }));
      const v2 = frameOf(DOUBLING_PIPELINE, OVER_WHITE, identityParams({ ...V2, ...over }));
      expect(worstDifference(v1, v2)).toBeLessThan(5e-3);
    });
  }
});

// A mask's Clarity, Sharpness and Texture take their detail from the source on
// both sides, as the global tools do: the source's luma at the pixel against a
// blur of the source's luma. Version 1 set the luma of the edited, display-encoded
// colour against that blur. On a RAW at defaults mid-grey is 0.59 in one and 0.42
// in the other, so every flat area read as local contrast.
describe("a mask's Clarity, Sharpness and Texture", () => {
  const MID_GREY = floatImage(32, 32, () => [0.18, 0.18, 0.18]);
  // A one-pixel chequer 0.034 either side of mid-grey: fine detail for Texture to
  // bring out.
  const FINE_DETAIL = floatImage(32, 32, (x, y) => {
    const v = (x + y) % 2 === 0 ? 0.214 : 0.146;
    return [v, v, v];
  });
  const EDGE = floatImage(32, 32, (x) => (x < 16 ? [0.05, 0.05, 0.05] : [0.4, 0.4, 0.4]));
  // Five soft stripes across the image: detail the zoomed-out view below still sees.
  const STRIPES = floatImage(32, 32, (x) => {
    const v = 0.18 + 0.05 * Math.sin((x / 32) * Math.PI * 2 * 5);
    return [v, v, v];
  });
  // The capture target is half float: the same pixels can differ by a step or two.
  const SAME = 2e-3;

  const render = (source: FloatImage, over: Partial<DevelopParams>) =>
    frameOf(BUILTIN_RESOLVED, source, identityParams(over));
  const inMask = (
    source: FloatImage,
    version: Partial<DevelopParams>,
    adj: Partial<MaskAdjustments>,
  ) => render(source, { ...version, masks: [wholeFrameMask(adj)] });
  const TOOLS: [string, Partial<MaskAdjustments>][] = [
    ["Clarity", { clarity: 50 }],
    ["Sharpness", { sharpness: 50 }],
    ["Texture", { texture: 50 }],
  ];

  for (const [tool, adj] of TOOLS) {
    it(`finds no detail in a flat area with ${tool} on version 2`, () => {
      const plain = render(MID_GREY, V2);
      expect(worstDifference(inMask(MID_GREY, V2, adj), plain)).toBeLessThan(SAME);
    });
  }

  // The first check is the slider's own reach: Texture has something to bring
  // out here, and a mask must bring out the same.
  it("brings out fine detail with Texture on version 2 as the global slider does", () => {
    const plain = render(FINE_DETAIL, V2);
    const global = render(FINE_DETAIL, { ...V2, texture: 50 });
    expect(worstDifference(global, plain)).toBeGreaterThan(0.02);
    expect(worstDifference(inMask(FINE_DETAIL, V2, { texture: 50 }), global)).toBeLessThan(SAME);
  });

  // In a view smaller than the source the pixel's own value is a coarser mip than
  // level 0 (texture() picks the level), and the global tools centre on that. A
  // mask reading level 0 instead would drift from its global counterpart.
  it("matches the global Texture on version 2 in a view smaller than the source", () => {
    const view = (over: Partial<DevelopParams>) =>
      withRenderer({ stages: [], pipeline: BUILTIN_RESOLVED }, (renderer) => {
        renderer.setImage(STRIPES);
        renderer.setViewport({ x: 0, y: 0, w: 1, h: 1 }, 12, 12);
        renderer.setParams(identityParams({ ...V2, ...over }));
        return capture(renderer);
      });
    const global = view({ texture: 50 });
    expect(worstDifference(global, view({}))).toBeGreaterThan(0.01);
    const masked = view({ masks: [wholeFrameMask({ texture: 50 })] });
    expect(worstDifference(masked, global)).toBeLessThan(SAME);
  });

  // Texture holds back at a strong edge by design, so the edge check is for the
  // other two.
  for (const [tool, adj] of TOOLS.filter(([name]) => name !== "Texture")) {
    it(`still works the pixels beside an edge with ${tool} on version 2`, () => {
      const plain = render(EDGE, V2);
      const worked = inMask(EDGE, V2, adj);
      const shift = (x: number) => pixelAt(worked, x, 16)[1] - pixelAt(plain, x, 16)[1];
      expect(shift(15), "dark side").toBeLessThan(-0.02);
      expect(shift(16), "bright side").toBeGreaterThan(0.02);
      expect(Math.abs(shift(0)), "flat dark side").toBeLessThan(SAME);
      expect(Math.abs(shift(31)), "flat bright side").toBeLessThan(SAME);
    });
  }

  // Version 1 renders every edit made before process versions, so it keeps the
  // lift those edits were made with.
  it("keeps what each tool did on version 1", () => {
    const plain = pixelAt(render(MID_GREY, V1), 16, 16)[1];
    const lift = (adj: Partial<MaskAdjustments>) =>
      pixelAt(inMask(MID_GREY, V1, adj), 16, 16)[1] - plain;
    expect(lift({ clarity: 50 })).toBeCloseTo(0.1006, 2);
    expect(lift({ sharpness: 50 })).toBeCloseTo(0.0776, 2);
    const fine = worstDifference(
      inMask(FINE_DETAIL, V1, { texture: 50 }),
      render(FINE_DETAIL, V1),
    );
    expect(fine).toBeLessThan(SAME);
  });
});
