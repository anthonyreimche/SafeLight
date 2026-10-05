// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renderer lifecycle and end-to-end pixel behaviour. The directional pixel
// assertions run through LINEAR_PROBE_PIPELINE, a display transform that hands
// the scene-linear working colour straight to the framebuffer: the full develop
// path still executes, but the read-back value is the linear one the tone chain
// produced, so "+1 EV doubles it" can be asserted without inverting a curve.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_DEVELOP_PARAMS,
  DEFAULT_MASK_PANELS,
  DEFAULT_TRANSFORM,
  LEGACY_PROCESS_VERSION,
  defaultMaskAdjustments,
  type BrushDab,
  type DevelopParams,
  type Mask,
  type MaskAdjustments,
  type MaskComponent,
  type RetouchSpot,
} from "@/catalog/types";
import { BUILTIN_RESOLVED, withPipeline, type ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";
import { encodeHalf } from "@/raw/half-float";
import { BUILTIN_DENOISE_ID, denoiseBag } from "./builtin-denoise";
import { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  PIXEL_TOLERANCE,
  type FloatImage,
  type Frame,
  type GlObjectCounts,
  builtinStage,
  builtinStages,
  drainGlErrors,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  rendererBuildError,
  trackGlObjects,
  withRenderer,
  worstDifference,
} from "./webgl.test-support";

const NO_LIVE_OBJECTS: GlObjectCounts = {
  texture: 0,
  framebuffer: 0,
  buffer: 0,
  program: 0,
  shader: 0,
  vertexArray: 0,
};

const FLAT_GREY = 0.2;

/** A display transform that can't be built: its GLSL calls a function nothing declares. */
const FAILING_PIPELINE: ResolvedPipeline = {
  id: "test.failing",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return neverDeclared(lin); }",
  skipBaseCurve: false,
  skipToneShoulder: false,
  sig: "test.failing",
};

function flatSource(size = 16, value = FLAT_GREY) {
  return floatImage(size, size, () => [value, value, value]);
}

/** The develop-preview cache's copy of a float source, as half floats. */
function cached(source: FloatImage) {
  return {
    kind: "float16" as const,
    data: encodeHalf(source.data),
    width: source.width,
    height: source.height,
  };
}

function capture(renderer: WebGLRenderer): Frame {
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

/** Render one frame through the linear probe and hand back the pixels. */
function linearFrame(configure: (renderer: WebGLRenderer) => void): Frame {
  return withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    configure(renderer);
    return capture(renderer);
  });
}

describe("construction and teardown", () => {
  it("sets up its textures and geometry without raising a GL error", () => {
    const { gl } = glHarness();
    drainGlErrors(gl);
    withRenderer(undefined, (renderer) => {
      expect(renderer.colorBufferFloat).toBe(true);
      expect(renderer.maxTextureEdge).toBeGreaterThanOrEqual(2048);
    });
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });

  it("uploads, renders and reads back without raising a GL error", () => {
    const { gl } = glHarness();
    drainGlErrors(gl);
    withRenderer(undefined, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      renderer.render();
      renderer.computeHistogram(true);
      renderer.readDownscaledPixels(8);
      renderer.captureFloatFrame();
    });
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });

  // Both redraw what the last frame left bound, so a renderer that hasn't drawn
  // one has nothing to read: a draw would raise a GL error and read back black.
  it("reads back nothing, without a GL error, before its first frame", () => {
    const { gl } = glHarness();
    drainGlErrors(gl);
    withRenderer(undefined, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      const histogram = renderer.computeHistogram(true);
      expect([...histogram.luma].every((count) => count === 0)).toBe(true);
      expect(histogram.extended).toBeUndefined();
      expect(renderer.readDownscaledPixels(8)).toBeNull();
    });
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });

  it("gives every GL object back on dispose", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const renderer = new WebGLRenderer(canvas);
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      renderer.render();
      // Histogram and float capture allocate targets lazily, so touch them
      // before disposing or the test would never see those allocations.
      renderer.computeHistogram(true);
      renderer.captureFloatFrame();
      renderer.readDownscaledPixels(8);
      renderer.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
    }
  });

  it("gives back the prepass targets a stage-bearing render allocates", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const renderer = new WebGLRenderer(canvas, { stages: builtinStages() });
      renderer.setImage(flatSource());
      renderer.setParams(identityParams({ luminanceNR: 60 }));
      renderer.setContributedParams({ "builtin.denoise.lumAmount": 60 });
      renderer.render();
      renderer.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
    }
  });

  // The program is compiled by the first frame, not the constructor, so that is
  // where a broken stage throws.
  it("leaks nothing when a contributed stage fails to compile", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const renderer = new WebGLRenderer(canvas, {
        stages: [
          {
            id: "acme.broken",
            name: "Broken",
            phase: "effects",
            glsl: "c = neverDeclared(c);",
            uniforms: [],
          },
        ],
      });
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      expect(() => renderer.render()).toThrow(/neverDeclared/);
      renderer.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
    }
  });

  it("keeps cached sources resident, then frees them all on dispose", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const renderer = new WebGLRenderer(canvas);
      renderer.setParams(identityParams());
      renderer.uploadSource("a", flatSource());
      renderer.uploadSource("b", flatSource(8, 0.4));
      expect(renderer.hasSource("a")).toBe(true);
      expect(renderer.bindSource("a")).toBe(true);
      expect(renderer.bindSource("missing")).toBe(false);
      renderer.render();

      // Evicting to a zero budget must drop the unpinned entry and only that:
      // the bound source is pinned, so it survives and stays renderable.
      const beforeEvict = tally.live.texture;
      renderer.setCacheBudget(0);
      expect(tally.live.texture).toBe(beforeEvict - 1);
      expect(renderer.hasSource("b")).toBe(false);
      renderer.render();

      renderer.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
    }
  });

  it("frees the previous source when a second image is uploaded", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const renderer = new WebGLRenderer(canvas);
      renderer.setImage(flatSource());
      const afterFirst = tally.live.texture;
      renderer.setImage(flatSource(8));
      expect(tally.live.texture).toBe(afterFirst);
      renderer.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
    }
  });
});

// A frame drawn with an empty param bag runs no prepass, so a pass program is
// compiled only by rendererBuildError itself.
describe("rendererBuildError", () => {
  function decodeStage(over: Partial<ProcessingStageContribution>): ProcessingStageContribution {
    return {
      id: "acme.decode",
      name: "Decode",
      phase: "decode",
      glsl: "lin = max(lin, 0.0);",
      uniforms: [],
      ...over,
    };
  }

  it("reports a pass that fails to compile, and which one", () => {
    const stage = decodeStage({ passes: [{ glsl: "c = readPrev(vUv) *;" }] });
    const error = rendererBuildError({ stages: [stage] });
    expect(error).not.toBeNull();
    expect(error).toContain("acme.decode");
  });

  it("reports inline glsl that fails to compile", () => {
    const stage = decodeStage({ glsl: "lin = neverDeclared(lin);" });
    expect(rendererBuildError({ stages: [stage] })).not.toBeNull();
  });

  it("accepts a stage whose passes compile", () => {
    const stage = decodeStage({ passes: [{ glsl: "c = readPrev(vUv);" }] });
    expect(rendererBuildError({ stages: [stage] })).toBeNull();
  });
});

// A program that fails to build is a fact about its signature and process version:
// retrying it every frame only repeats the compile. The stage below doubles the
// scene value at its default gain; `broken` is the same stage with another default
// and a GLSL error, so a leftover of it would show in the pixels.
describe("a stage set that fails to build", () => {
  const gain = (over: Partial<ProcessingStageContribution> = {}): ProcessingStageContribution => ({
    id: "acme.gain",
    name: "Gain",
    phase: "scene-linear",
    glsl: "lin *= 1.0 + gain;",
    uniforms: [{ key: "gain", glslType: "float", default: 1 }],
    ...over,
  });
  const broken = gain({
    glsl: "lin = neverDeclared(lin);",
    uniforms: [{ key: "gain", glslType: "float", default: 3 }],
  });
  const PIPELINE = LINEAR_PROBE_PIPELINE;

  // A custom display transform that can't build with the stages falls back to the
  // built-in one, and says so, before the built-in fails too. The logs are
  // counted here, not printed.
  let logged: MockInstance<typeof console.error>;
  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  function failure(draw: () => unknown): unknown {
    try {
      draw();
    } catch (err) {
      return err;
    }
    return null;
  }

  it("throws the same error again without compiling it, or saying so, again", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer({ stages: [broken], pipeline: PIPELINE }, (renderer) => {
        renderer.setImage(flatSource());
        renderer.setParams(identityParams());
        const first = failure(() => renderer.render());
        expect(first).toBeInstanceOf(Error);
        const compiled = tally.created.shader;
        expect(compiled).toBeGreaterThan(0);
        expect(logged).toHaveBeenCalledTimes(1);
        expect(failure(() => renderer.render())).toBe(first);
        expect(failure(() => renderer.captureFloatFrame())).toBe(first);
        expect(tally.created.shader).toBe(compiled);
        expect(logged).toHaveBeenCalledTimes(1);
      });
    } finally {
      tally.restore();
    }
  });

  it("builds again once the stage set changes", () => {
    withRenderer({ stages: [broken], pipeline: PIPELINE }, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      expect(() => renderer.render()).toThrow(/neverDeclared/);
      renderer.setStages([gain()]);
      expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
    });
  });

  // uCurveActive is declared by the version 2 program alone, so a stage reading it
  // builds there and fails on version 1.
  it("is remembered for the process version that failed, not the other", () => {
    const readsV2Only = gain({ glsl: "if (uCurveActive) lin *= 1.0;", uniforms: [] });
    withRenderer({ stages: [readsV2Only], pipeline: PIPELINE }, (renderer) => {
      renderer.setImage(flatSource());
      const draw = (version: number) => {
        renderer.setParams(identityParams({ processVersion: version }));
        return capture(renderer);
      };
      const first = failure(() => draw(LEGACY_PROCESS_VERSION));
      expect(first).toBeInstanceOf(Error);
      expect(pixelAt(draw(CURRENT_PROCESS_VERSION), 8, 8)[1]).toBeCloseTo(FLAT_GREY, 2);
      expect(failure(() => draw(LEGACY_PROCESS_VERSION))).toBe(first);
    });
  });

  // A failed switch must leave the renderer on the set it was drawing: the bindings
  // are the working set's, so a switch back sees nothing of the broken one.
  it("leaves the working stage set's behaviour alone after a failed switch and back", () => {
    withRenderer({ stages: [gain()], pipeline: PIPELINE }, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      const before = pixelAt(capture(renderer), 8, 8)[1];
      expect(before).toBeCloseTo(FLAT_GREY * 2, 2);

      renderer.setStages([broken]);
      expect(() => capture(renderer)).toThrow(/neverDeclared/);
      renderer.setStages([gain()]);
      expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(before, 3);
    });
  });

  it("keeps a failing custom display transform on the built-in one, compiled once", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer({ stages: [], pipeline: FAILING_PIPELINE }, (renderer) => {
        renderer.setImage(flatSource());
        renderer.setParams(identityParams());
        expect(capture(renderer).width).toBe(16);
        const compiled = tally.created.shader;
        expect(capture(renderer).width).toBe(16);
        expect(tally.created.shader).toBe(compiled);
        expect(logged).toHaveBeenCalledTimes(1);
      });
    } finally {
      tally.restore();
    }
  });

  describe("prepareProgram", () => {
    it("throws the error a frame would throw", () => {
      withRenderer({ stages: [broken], pipeline: PIPELINE }, (renderer) => {
        expect(() => renderer.prepareProgram(CURRENT_PROCESS_VERSION)).toThrow(/neverDeclared/);
        renderer.setImage(flatSource());
        renderer.setParams(identityParams());
        expect(() => renderer.render()).toThrow(/neverDeclared/);
      });
    });

    it("leaves the renderer as it was when the program fails to build", () => {
      withRenderer({ stages: [gain()], pipeline: PIPELINE }, (renderer) => {
        renderer.setImage(flatSource());
        renderer.setParams(identityParams());
        const before = pixelAt(capture(renderer), 8, 8)[1];

        renderer.setStages([broken]);
        expect(() => renderer.prepareProgram(CURRENT_PROCESS_VERSION)).toThrow(/neverDeclared/);
        renderer.setStages([gain()]);
        expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(before, 3);
      });
    });

    it("builds for the stage set it is given without drawing with it", () => {
      withRenderer({ stages: [gain()], pipeline: PIPELINE }, (renderer) => {
        renderer.setImage(flatSource());
        renderer.setParams(identityParams());
        const before = pixelAt(capture(renderer), 8, 8)[1];

        const triple = gain({ uniforms: [{ key: "gain", glslType: "float", default: 3 }] });
        renderer.setStages([triple]);
        renderer.prepareProgram(LEGACY_PROCESS_VERSION);
        renderer.setStages([gain()]);
        expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(before, 3);
      });
    });
  });

  // The stock program is the built-in transform with Safelight's own stages (the core
  // ones and the built-in denoiser) and nothing an extension contributes. A caller
  // whose prepareProgram threw builds it to tell a stage set or transform that can't
  // build from a machine that can't run Safelight's own shader.
  describe("prepareStockProgram", () => {
    /** Every shader reports a failed compile, as a driver that can't build the base
     *  shader does. */
    function failCompiles(gl: WebGL2RenderingContext): { restore(): void } {
      const original = { getShaderParameter: gl.getShaderParameter };
      gl.getShaderParameter = (shader: WebGLShader, pname: number) =>
        pname === gl.COMPILE_STATUS ? false : original.getShaderParameter.call(gl, shader, pname);
      return {
        restore() {
          Object.assign(gl, original);
        },
      };
    }

    it("builds without drawing, and leaves the renderer's stages and transform alone", () => {
      const { gl } = glHarness();
      const tally = trackGlObjects(gl);
      try {
        withRenderer({ stages: [gain()], pipeline: PIPELINE }, (renderer) => {
          renderer.setImage(flatSource());
          renderer.setParams(identityParams());
          const before = pixelAt(capture(renderer), 8, 8)[1];
          expect(before).toBeCloseTo(FLAT_GREY * 2, 2);
          const built = tally.created.program;

          renderer.prepareStockProgram(LEGACY_PROCESS_VERSION);
          expect(tally.created.program).toBe(built + 1);
          // The next frame still draws with the stage and the transform it held.
          expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(before, 3);
          expect(tally.created.program).toBe(built + 1);
        });
      } finally {
        tally.restore();
      }
    });

    it("builds where the renderer's own stages can't, and its frames still fail for them", () => {
      withRenderer({ stages: [broken], pipeline: PIPELINE }, (renderer) => {
        renderer.setImage(flatSource());
        renderer.setParams(identityParams());
        expect(() => renderer.prepareProgram(LEGACY_PROCESS_VERSION)).toThrow(/neverDeclared/);
        expect(() => renderer.prepareStockProgram(LEGACY_PROCESS_VERSION)).not.toThrow();
        expect(() => capture(renderer)).toThrow(/neverDeclared/);
      });
    });

    it("leaves a renderer whose stages can't build able to recover when they change", () => {
      withRenderer({ stages: [broken], pipeline: PIPELINE }, (renderer) => {
        renderer.setImage(flatSource());
        renderer.setParams(identityParams());
        expect(() => renderer.prepareProgram(LEGACY_PROCESS_VERSION)).toThrow(/neverDeclared/);
        renderer.prepareStockProgram(LEGACY_PROCESS_VERSION);
        expect(() => capture(renderer)).toThrow(/neverDeclared/);

        renderer.setStages([gain()]);
        expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
      });
    });

    it("builds the built-in transform, whatever transform the renderer holds", () => {
      withRenderer({ stages: [], pipeline: FAILING_PIPELINE }, (renderer) => {
        renderer.prepareStockProgram(LEGACY_PROCESS_VERSION);
        // The renderer's own transform was never tried, so nothing fell back from it.
        expect(logged).not.toHaveBeenCalled();
      });
    });

    it("builds Safelight's own stages with the built-in transform, like the real program", () => {
      const { gl } = glHarness();
      const tally = trackGlObjects(gl);
      try {
        withRenderer({ stages: builtinStages(), pipeline: BUILTIN_RESOLVED }, (renderer) => {
          renderer.prepareProgram(LEGACY_PROCESS_VERSION);
          expect(tally.created.program).toBe(1);
          // A set of only Safelight's own stages is the stock program: nothing new to build.
          renderer.prepareStockProgram(LEGACY_PROCESS_VERSION);
          expect(tally.created.program).toBe(1);
        });
      } finally {
        tally.restore();
      }
    });

    it("builds around an extension stage that can't, which stays a stage failure", () => {
      const stages = [...builtinStages(), broken];
      withRenderer({ stages, pipeline: BUILTIN_RESOLVED }, (renderer) => {
        expect(() => renderer.prepareProgram(LEGACY_PROCESS_VERSION)).toThrow(/neverDeclared/);
        expect(() => renderer.prepareStockProgram(LEGACY_PROCESS_VERSION)).not.toThrow();
      });
    });

    it("fails where one of Safelight's own stages can't be built", () => {
      const brokenOwn: ProcessingStageContribution = {
        id: "core.broken",
        name: "Broken built-in",
        phase: "effects",
        glsl: "c = neverDeclared(c);",
        uniforms: [],
      };
      withRenderer({ stages: [brokenOwn], pipeline: BUILTIN_RESOLVED }, (renderer) => {
        expect(() => renderer.prepareStockProgram(LEGACY_PROCESS_VERSION)).toThrow(/neverDeclared/);
      });
    });

    it("builds into the cache that a stage-less built-in frame then uses", () => {
      const { gl } = glHarness();
      const tally = trackGlObjects(gl);
      try {
        withRenderer({ stages: [broken], pipeline: BUILTIN_RESOLVED }, (renderer) => {
          renderer.setImage(flatSource());
          renderer.setParams(identityParams());
          renderer.prepareStockProgram(LEGACY_PROCESS_VERSION);
          expect(tally.created.program).toBe(1);
          renderer.setStages([]);
          renderer.render();
          expect(tally.created.program).toBe(1);
        });
      } finally {
        tally.restore();
      }
    });

    it("remembers a stock program that fails to build, like any other", () => {
      const { gl } = glHarness();
      const tally = trackGlObjects(gl);
      const fault = failCompiles(gl);
      try {
        withRenderer({ stages: [], pipeline: BUILTIN_RESOLVED }, (renderer) => {
          const first = failure(() => renderer.prepareStockProgram(LEGACY_PROCESS_VERSION));
          expect(first).toBeInstanceOf(Error);
          const compiled = tally.created.shader;
          expect(compiled).toBeGreaterThan(0);
          expect(failure(() => renderer.prepareStockProgram(LEGACY_PROCESS_VERSION))).toBe(first);
          expect(tally.created.shader).toBe(compiled);
        });
      } finally {
        fault.restore();
        tally.restore();
      }
    });
  });
});

describe("output sizing", () => {
  it("sizes the buffer to the source at full crop", () => {
    withRenderer(undefined, (renderer) => {
      renderer.setImage(floatImage(24, 12, () => [0.2, 0.2, 0.2]));
      renderer.setParams(identityParams());
      renderer.render();
      expect([renderer.bufferWidth, renderer.bufferHeight]).toEqual([24, 12]);
    });
  });

  it("sizes the buffer to the cropped region", () => {
    withRenderer(undefined, (renderer) => {
      renderer.setImage(floatImage(24, 12, () => [0.2, 0.2, 0.2]));
      renderer.setParams(
        identityParams({ crop: { x: 0.25, y: 0, width: 0.5, height: 0.5 } }),
      );
      renderer.render();
      expect([renderer.bufferWidth, renderer.bufferHeight]).toEqual([12, 6]);
    });
  });

  it("never allocates more output pixels than the zoom window holds", () => {
    withRenderer(undefined, (renderer) => {
      renderer.setImage(flatSource(16));
      renderer.setParams(identityParams());
      // A screen-sized request for a quarter-frame window: the window only
      // carries 8x8 source pixels, so upscaling past that is wasted memory.
      renderer.setViewport({ x: 0, y: 0, w: 0.5, h: 0.5 }, 256, 256);
      renderer.render();
      expect([renderer.bufferWidth, renderer.bufferHeight]).toEqual([8, 8]);
    });
  });
});

describe("pixel behaviour", () => {
  it("passes a flat source through unchanged at identity settings", () => {
    const frame = linearFrame((renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
    });
    expect(frame.width).toBe(16);
    for (const channel of pixelAt(frame, 8, 8)) {
      expect(channel).toBeCloseTo(FLAT_GREY, 2);
    }
  });

  it("doubles the linear value per stop of exposure", () => {
    const at = (exposure: number) =>
      pixelAt(
        linearFrame((renderer) => {
          renderer.setImage(flatSource());
          renderer.setParams(identityParams({ exposure }));
        }),
        8,
        8,
      )[1];

    const base = at(0);
    // The filmic shoulder only engages above a luma of 0.85, and 0.2 EV+1 is
    // 0.4, so this stays on the linear part of the curve where a stop is a
    // clean factor of two.
    expect(at(1) / base).toBeCloseTo(2, 1);
    expect(at(-1) / base).toBeCloseTo(0.5, 1);
  });

  it("collapses a coloured pixel to neutral at saturation -100", () => {
    const frame = linearFrame((renderer) => {
      renderer.setImage(floatImage(16, 16, () => [0.35, 0.12, 0.06]));
      renderer.setParams(identityParams({ saturation: -100 }));
    });
    const [r, g, b] = pixelAt(frame, 8, 8);
    expect(g).toBeCloseTo(r, 3);
    expect(b).toBeCloseTo(r, 3);
    expect(r).toBeGreaterThan(0);
  });

  it("keeps a coloured pixel coloured at identity settings", () => {
    const frame = linearFrame((renderer) => {
      renderer.setImage(floatImage(16, 16, () => [0.35, 0.12, 0.06]));
      renderer.setParams(identityParams());
    });
    const [r, g, b] = pixelAt(frame, 8, 8);
    expect(r).toBeCloseTo(0.35, 2);
    expect(g).toBeCloseTo(0.12, 2);
    expect(b).toBeCloseTo(0.06, 2);
  });

  // A yellow beyond the sRGB primaries, blown in red and green, decodes with
  // its blue channel at or below black. Highlight reconstruction rebuilds a
  // pixel with two clipped channels from the third; with no positive third
  // channel to scale from it must leave the yellow alone, neither flipping it
  // to blue nor zeroing it to black.
  for (const blue of [0, -0.03125]) {
    it(`leaves a clipped yellow with blue at ${blue} as decoded`, () => {
      const frame = linearFrame((renderer) => {
        renderer.setImage(floatImage(16, 16, () => [1.25, 1.25, blue]));
        renderer.setParams(identityParams());
      });
      const [r, g, b] = pixelAt(frame, 8, 8);
      expect(r).toBeGreaterThan(0.9);
      expect(g).toBeCloseTo(r, 3);
      expect(b).toBeLessThan(PIXEL_TOLERANCE);
    });
  }

  // Neighbours below black can drag the half-resolution average that
  // reconstruction takes its reference from down to zero or past it. At -4 EV
  // every decoded pixel stays on the linear part of the tone chain, so a
  // pixel rebuilt from that reference shows up as a bright speck or a hole.
  const checker =
    (even: number, odd: number) =>
    (x: number, y: number): number =>
      (x + y) % 2 === 0 ? even : odd;
  const SIGNED_NEIGHBOURS: {
    name: string;
    texel: (x: number, y: number) => readonly [number, number, number];
  }[] = [
    {
      name: "two clipped, blue +0.01 beside -0.03",
      texel: (x, y) => [1.25, 1.25, checker(0.01, -0.03)(x, y)],
    },
    {
      name: "two clipped, blue +0.01 beside -0.0096",
      texel: (x, y) => [1.25, 1.25, checker(0.01, -0.0096)(x, y)],
    },
    {
      name: "one clipped, green +0.1 beside -0.9",
      texel: (x, y) => [1.25, checker(0.1, -0.9)(x, y), 0],
    },
  ];
  for (const { name, texel } of SIGNED_NEIGHBOURS) {
    it(`keeps clipped pixels near their decoded level (${name})`, () => {
      const frame = linearFrame((renderer) => {
        renderer.setImage(floatImage(16, 16, texel));
        renderer.setParams(identityParams({ exposure: -4 }));
      });
      const clipped = 1.25 / 16;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const out = pixelAt(frame, x, y);
          for (const channel of out) {
            expect(Number.isFinite(channel)).toBe(true);
            expect(channel).toBeLessThanOrEqual(2 * clipped);
          }
          expect(out[0]).toBeGreaterThan(0.5 * clipped);
        }
      }
    });
  }

  // One pixel blown in red and green among unclipped neighbours with a 0.6 :
  // 0.8 ratio. Reconstruction rebuilds the two clipped channels from the
  // neighbourhood, so the pixel leaves its clipped 1 : 1 for a ratio near the
  // neighbours'; the mip-1 reference still carries ~14 % of the pixel itself.
  const LONE_CLIP = floatImage(16, 16, (x, y) =>
    x === 8 && y === 8 ? [1.25, 1.25, 0.5] : [0.6, 0.8, 0.5],
  );
  const LONE_CLIP_SOURCES = [
    ["float", LONE_CLIP],
    ["float16", cached(LONE_CLIP)],
  ] as const;
  for (const [kind, source] of LONE_CLIP_SOURCES) {
    it(`rebuilds a clipped pixel from its neighbours (${kind} source)`, () => {
      const frame = linearFrame((renderer) => {
        renderer.setImage(source);
        renderer.setParams(identityParams());
      });
      const [r, g] = pixelAt(frame, 8, 8);
      expect(r / g).toBeGreaterThan(0.75);
      expect(r / g).toBeLessThan(0.85);
    });
  }

  it("maps a corner to the opposite corner under a 180 degree rotation", () => {
    // Flipping both axes is a 180 degree rotation; straighten only spans ±45.
    const gradient = floatImage(8, 8, (x, y) => [(x + 0.5) / 16, (y + 0.5) / 16, 0.1]);
    const upright = linearFrame((renderer) => {
      renderer.setImage(gradient);
      renderer.setParams(identityParams());
    });
    const rotated = linearFrame((renderer) => {
      renderer.setImage(gradient);
      renderer.setParams(
        identityParams({ transform: { ...DEFAULT_TRANSFORM, flipH: true, flipV: true } }),
      );
    });

    const [ur, ug] = pixelAt(upright, 0, 0);
    const [rr, rg] = pixelAt(rotated, 7, 7);
    expect(rr).toBeCloseTo(ur, 2);
    expect(rg).toBeCloseTo(ug, 2);
    // …and the far corner now carries what used to be nearest the origin.
    expect(pixelAt(rotated, 0, 0)[0]).toBeCloseTo(pixelAt(upright, 7, 7)[0], 2);
  });

  it("renders only the requested zoom window", () => {
    const quadrants = floatImage(16, 16, (x, y) => {
      const v = x < 8 && y < 8 ? 0.4 : 0.1;
      return [v, v, v];
    });
    const frame = linearFrame((renderer) => {
      renderer.setImage(quadrants);
      renderer.setParams(identityParams());
      renderer.setViewport({ x: 0, y: 0, w: 0.5, h: 0.5 }, 8, 8);
    });
    for (const corner of [
      pixelAt(frame, 0, 0),
      pixelAt(frame, 7, 0),
      pixelAt(frame, 0, 7),
      pixelAt(frame, 7, 7),
    ]) {
      expect(corner[0]).toBeCloseTo(0.4, 2);
    }
  });

  it("paints the surround colour outside the image", () => {
    const frame = linearFrame((renderer) => {
      renderer.setImage(flatSource());
      renderer.setOutsideColor([1, 0, 0]);
      // Scaling down leaves the frame's corners sampling outside the source.
      renderer.setParams(
        identityParams({ transform: { ...DEFAULT_TRANSFORM, scale: 40 } }),
      );
    });
    expect(pixelAt(frame, 0, 0)).toEqual([1, 0, 0]);
    expect(pixelAt(frame, 8, 8)[0]).toBeCloseTo(FLAT_GREY, 2);
  });
});

// A display transform with its own highlight roll-off opts out of the core
// shoulder. The probe halves the working colour so headroom up to 2.0 survives
// the display clamp, and reads are doubled back into scene units; SHOULDERED
// is the same transform keeping the core shoulder.
describe("a display transform that skips the tone shoulder", () => {
  const HALVING = "vec3 pipelineToDisplay(vec3 lin) { return lin * 0.5; }";
  const SHOULDERED: ResolvedPipeline = {
    id: "test.halving",
    glsl: HALVING,
    skipBaseCurve: true,
    skipToneShoulder: false,
    sig: "test.halving",
  };
  const SHOULDERLESS: ResolvedPipeline = {
    ...SHOULDERED,
    skipToneShoulder: true,
    sig: "test.halving+shoulderless",
  };
  const TOLERANCE = 2 * PIXEL_TOLERANCE;

  // Luminance 0.95, warm enough for the recovery's colourfulness step to act
  // on, with every channel under the clip threshold reconstruction uses.
  const BRIGHT: readonly [number, number, number] = [0.97, 0.95, 0.9];

  const luma = ([r, g, b]: readonly number[]) =>
    0.2126 * r + 0.7152 * g + 0.0722 * b;

  function sceneAt(renderer: WebGLRenderer): number[] {
    return pixelAt(capture(renderer), 8, 8).map((v) => v * 2);
  }

  function scene(
    pipeline: ResolvedPipeline,
    highlights: number,
    texel: readonly [number, number, number] = BRIGHT,
  ): number[] {
    return withRenderer({ stages: [], pipeline }, (renderer) => {
      renderer.setImage(floatImage(16, 16, () => texel));
      renderer.setParams(identityParams({ highlights }));
      return sceneAt(renderer);
    });
  }

  it("hands the transform luminance 0.95 uncompressed at Highlights 0", () => {
    const out = scene(SHOULDERLESS, 0);
    out.forEach((v, i) =>
      expect(Math.abs(v - BRIGHT[i])).toBeLessThan(TOLERANCE),
    );
    expect(luma(scene(SHOULDERED, 0))).toBeLessThan(luma(BRIGHT) - 0.05);
  });

  it("recovers highlights exactly as the core does at Highlights -100", () => {
    const out = scene(SHOULDERLESS, -100);
    const core = scene(SHOULDERED, -100);
    expect(luma(core)).toBeLessThan(luma(BRIGHT) - 0.2);
    out.forEach((v, i) =>
      expect(Math.abs(v - core[i])).toBeLessThan(TOLERANCE),
    );
  });

  it("blends in the core shoulder in proportion at Highlights -50", () => {
    const none = luma(scene(SHOULDERLESS, 0));
    const full = luma(scene(SHOULDERLESS, -100));
    const half = luma(scene(SHOULDERLESS, -50));
    expect(half).toBeLessThan(none - TOLERANCE);
    expect(half).toBeGreaterThan(full + TOLERANCE);
    const coreHalf = luma(scene(SHOULDERED, -50));
    expect(Math.abs(half - (none + coreHalf) / 2)).toBeLessThan(TOLERANCE);
  });

  it("leaves values above white untouched at positive Highlights", () => {
    const hot: [number, number, number] = [1.6, 1.6, 1.6];
    for (const highlights of [50, 100]) {
      const out = luma(scene(SHOULDERLESS, highlights, hot));
      expect(Math.abs(out - 1.6)).toBeLessThan(TOLERANCE);
    }
  });

  it("lifts values below white as the core does at positive Highlights", () => {
    const mid: [number, number, number] = [0.6, 0.6, 0.6];
    const lifted = scene(SHOULDERLESS, 50, mid);
    expect(luma(lifted)).toBeGreaterThan(0.6 + 0.01);
    const coreLifted = luma(scene(SHOULDERED, 50, mid));
    expect(Math.abs(luma(lifted) - coreLifted)).toBeLessThan(TOLERANCE);
  });

  it("follows the transform through a one-off render and back", () => {
    withRenderer({ stages: [], pipeline: SHOULDERED }, (renderer) => {
      renderer.setImage(floatImage(16, 16, () => BRIGHT));
      renderer.setParams(identityParams());
      const live = luma(sceneAt(renderer));
      const oneOff = luma(
        withPipeline(renderer, SHOULDERLESS, SHOULDERED, () => sceneAt(renderer)),
      );
      expect(live).toBeLessThan(luma(BRIGHT) - 0.05);
      expect(Math.abs(oneOff - luma(BRIGHT))).toBeLessThan(TOLERANCE);
      expect(Math.abs(luma(sceneAt(renderer)) - live)).toBeLessThan(TOLERANCE);
    });
  });

  // Mask Highlights keeps its own recovery and lift curves but follows the
  // global slider's rules. The mask covers the whole frame (no components,
  // inverted), and its Exposure +80 lifts a 0.4 grey two stops to 1.6: 0.4
  // sits under the core knee, so both transforms hand the mask's Highlights
  // the same value above white.
  describe("inside a mask", () => {
    const GREY: [number, number, number] = [0.4, 0.4, 0.4];
    const LIFTED = 1.6;

    function masked(
      pipeline: ResolvedPipeline,
      adj: Partial<MaskAdjustments>,
      texel: readonly [number, number, number] = GREY,
    ): number {
      const mask: Mask = {
        id: "whole",
        name: "Whole frame",
        visible: true,
        invert: true,
        opacity: 100,
        adj: { ...defaultMaskAdjustments(), exposure: 80, ...adj },
        panels: [...DEFAULT_MASK_PANELS],
        components: [],
      };
      return withRenderer({ stages: [], pipeline }, (renderer) => {
        renderer.setImage(floatImage(16, 16, () => texel));
        renderer.setParams(identityParams({ masks: [mask] }));
        return luma(sceneAt(renderer));
      });
    }

    it("keeps the headroom at a slight negative Highlights", () => {
      const slight = { highlights: -1 };
      expect(masked(SHOULDERLESS, slight)).toBeGreaterThan(LIFTED - 0.03);
      // With the core shoulder, the mask curve still flattens it to white.
      expect(Math.abs(masked(SHOULDERED, slight) - 1)).toBeLessThan(TOLERANCE);
    });

    it("recovers in proportion to the slider", () => {
      const full = masked(SHOULDERED, { highlights: -100 });
      const out = masked(SHOULDERLESS, { highlights: -100 });
      expect(Math.abs(out - full)).toBeLessThan(TOLERANCE);
      const coreHalf = masked(SHOULDERED, { highlights: -50 });
      const half = masked(SHOULDERLESS, { highlights: -50 });
      expect(Math.abs(half - (LIFTED + coreHalf) / 2)).toBeLessThan(TOLERANCE);
    });

    it("leaves values above white untouched at positive Highlights", () => {
      for (const highlights of [50, 100]) {
        const out = masked(SHOULDERLESS, { highlights });
        expect(Math.abs(out - LIFTED)).toBeLessThan(TOLERANCE);
      }
    });

    it("lifts values below white as the core does", () => {
      const mid: [number, number, number] = [0.6, 0.6, 0.6];
      const lift = { exposure: 0, highlights: 50 };
      const lifted = masked(SHOULDERLESS, lift, mid);
      expect(lifted).toBeGreaterThan(0.6 + 0.01);
      const core = masked(SHOULDERED, lift, mid);
      expect(Math.abs(lifted - core)).toBeLessThan(TOLERANCE);
    });
  });
});

// The develop-preview cache hands back what the fresh decode rendered from,
// stored as half floats. Every value below is exact in binary16, so the cached
// and fresh sources are the same pixels and their frames must match.
describe("cached half-float sources", () => {
  const HIGHLIGHTS = floatImage(16, 16, (x, y) =>
    x < 8 ? [2.25, 1.5, 0.375] : y < 8 ? [1.5, 1.5, 1.5] : [0.25, 0.125, 0.0625],
  );

  function stockFrame(
    source: FloatImage | ReturnType<typeof cached>,
    exposure: number,
  ): Frame {
    return withRenderer(undefined, (renderer) => {
      renderer.setImage(source);
      renderer.setParams({ ...DEFAULT_DEVELOP_PARAMS, exposure });
      return capture(renderer);
    });
  }

  it("renders like the float source it was cached from", () => {
    for (const exposure of [0, -1.5]) {
      const fresh = stockFrame(HIGHLIGHTS, exposure);
      const reopened = stockFrame(cached(HIGHLIGHTS), exposure);
      expect([reopened.width, reopened.height]).toEqual([fresh.width, fresh.height]);
      expect(worstDifference(reopened, fresh)).toBeLessThan(1e-6);
    }
  });

  it("keeps the headroom above 1.0 for Exposure to pull back", () => {
    const frame = linearFrame((renderer) => {
      renderer.setImage(cached(flatSource(16, 1.5)));
      renderer.setParams(identityParams({ exposure: -1 }));
    });
    for (const channel of pixelAt(frame, 8, 8)) {
      expect(channel).toBeCloseTo(0.75, 2);
    }
  });

  // The zoom window never allocates more output pixels than the source holds
  // inside it, so its size reads back the uploaded resolution.
  function zoomedBuffer(configure: (renderer: WebGLRenderer) => void): number[] {
    return withRenderer(undefined, (renderer) => {
      configure(renderer);
      renderer.setParams(identityParams());
      renderer.setViewport({ x: 0, y: 0, w: 0.5, h: 0.5 }, 256, 256);
      renderer.render();
      return [renderer.bufferWidth, renderer.bufferHeight];
    });
  }

  it("uploads at its stored size, past the output cap", () => {
    const source = cached(flatSource(32));
    expect(zoomedBuffer((r) => r.setImage(source, 8))).toEqual([16, 16]);
    expect(zoomedBuffer((r) => r.uploadSource("k", source, 8))).toEqual([16, 16]);
  });

  it("caps to the output edge when the thumbnail renderer opts in", () => {
    const source = cached(flatSource(32));
    const capped = zoomedBuffer((r) =>
      r.uploadSource("k", source, 8, false, false, true, true),
    );
    expect(capped).toEqual([4, 4]);
  });
});

// Some drivers pass the constructor's 2x2 RGBA16 mipmap probe and then fail
// generateMipmap on a full-size RGBA16 texture, leaving its mip chain unbuilt.
// SwiftShader has no EXT_texture_norm16, so the fault stands one in on the
// shared context: it reports the extension, backs each RGBA16 texture with
// RGBA8 storage, mipmaps the 2x2 probe and refuses anything larger with
// INVALID_OPERATION — the driver bug as the renderer sees it.
const RGBA16_EXT = 0x805b;

type MipmapCall = "probe" | "refused" | "refused RGBA16F" | "built";

interface MipmapFault {
  /** Each generateMipmap call: the 2x2 probe, a refused full-size RGBA16
   *  texture, a refused RGBA16F one, or any other texture, mipmapped as
   *  normal. */
  calls: MipmapCall[];
  restore(): void;
}

function emulateRgba16MipmapBug(gl: WebGL2RenderingContext): MipmapFault {
  const original = {
    getExtension: gl.getExtension,
    texImage2D: gl.texImage2D,
    generateMipmap: gl.generateMipmap,
    getError: gl.getError,
  };
  // RGBA16 textures, mapped to whether they are larger than the probe.
  const rgba16 = new Map<WebGLTexture, boolean>();
  const calls: MipmapCall[] = [];
  let raised = false;
  const bound = (): WebGLTexture | null =>
    gl.getParameter(gl.TEXTURE_BINDING_2D);

  gl.getExtension = (name: string) =>
    name === "EXT_texture_norm16"
      ? { RGBA16_EXT }
      : Reflect.apply(original.getExtension, gl, [name]);
  gl.texImage2D = (...args: unknown[]) => {
    const tex = bound();
    const [target, level, internalFormat, width, height, border] = args;
    if (tex && level === 0) rgba16.delete(tex);
    if (internalFormat !== RGBA16_EXT) {
      Reflect.apply(original.texImage2D, gl, args);
      return;
    }
    if (tex && level === 0) {
      rgba16.set(tex, Number(width) > 2 || Number(height) > 2);
    }
    Reflect.apply(original.texImage2D, gl, [
      target, level, gl.RGBA8, width, height, border,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    ]);
  };
  gl.generateMipmap = (target: number) => {
    const tex = bound();
    const fullSize = tex === null ? undefined : rgba16.get(tex);
    if (fullSize) {
      calls.push("refused");
      raised = true;
      return;
    }
    calls.push(fullSize === false ? "probe" : "built");
    original.generateMipmap.call(gl, target);
  };
  gl.getError = () => {
    if (!raised) return original.getError.call(gl);
    raised = false;
    return gl.INVALID_OPERATION;
  };

  return {
    calls,
    restore() {
      Object.assign(gl, original);
    },
  };
}

// A retouched frame develops from a patched copy of the source whose mip chain
// feeds the blur taps; an unbuilt chain samples as black.
describe("a retouched frame on a driver that can't mipmap RGBA16", () => {
  const SOURCE = floatImage(16, 16, (x, y) =>
    [0.1 + x / 40, 0.2 + y / 80, 0.3],
  );
  const CLONE: RetouchSpot = {
    id: "spot",
    shape: "circle",
    mode: "clone",
    visible: true,
    dstX: 0.5,
    dstY: 0.5,
    srcX: 0.25,
    srcY: 0.25,
    radius: 0.15,
    feather: 0,
    opacity: 100,
  };

  function retouched(renderer: WebGLRenderer): Frame {
    renderer.setImage(SOURCE);
    renderer.setParams(identityParams({ retouch: [CLONE] }));
    return capture(renderer);
  }

  it("falls back to an 8-bit patched source within the same frame", () => {
    const { gl } = glHarness();
    const reference = withRenderer(
      { stages: [], pipeline: LINEAR_PROBE_PIPELINE, highBitDepth: false },
      retouched,
    );

    const fault = emulateRgba16MipmapBug(gl);
    try {
      withRenderer(
        { stages: [], pipeline: LINEAR_PROBE_PIPELINE, highBitDepth: true },
        (renderer) => {
          const frame = retouched(renderer);
          expect(pixelAt(frame, 8, 8)[1]).toBeGreaterThan(0.1);
          expect(worstDifference(frame, reference)).toBeLessThan(1e-6);
          expect(fault.calls).toEqual(["probe", "refused", "built"]);

          // The renderer keeps the 8-bit target, so later frames don't retry
          // the failing format.
          capture(renderer);
          expect(fault.calls).toEqual(["probe", "refused", "built", "built"]);
        },
      );
    } finally {
      fault.restore();
    }
  });
});

// One heal or clone spot develops the whole frame from the patched copy, so the
// copy's range is the frame's. WIDE_PROBE shows scene values from -2 to 6
// between black and white, where headroom and a channel below black both
// survive the output encode's clamp. It owns its baseline and roll-off, so at
// identity nothing else moves a value on its way to the probe.
const WIDE_PROBE: ResolvedPipeline = {
  id: "test.wide-probe",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return 0.25 + lin * 0.125; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
  sig: "test.wide-probe",
};

/** One pixel of a WIDE_PROBE frame, as the scene values it shows. */
function sceneAt(frame: Frame, x: number, y: number): number[] {
  return pixelAt(frame, x, y).map((v) => (v - 0.25) / 0.125);
}

const V1 = { processVersion: LEGACY_PROCESS_VERSION };
const V2 = { processVersion: CURRENT_PROCESS_VERSION };

const SKY = 4;
const BELOW_BLACK = [0.3, 0.2, -0.25] as const;

/** A sky at 4.0 over the top half with a dark 2x2 speck at (7, 7), and below
 *  it a colour outside sRGB, its blue below black. */
const SPECKLED_SKY = floatImage(32, 32, (x, y) => {
  if (y >= 16) return BELOW_BLACK;
  const speck = x >= 7 && x <= 8 && y >= 7 && y <= 8;
  return speck ? [0.05, 0.05, 0.05] : [SKY, SKY, SKY];
});

/** Heals the speck from the sky to its right. Its disc covers no pixel outside
 *  x and y 4 to 11. */
const SPECK_HEAL: RetouchSpot = {
  id: "speck",
  shape: "circle",
  mode: "heal",
  visible: true,
  dstX: 0.25,
  dstY: 0.25,
  srcX: 0.75,
  srcY: 0.25,
  radius: 0.1,
  feather: 0,
  opacity: 100,
};

const inSpeckSpot = (x: number, y: number) => x >= 4 && x < 12 && y >= 4 && y < 12;

function healed(version: Partial<DevelopParams>, over: Partial<DevelopParams> = {}): DevelopParams {
  return identityParams({ ...version, retouch: [SPECK_HEAL], ...over });
}

/** One frame of the speckled sky, the denoiser fed as Develop feeds it. */
function skyFrame(params: DevelopParams, stages: ProcessingStageContribution[] = []): Frame {
  return withRenderer({ stages, pipeline: WIDE_PROBE }, (renderer) => {
    renderer.setImage(SPECKLED_SKY);
    renderer.setParams(params);
    renderer.setContributedParams(denoiseBag(params));
    return capture(renderer);
  });
}

describe("a heal spot on a frame with values outside [0, 1]", () => {
  it("leaves the rest of a version 2 frame as it was", () => {
    const plain = skyFrame(identityParams(V2));
    expect(sceneAt(plain, 24, 4)[1]).toBeCloseTo(SKY, 1);
    expect(sceneAt(plain, 8, 24)[2]).toBeCloseTo(BELOW_BLACK[2], 1);
    const frame = skyFrame(healed(V2));
    expect(worstDifference(frame, plain, inSpeckSpot)).toBeLessThan(1e-3);
    // The heal did change the spot, so a skip that dropped every pixel couldn't pass.
    expect(worstDifference(frame, plain, (x, y) => !inSpeckSpot(x, y))).toBeGreaterThan(0.1);
  });

  it("heals from a bright area to a value above white on version 2", () => {
    for (const channel of sceneAt(skyFrame(healed(V2)), 8, 8)) {
      expect(channel).toBeCloseTo(SKY, 1);
    }
  });

  // Edits made before process versions keep the copy they were made with.
  it("clips the whole frame to [0, 1] on version 1, as it always has", () => {
    const frame = skyFrame(healed(V1));
    for (const [x, y] of [[8, 8], [24, 4]] as const) {
      for (const channel of sceneAt(frame, x, y)) expect(channel).toBeCloseTo(1, 1);
    }
    const [r, g, b] = sceneAt(frame, 8, 24);
    expect(r).toBeCloseTo(BELOW_BLACK[0], 1);
    expect(g).toBeCloseTo(BELOW_BLACK[1], 1);
    expect(b).toBeCloseTo(0, 1);
  });

  it("hands the denoiser the copy's full range on version 2", () => {
    const stages = [builtinStage(BUILTIN_DENOISE_ID)];
    withRenderer({ stages, pipeline: WIDE_PROBE }, (renderer) => {
      const params = healed(V2, { colorNR: 25 });
      renderer.setImage(SPECKLED_SKY);
      renderer.setParams(params);
      renderer.setContributedParams(denoiseBag(params));
      const frame = capture(renderer);
      expect(renderer.renderDrawCounts.pass).toBeGreaterThan(0);
      expect(sceneAt(frame, 24, 4)[1]).toBeCloseTo(SKY, 1);
      expect(sceneAt(frame, 8, 8)[1]).toBeCloseTo(SKY, 1);
      expect(sceneAt(frame, 8, 24)[2]).toBeCloseTo(BELOW_BLACK[2], 1);
    });
  });

  it("hands a stage that reads the current image the copy's full range on version 2", () => {
    const current: ProcessingStageContribution = {
      id: "test.current",
      name: "Current copy",
      phase: "scene-linear",
      reads: "current",
      glsl: "lin = mix(lin, stageResult, take);",
      uniforms: [{ key: "take", glslType: "float", default: 0 }],
      passes: [{ glsl: "c = c;" }],
    };
    withRenderer({ stages: [current], pipeline: WIDE_PROBE }, (renderer) => {
      renderer.setImage(SPECKLED_SKY);
      renderer.setParams(healed(V2));
      renderer.setContributedParams({ "test.current.take": 1 });
      const frame = capture(renderer);
      expect(renderer.renderDrawCounts.split).toBe(1);
      expect(sceneAt(frame, 24, 4)[1]).toBeCloseTo(SKY, 1);
      expect(sceneAt(frame, 8, 8)[1]).toBeCloseTo(SKY, 1);
      expect(sceneAt(frame, 8, 24)[2]).toBeCloseTo(BELOW_BLACK[2], 1);
    });
  });

  // A session switches between photos of both versions. Each frame must develop
  // from a copy in its own version's format, and the denoiser's cached result
  // from one version's copy must not stand in for the other's.
  it("draws each version as a fresh renderer does when frames alternate, with no new GL objects", () => {
    const stages = [builtinStage(BUILTIN_DENOISE_ID)];
    const versions = [V1, V2];
    const params = versions.map((version) => healed(version, { colorNR: 25 }));
    const fresh = params.map((p) => skyFrame(p, stages));
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const renderer = new WebGLRenderer(canvas, { stages, pipeline: WIDE_PROBE });
      renderer.setImage(SPECKLED_SKY);
      const drift = (index: number): number => {
        renderer.setParams(params[index]);
        renderer.setContributedParams(denoiseBag(params[index]));
        return worstDifference(capture(renderer), fresh[index]);
      };
      expect([drift(0), drift(1)]).toEqual([0, 0]);
      const live = { ...tally.live };
      expect([drift(0), drift(1), drift(0), drift(1)]).toEqual([0, 0, 0, 0]);
      expect(tally.live).toEqual(live);
      renderer.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
    }
  });

  // A camera-rendered photo is display-encoded: it holds nothing outside [0, 1],
  // and its decode is undefined below -0.055. A heal's colour correction can
  // still put a copied pixel there: a black dot in a bright source, healed into
  // shadow, lands far below black.
  it("keeps a camera-rendered photo's heal inside [0, 1] on version 2", async () => {
    const pixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const dot = x >= 23 && x <= 24 && y >= 15 && y <= 16;
        const v = x < 16 ? 5 : dot ? 0 : 204;
        pixels.set([v, v, v, 255], (y * 32 + x) * 4);
      }
    }
    const bitmap = await createImageBitmap(new ImageData(pixels, 32, 32));
    const intoShadow: RetouchSpot = { ...SPECK_HEAL, dstY: 0.5, srcY: 0.5 };
    const frame = withRenderer({ stages: [], pipeline: WIDE_PROBE }, (renderer) => {
      renderer.setImage(bitmap);
      renderer.setParams(identityParams({ ...V2, retouch: [intoShadow] }));
      return capture(renderer);
    });
    for (const channel of sceneAt(frame, 8, 16)) expect(channel).toBeCloseTo(0, 2);
  });
});

// SwiftShader mipmaps RGBA16F, which EXT_color_buffer_float makes renderable.
// The fault refuses it, as a driver that fails the full-size copy would: the
// patched copy is the only RGBA16F texture the renderer mipmaps. Stacked on
// another fault (`under`), it logs its refusals into that fault's calls and
// leaves logging the rest to it, so the two share one ordered log.
function refuseHalfFloatMipmaps(gl: WebGL2RenderingContext, under?: MipmapFault): MipmapFault {
  const original = {
    texImage2D: gl.texImage2D,
    generateMipmap: gl.generateMipmap,
    getError: gl.getError,
  };
  const halfFloat = new Set<WebGLTexture>();
  const calls: MipmapCall[] = under?.calls ?? [];
  let raised = false;
  const bound = (): WebGLTexture | null => gl.getParameter(gl.TEXTURE_BINDING_2D);

  gl.texImage2D = (...args: unknown[]) => {
    const tex = bound();
    const [, level, internalFormat] = args;
    if (tex && level === 0) {
      if (internalFormat === gl.RGBA16F) halfFloat.add(tex);
      else halfFloat.delete(tex);
    }
    Reflect.apply(original.texImage2D, gl, args);
  };
  gl.generateMipmap = (target: number) => {
    const tex = bound();
    if (tex && halfFloat.has(tex)) {
      calls.push("refused RGBA16F");
      raised = true;
      return;
    }
    if (!under) calls.push("built");
    original.generateMipmap.call(gl, target);
  };
  gl.getError = () => {
    if (!raised) return original.getError.call(gl);
    raised = false;
    return gl.INVALID_OPERATION;
  };

  return {
    calls,
    restore() {
      Object.assign(gl, original);
    },
  };
}

/** Runs `fn` with half-float mipmaps refused, then puts the context back. */
function withHalfFloatMipmapsRefused<T>(fn: (fault: MipmapFault) => T): T {
  const fault = refuseHalfFloatMipmaps(glHarness().gl);
  try {
    return fn(fault);
  } finally {
    fault.restore();
  }
}

describe("a retouched frame on a driver that can't mipmap RGBA16F", () => {
  it("falls back to a clipped copy within the same frame on version 2, and keeps it", () => {
    withHalfFloatMipmapsRefused((fault) => {
      withRenderer({ stages: [], pipeline: WIDE_PROBE }, (renderer) => {
        renderer.setImage(SPECKLED_SKY);
        renderer.setParams(healed(V2));
        const frame = capture(renderer);
        expect(fault.calls).toEqual(["refused RGBA16F", "built"]);
        for (const [x, y] of [[8, 8], [24, 4]] as const) {
          for (const channel of sceneAt(frame, x, y)) expect(channel).toBeCloseTo(1, 1);
        }
        capture(renderer);
        expect(fault.calls).toEqual(["refused RGBA16F", "built", "built"]);
      });
    });
  });

  it("never tries a half-float copy for a version 1 frame", () => {
    withHalfFloatMipmapsRefused((fault) => {
      skyFrame(healed(V1));
      expect(fault.calls).toEqual(["built"]);
    });
  });

  // Where norm16 is present but just as unable to mipmap a full-size copy, the
  // frame steps down twice and then stays on RGBA8.
  it("steps down through norm16 to RGBA8 within the same frame, then stays", () => {
    const { gl } = glHarness();
    const norm16 = emulateRgba16MipmapBug(gl);
    const halfFloat = refuseHalfFloatMipmaps(gl, norm16);
    try {
      withRenderer({ stages: [], pipeline: WIDE_PROBE, highBitDepth: true }, (renderer) => {
        renderer.setImage(SPECKLED_SKY);
        renderer.setParams(healed(V2));
        const frame = capture(renderer);
        expect(norm16.calls).toEqual(["probe", "refused RGBA16F", "refused", "built"]);
        for (const [x, y] of [[8, 8], [24, 4]] as const) {
          for (const channel of sceneAt(frame, x, y)) expect(channel).toBeCloseTo(1, 1);
        }
        capture(renderer);
        expect(norm16.calls).toEqual(["probe", "refused RGBA16F", "refused", "built", "built"]);
      });
    } finally {
      halfFloat.restore();
      norm16.restore();
    }
  });

  // The denoiser caches its result by the copy it read. A version 1 frame without
  // noise reduction reallocates the copy and leaves that cache alone, so when the
  // next version 2 frame's half-float copy fails at the same size, only the copy's
  // format tells the clipped copy it falls back to from the one cached.
  it("denoises the clipped copy afresh when the half-float copy fails at the same size", () => {
    const stages = [builtinStage(BUILTIN_DENOISE_ID)];
    const denoised = healed(V2, { colorNR: 25 });
    const reference = withHalfFloatMipmapsRefused(() => skyFrame(denoised, stages));
    withRenderer({ stages, pipeline: WIDE_PROBE }, (renderer) => {
      renderer.setImage(SPECKLED_SKY);
      const draw = (params: DevelopParams): Frame => {
        renderer.setParams(params);
        renderer.setContributedParams(denoiseBag(params));
        return capture(renderer);
      };
      expect(sceneAt(draw(denoised), 24, 4)[1]).toBeCloseTo(SKY, 1);
      draw(healed(V1));
      withHalfFloatMipmapsRefused((fault) => {
        const fallen = draw(denoised);
        expect(fault.calls).toEqual(["refused RGBA16F", "built"]);
        expect(sceneAt(fallen, 24, 4)[1]).toBeCloseTo(1, 1);
        expect(worstDifference(fallen, reference)).toBe(0);
      });
    });
  });
});

// The other way a half-float copy can fail: a driver that won't complete a
// framebuffer on it. The fault refuses only the patched copy, the one mipmapped
// float texture the renderer draws into, so the float capture and prepass
// targets still work.
function refuseHalfFloatTarget(gl: WebGL2RenderingContext): { refused: number; restore(): void } {
  const original = {
    texParameteri: gl.texParameteri,
    checkFramebufferStatus: gl.checkFramebufferStatus,
  };
  const mipmapped = new Set<WebGLTexture>();
  const fault = {
    refused: 0,
    restore() {
      Object.assign(gl, original);
    },
  };
  gl.texParameteri = (target: number, pname: number, param: number) => {
    const bound: WebGLTexture | null = gl.getParameter(gl.TEXTURE_BINDING_2D);
    if (bound && pname === gl.TEXTURE_MIN_FILTER && param === gl.LINEAR_MIPMAP_LINEAR) {
      mipmapped.add(bound);
    }
    original.texParameteri.call(gl, target, pname, param);
  };
  gl.checkFramebufferStatus = (target: number) => {
    const attachment = (pname: number): unknown =>
      gl.getFramebufferAttachmentParameter(target, gl.COLOR_ATTACHMENT0, pname);
    const tex = attachment(gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
    const float = attachment(gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) === gl.FLOAT;
    if (tex instanceof WebGLTexture && mipmapped.has(tex) && float) {
      fault.refused++;
      return gl.FRAMEBUFFER_UNSUPPORTED;
    }
    return original.checkFramebufferStatus.call(gl, target);
  };
  return fault;
}

describe("a retouched frame on a driver that can't render to an RGBA16F copy", () => {
  // norm16 is emulated here, as unable to mipmap a full-size copy as above, so
  // the norm16 copy showing up in its log is the step down from the half-float one.
  it("steps down to norm16 before RGBA8 on version 2", () => {
    const { gl } = glHarness();
    const norm16 = emulateRgba16MipmapBug(gl);
    const target = refuseHalfFloatTarget(gl);
    try {
      withRenderer({ stages: [], pipeline: WIDE_PROBE, highBitDepth: true }, (renderer) => {
        renderer.setImage(SPECKLED_SKY);
        renderer.setParams(healed(V2));
        const frame = capture(renderer);
        expect(target.refused).toBeGreaterThan(0);
        expect(norm16.calls).toEqual(["probe", "refused", "built"]);
        for (const [x, y] of [[8, 8], [24, 4]] as const) {
          for (const channel of sceneAt(frame, x, y)) expect(channel).toBeCloseTo(1, 1);
        }
      });
    } finally {
      target.restore();
      norm16.restore();
    }
  });
});

// A prepass stage that produces nothing this frame reads its result from a
// shared unit holding the develop source: on a retouched frame, the patched
// copy. The next frame's patch pass draws into that copy, so the unit has to
// let go of it first. A draw into a texture a sampler can read is a GL error,
// and the copy would keep the last frame's spots.
describe("a patched copy an idle stage's result unit still holds", () => {
  const IDLE: ProcessingStageContribution = {
    id: "test.idle",
    name: "Idle",
    phase: "scene-linear",
    glsl: "lin = mix(lin, stageResult, take);",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ glsl: "c = c;" }],
  };
  // Heals sky with sky, so the speck shows again.
  const ELSEWHERE: RetouchSpot = { ...SPECK_HEAL, id: "elsewhere", dstX: 0.75, srcX: 0.5 };

  for (const [name, version] of [["version 1", V1], ["version 2", V2]] as const) {
    it(`is redrawn for the next frame's spots on ${name}`, () => {
      const { gl } = glHarness();
      const moved = identityParams({ ...version, retouch: [ELSEWHERE] });
      const expected = skyFrame(moved, [IDLE]);
      withRenderer({ stages: [IDLE], pipeline: WIDE_PROBE }, (renderer) => {
        renderer.setImage(SPECKLED_SKY);
        renderer.setParams(healed(version));
        renderer.render();
        drainGlErrors(gl);
        renderer.setParams(moved);
        const frame = capture(renderer);
        expect(gl.getError()).toBe(gl.NO_ERROR);
        expect(worstDifference(frame, expected)).toBe(0);
      });
    });
  }
});

/** At each draw into the patched copy, the one mipmapped texture the renderer
 *  draws into, the texture units that still hold it. */
function watchDrawsIntoCopy(gl: WebGL2RenderingContext): {
  draws: number;
  held: number[];
  restore(): void;
} {
  const original = { texParameteri: gl.texParameteri, drawArrays: gl.drawArrays };
  const mipmapped = new Set<WebGLTexture>();
  const units: number = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
  const watch = {
    draws: 0,
    held: [] as number[],
    restore() {
      Object.assign(gl, original);
    },
  };
  gl.texParameteri = (target: number, pname: number, param: number) => {
    const bound: WebGLTexture | null = gl.getParameter(gl.TEXTURE_BINDING_2D);
    if (bound && pname === gl.TEXTURE_MIN_FILTER && param === gl.LINEAR_MIPMAP_LINEAR) {
      mipmapped.add(bound);
    }
    original.texParameteri.call(gl, target, pname, param);
  };
  gl.drawArrays = (mode: number, first: number, count: number) => {
    const target: unknown = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)
      ? gl.getFramebufferAttachmentParameter(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
        )
      : null;
    if (target instanceof WebGLTexture && mipmapped.has(target)) {
      watch.draws++;
      const active: number = gl.getParameter(gl.ACTIVE_TEXTURE);
      for (let unit = 0; unit < units; unit++) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        if (gl.getParameter(gl.TEXTURE_BINDING_2D) === target) watch.held.push(unit);
      }
      gl.activeTexture(active);
    }
    original.drawArrays.call(gl, mode, first, count);
  };
  return watch;
}

// No texture unit may hold the copy while the patch pass draws into it: for a
// sampler reading that unit, that is a feedback loop. Allocating the copy binds
// it, and a photo on the other version reallocates it.
describe("the patch pass", () => {
  it("draws into a copy no texture unit holds, as frames switch versions", () => {
    const watch = watchDrawsIntoCopy(glHarness().gl);
    try {
      withRenderer({ stages: [], pipeline: WIDE_PROBE }, (renderer) => {
        renderer.setImage(SPECKLED_SKY);
        for (const version of [V1, V2, V1, V2]) {
          renderer.setParams(healed(version));
          renderer.render();
        }
      });
      expect(watch.draws).toBe(4);
      expect(watch.held).toEqual([]);
    } finally {
      watch.restore();
    }
  });
});

describe("histogram readback", () => {
  it("bins a flat source into one bucket on the very first call", () => {
    withRenderer(undefined, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      renderer.render();
      // The readback targets are allocated on this first call, so this is where
      // a clobbered uImage binding shows: the frame reads back all-black and
      // every pixel lands in bin 0.
      const first = renderer.computeHistogram(true);
      const populated = [...first.luma].flatMap((count, bin) => (count > 0 ? [bin] : []));
      expect(populated).toHaveLength(1);
      expect(populated[0]).toBeGreaterThan(0);
      expect(first.extended?.clipLow).toBe(0);

      renderer.render();
      expect([...renderer.computeHistogram(true).luma]).toEqual([...first.luma]);
    });
  });
});

// The shipping defaults are not an identity render — they carry capture
// sharpening and colour NR — but both are no-ops on a flat field, so these stay
// assertions about the stock pipeline rather than about any one slider.
describe("the shipping defaults", () => {
  it("renders a flat source to a uniform, in-range frame", () => {
    const frame = withRenderer(undefined, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(DEFAULT_DEVELOP_PARAMS);
      return capture(renderer);
    });
    const [r] = pixelAt(frame, 8, 8);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(1);
    for (let i = 0; i < frame.data.length; i += 4) {
      expect(Math.abs(frame.data[i] - r)).toBeLessThan(PIXEL_TOLERANCE);
    }
  });

  it("responds monotonically to increasing scene luminance", () => {
    const rendered = [0.05, 0.2, 0.45, 0.7].map((value) =>
      withRenderer(undefined, (renderer) => {
        renderer.setImage(flatSource(16, value));
        renderer.setParams(DEFAULT_DEVELOP_PARAMS);
        return pixelAt(capture(renderer), 8, 8)[1];
      }),
    );
    for (let i = 1; i < rendered.length; i++) {
      expect(rendered[i]).toBeGreaterThan(rendered[i - 1]);
    }
  });
});

// A hard-edged dab over the left 45 % of a square source: fully covered at
// x = 4/32, untouched at x = 28/32. RIGHT is its mirror image.
const SIZE = 32;
const LEFT: BrushDab = { x: 0.2, y: 0.5, radius: 0.28, erase: false, feather: 0 };
const RIGHT: BrushDab = { ...LEFT, x: 0.8 };

/** An object that counts the properties read through it. */
function counted<T extends object>(target: T): { object: T; reads: () => number } {
  let reads = 0;
  const object = new Proxy(target, {
    get(from, key) {
      reads++;
      return Reflect.get(from, key);
    },
  });
  return { object, reads: () => reads };
}

describe("coverage-kind stage textures", () => {
  const LOCAL_GAIN: ProcessingStageContribution = {
    id: "acme.local",
    name: "Local gain",
    phase: "scene-linear",
    glsl: "lin *= 1.0 + gain * cov(srcUv);",
    uniforms: [{ key: "gain", glslType: "float", default: 0 }],
    textures: [{ key: "cov", kind: "coverage" }],
  };

  function localFrame(bag: Record<string, unknown>, masks: Mask[] = []): Frame {
    return withRenderer({ stages: [LOCAL_GAIN], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource(SIZE));
      renderer.setParams(identityParams({ masks }));
      renderer.setContributedParams(bag);
      return capture(renderer);
    });
  }

  it("confines the stage's effect to the painted dabs", () => {
    const frame = localFrame({ "acme.local.gain": 1, "acme.local.cov": [LEFT] });
    expect(pixelAt(frame, 4, 16)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
    expect(pixelAt(frame, 28, 16)[1]).toBeCloseTo(FLAT_GREY, 2);
  });

  it("reads an absent, empty or malformed value as unpainted", () => {
    const bags: Record<string, unknown>[] = [
      { "acme.local.gain": 1 },
      { "acme.local.gain": 1, "acme.local.cov": [] },
      { "acme.local.gain": 1, "acme.local.cov": [{ x: 0.2 }] },
    ];
    for (const bag of bags) {
      expect(pixelAt(localFrame(bag), 4, 16)[1]).toBeCloseTo(FLAT_GREY, 2);
    }
  });

  it("yields to the photo's own brushes when the atlas is full, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const brush = (id: string): MaskComponent => ({
        id,
        kind: "brush",
        mode: "add",
        invert: false,
        brush: {
          dabs: [{ x: 0.8, y: 0.8, radius: 0.05, erase: false, feather: 0.5 }],
          feather: 0.5,
        },
      });
      const mask: Mask = {
        id: "m1",
        name: "Brushes",
        visible: true,
        invert: false,
        opacity: 100,
        adj: defaultMaskAdjustments(),
        panels: [...DEFAULT_MASK_PANELS],
        components: ["a", "b", "c", "d"].map(brush),
      };
      const frame = localFrame({ "acme.local.gain": 1, "acme.local.cov": [LEFT] }, [mask]);
      expect(pixelAt(frame, 4, 16)[1]).toBeCloseTo(FLAT_GREY, 2);
      const ours = warn.mock.calls.filter((call) => String(call[0]).includes("acme.local.cov"));
      expect(ours).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("namespaces same-named coverage keys from two stages", () => {
    const other: ProcessingStageContribution = {
      ...LOCAL_GAIN,
      id: "other.local",
      glsl: "lin *= 1.0 - 0.5 * cov(srcUv);",
    };
    expect(rendererBuildError({ stages: [LOCAL_GAIN, other] })).toBeNull();
  });

  it("follows a texture whose dabs alone changed in the bag", () => {
    withRenderer({ stages: [LOCAL_GAIN], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource(SIZE));
      renderer.setParams(identityParams());
      renderer.setContributedParams({ "acme.local.gain": 1, "acme.local.cov": [LEFT] });
      const first = capture(renderer);
      expect(pixelAt(first, 4, 16)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
      expect(pixelAt(first, 28, 16)[1]).toBeCloseTo(FLAT_GREY, 2);

      renderer.setContributedParams({ "acme.local.gain": 1, "acme.local.cov": [RIGHT] });
      const moved = capture(renderer);
      expect(pixelAt(moved, 4, 16)[1]).toBeCloseTo(FLAT_GREY, 2);
      expect(pixelAt(moved, 28, 16)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
    });
  });

  it("reads no dab for a frame, or a replaced bag, that kept the same dab list", () => {
    const watched = counted(LEFT);
    const dabs = [watched.object];
    withRenderer({ stages: [LOCAL_GAIN], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource(SIZE));
      renderer.setParams(identityParams());
      renderer.setContributedParams({ "acme.local.gain": 1, "acme.local.cov": dabs });
      renderer.render();
      expect(watched.reads()).toBeGreaterThan(0);

      const baked = watched.reads();
      renderer.render();
      renderer.setContributedParams({ "acme.local.gain": 0.5, "acme.local.cov": dabs });
      renderer.render();
      expect(watched.reads()).toBe(baked);

      renderer.setContributedParams({
        "acme.local.gain": 0.5,
        "acme.local.cov": [watched.object],
      });
      renderer.render();
      expect(watched.reads()).toBeGreaterThan(baked);
    });
  });

  // Two stages can be handed one dab list. Swapping which of them is registered
  // changes no value the atlas was baked from, but it changes the key the
  // stage's coverage is read through.
  it("re-keys the atlas when a stage swap leaves the painted dabs as they were", () => {
    const other: ProcessingStageContribution = { ...LOCAL_GAIN, id: "other.local" };
    const dabs = [LEFT];
    withRenderer({ stages: [LOCAL_GAIN], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource(SIZE));
      renderer.setParams(identityParams());
      renderer.setContributedParams({
        "acme.local.gain": 1,
        "acme.local.cov": dabs,
        "other.local.gain": 1,
        "other.local.cov": dabs,
      });
      expect(pixelAt(capture(renderer), 4, 16)[1]).toBeCloseTo(FLAT_GREY * 2, 2);

      renderer.setStages([other]);
      expect(pixelAt(capture(renderer), 4, 16)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
    });
  });
});

// A renderer keeps its coverage atlases from frame to frame, so only a later
// frame shows a change the atlas missed.
describe("brush coverage across frames", () => {
  // Exposure +40 is one stop, so covered pixels read double.
  function brushMask(dabs: BrushDab[]): Mask {
    return {
      id: "m1",
      name: "Brush",
      visible: true,
      invert: false,
      opacity: 100,
      adj: { ...defaultMaskAdjustments(), exposure: 40 },
      panels: [...DEFAULT_MASK_PANELS],
      components: [
        { id: "c1", kind: "brush", mode: "add", invert: false, brush: { dabs, feather: 0 } },
      ],
    };
  }

  /** Clones the pixels `offsetX` to the right of every dab over it. */
  function brushSpot(dabs: BrushDab[], offsetX = -0.3): RetouchSpot {
    return {
      id: "r1",
      shape: "brush",
      mode: "clone",
      visible: true,
      dstX: 0.5,
      dstY: 0.5,
      srcX: 0.5 + offsetX,
      srcY: 0.5,
      radius: 0.2,
      feather: 0,
      opacity: 100,
      dabs,
    };
  }

  /** A horizontal ramp from 0.05 to 0.35, so a clone's source offset shows. */
  function rampSource(width: number): FloatImage {
    return floatImage(width, SIZE, (x) => {
      const v = 0.05 + 0.3 * ((x + 0.5) / width);
      return [v, v, v];
    });
  }

  /** Whether a pixel of the middle row differs from the same pixel of `plain`. */
  function touched(frame: Frame, plain: Frame, x: number): boolean {
    return Math.abs(pixelAt(frame, x, 16)[1] - pixelAt(plain, x, 16)[1]) > 0.02;
  }

  it("shows a dab the next params moved, and the same frame when nothing changed", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource(SIZE));
      renderer.setParams(identityParams({ masks: [brushMask([LEFT])] }));
      const first = capture(renderer);
      expect(pixelAt(first, 4, 16)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
      expect(pixelAt(first, 28, 16)[1]).toBeCloseTo(FLAT_GREY, 2);
      expect(worstDifference(capture(renderer), first)).toBeLessThan(1e-6);

      renderer.setParams(identityParams({ masks: [brushMask([RIGHT])] }));
      const moved = capture(renderer);
      expect(pixelAt(moved, 4, 16)[1]).toBeCloseTo(FLAT_GREY, 2);
      expect(pixelAt(moved, 28, 16)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
    });
  });

  it("shows a brush spot the next params repainted", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(rampSource(SIZE));
      renderer.setParams(identityParams());
      const plain = capture(renderer);

      renderer.setParams(identityParams({ retouch: [brushSpot([LEFT], 0.3)] }));
      const first = capture(renderer);
      expect([4, 28].map((x) => touched(first, plain, x))).toEqual([true, false]);

      renderer.setParams(identityParams({ retouch: [brushSpot([RIGHT])] }));
      const moved = capture(renderer);
      expect([4, 28].map((x) => touched(moved, plain, x))).toEqual([false, true]);
    });
  });

  // The atlas holds four spots. A hidden one that took a channel would leave
  // the fourth shown spot reading the hidden one's coverage.
  it("keeps a hidden brush spot out of the atlas, so the shown spots keep their channels", () => {
    const spotAt = (id: string, x: number, visible: boolean): RetouchSpot => ({
      ...brushSpot([{ ...LEFT, x, radius: 0.08 }], x < 0.5 ? 0.3 : -0.3),
      id,
      visible,
    });
    const spots = [
      spotAt("hidden", 0.1, false),
      ...[0.3, 0.5, 0.7, 0.9].map((x) => spotAt(`shown${x}`, x, true)),
    ];
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(rampSource(SIZE));
      renderer.setParams(identityParams());
      const plain = capture(renderer);
      renderer.setParams(identityParams({ retouch: spots }));
      const frame = capture(renderer);
      expect([3, 9, 15, 22, 29].map((x) => touched(frame, plain, x))).toEqual([
        false,
        true,
        true,
        true,
        true,
      ]);
    });
  });

  it("reads no mask dab for a frame or for params that kept the same masks", () => {
    const watched = counted(LEFT);
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource(SIZE));
      const masks = [brushMask([watched.object])];
      renderer.setParams(identityParams({ masks }));
      renderer.render();
      expect(watched.reads()).toBeGreaterThan(0);

      const baked = watched.reads();
      renderer.render();
      renderer.render();
      renderer.setParams(identityParams({ masks, exposure: 0.5 }));
      renderer.render();
      expect(watched.reads()).toBe(baked);

      renderer.setParams(identityParams({ masks: [brushMask([watched.object])] }));
      renderer.render();
      expect(watched.reads()).toBeGreaterThan(baked);
    });
  });

  it("reads no retouch dab for a frame or for params that kept the same spots", () => {
    const watched = counted(LEFT);
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource(SIZE));
      const retouch = [brushSpot([watched.object])];
      renderer.setParams(identityParams({ retouch }));
      renderer.render();
      expect(watched.reads()).toBeGreaterThan(0);

      const baked = watched.reads();
      renderer.render();
      renderer.render();
      renderer.setParams(identityParams({ retouch, exposure: 0.5 }));
      renderer.render();
      expect(watched.reads()).toBe(baked);

      renderer.setParams(identityParams({ retouch: [brushSpot([watched.object])] }));
      renderer.render();
      expect(watched.reads()).toBeGreaterThan(baked);
    });
  });

  // A bake that threw left its atlas as it was. Params that haven't changed since
  // must not read as baked, or the next frame draws the stale atlas without a word.
  describe("after a bake threw", () => {
    /** A dab that can't be read until it is healed, so baking it throws. */
    function unreadable(target: BrushDab): { dab: BrushDab; heal: () => void } {
      let broken = true;
      const dab = new Proxy(target, {
        get(from, key) {
          if (broken) throw new Error("dab unreadable");
          return Reflect.get(from, key);
        },
      });
      return {
        dab,
        heal: () => {
          broken = false;
        },
      };
    }

    const CASES: { name: string; paint: (dab: BrushDab) => DevelopParams }[] = [
      { name: "a brush mask", paint: (dab) => identityParams({ masks: [brushMask([dab])] }) },
      {
        name: "a brush spot",
        paint: (dab) => identityParams({ retouch: [brushSpot([dab], 0.3)] }),
      },
    ];

    for (const { name, paint } of CASES) {
      it(`bakes ${name} again for the params that threw`, () => {
        const { dab, heal } = unreadable(LEFT);
        const painted = paint(dab);
        withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
          renderer.setImage(rampSource(SIZE));
          renderer.setParams(identityParams());
          const plain = capture(renderer);

          expect(() => renderer.setParams(painted)).toThrow("dab unreadable");
          expect(() => renderer.render()).toThrow("dab unreadable");

          heal();
          const frame = capture(renderer);
          expect([4, 28].map((x) => touched(frame, plain, x))).toEqual([true, false]);
        });
      });
    }
  });

  // Each dab is baked at the source's aspect, and a photo's params are not
  // posted again when only its source changes. A dab of radius 0.2 reaches 0.2
  // either side of its centre on a square source and 0.1 on one twice as wide,
  // so a pixel 0.15 off centre is covered on the first and clear on the second.
  describe("when the source changes aspect without new params", () => {
    const SQUARE = rampSource(SIZE);
    const WIDE = rampSource(2 * SIZE);
    const DAB: BrushDab = { x: 0.5, y: 0.5, radius: 0.2, erase: false, feather: 0 };

    const CASES: { name: string; painted: DevelopParams }[] = [
      { name: "a brush mask", painted: identityParams({ masks: [brushMask([DAB])] }) },
      { name: "a brush spot", painted: identityParams({ retouch: [brushSpot([DAB])] }) },
    ];

    // Renderers share one GL context, so each frame is finished before the next
    // renderer is built.
    function frameOf(source: FloatImage, params: DevelopParams): Frame {
      return withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
        renderer.setImage(source);
        renderer.setParams(params);
        return capture(renderer);
      });
    }

    for (const { name, painted } of CASES) {
      it(`re-bakes ${name} for the new source`, () => {
        const plainWide = frameOf(WIDE, identityParams());
        const plainSquare = frameOf(SQUARE, identityParams());
        const reference = frameOf(WIDE, painted);
        expect([32, 41, 47].map((x) => touched(reference, plainWide, x))).toEqual([
          true,
          false,
          false,
        ]);

        withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
          renderer.setImage(SQUARE);
          renderer.setParams(painted);
          const square = capture(renderer);
          expect([16, 20, 25].map((x) => touched(square, plainSquare, x))).toEqual([
            true,
            true,
            false,
          ]);

          renderer.setImage(WIDE);
          expect(worstDifference(capture(renderer), reference)).toBeLessThan(1e-3);
        });
      });
    }
  });
});

describe("stage signature", () => {
  it("recompiles when a stage swaps its helpers but keeps its glsl", () => {
    const stage = (gain: string): ProcessingStageContribution => ({
      id: "acme.helper",
      name: "Helper",
      phase: "scene-linear",
      glsl: "lin = helperScale(lin);",
      helpers: `vec3 helperScale(vec3 c) { return c * ${gain}; }`,
      uniforms: [],
    });
    withRenderer({ stages: [stage("2.0")], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
      renderer.setStages([stage("3.0")]);
      expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(FLAT_GREY * 3, 2);
    });
  });
});

describe("stage injection memo", () => {
  it("builds once per stage source and process version", () => {
    // Every build reads `glsl`, so the read count stands in for the build count.
    let reads = 0;
    const stage: ProcessingStageContribution = {
      id: "acme.counted",
      name: "Counted",
      phase: "scene-linear",
      get glsl() {
        reads++;
        return "lin *= 1.0;";
      },
      uniforms: [],
    };
    withRenderer({ stages: [stage], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource());
      const version2 = identityParams({ processVersion: CURRENT_PROCESS_VERSION });
      // The first frame builds for version 2; the frames after it reuse that.
      renderer.setParams(version2);
      capture(renderer);
      const readsAtStart = reads;
      expect(readsAtStart).toBeGreaterThan(0);
      capture(renderer);
      expect(reads).toBe(readsAtStart);
      renderer.setParams(identityParams());
      capture(renderer);
      const readsWithBoth = reads;
      expect(readsWithBoth).toBeGreaterThan(readsAtStart);
      renderer.setParams(version2);
      capture(renderer);
      renderer.setParams(identityParams());
      capture(renderer);
      expect(reads).toBe(readsWithBoth);
      renderer.setStages([stage]);
      capture(renderer);
      expect(reads).toBeGreaterThan(readsWithBoth);
    });
  });

  it("rebuilds when setStages is handed the same array after it was edited in place", () => {
    const stage: ProcessingStageContribution = {
      id: "acme.edited",
      name: "Edited",
      phase: "scene-linear",
      glsl: "lin = editedScale(lin);",
      helpers: "vec3 editedScale(vec3 c) { return c * 2.0; }",
      uniforms: [],
    };
    const stages = [stage];
    withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setImage(flatSource());
      renderer.setParams(identityParams());
      expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(FLAT_GREY * 2, 2);
      stages[0] = { ...stage, helpers: "vec3 editedScale(vec3 c) { return c * 3.0; }" };
      renderer.setStages(stages);
      expect(pixelAt(capture(renderer), 8, 8)[1]).toBeCloseTo(FLAT_GREY * 3, 2);
    });
  });
});
