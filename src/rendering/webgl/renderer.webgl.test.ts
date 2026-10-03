// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renderer lifecycle and end-to-end pixel behaviour. The directional pixel
// assertions run through LINEAR_PROBE_PIPELINE, a display transform that hands
// the scene-linear working colour straight to the framebuffer: the full develop
// path still executes, but the read-back value is the linear one the tone chain
// produced, so "+1 EV doubles it" can be asserted without inverting a curve.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEVELOP_PARAMS,
  DEFAULT_MASK_PANELS,
  DEFAULT_TRANSFORM,
  defaultMaskAdjustments,
  type BrushDab,
  type Mask,
  type MaskAdjustments,
  type MaskComponent,
  type RetouchSpot,
} from "@/catalog/types";
import { withPipeline, type ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";
import { encodeHalf } from "@/raw/half-float";
import { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  PIXEL_TOLERANCE,
  type FloatImage,
  type Frame,
  type GlObjectCounts,
  builtinStages,
  drainGlErrors,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  rendererBuildError,
  trackGlObjects,
  withRenderer,
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
  it("builds its program and targets without raising a GL error", () => {
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

  it("leaks nothing when a contributed stage fails to compile", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      expect(
        () =>
          new WebGLRenderer(canvas, {
            stages: [
              {
                id: "acme.broken",
                name: "Broken",
                phase: "effects",
                glsl: "c = neverDeclared(c);",
                uniforms: [],
              },
            ],
          }),
      ).toThrow();
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
      let worst = 0;
      for (let i = 0; i < fresh.data.length; i++) {
        worst = Math.max(worst, Math.abs(reopened.data[i] - fresh.data[i]));
      }
      expect(worst).toBeLessThan(1e-6);
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

type MipmapCall = "probe" | "refused" | "built";

interface MipmapFault {
  /** Each generateMipmap call: the 2x2 probe, a refused full-size RGBA16
   *  texture, or any other texture, mipmapped as normal. */
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
          let worst = 0;
          for (let i = 0; i < frame.data.length; i++) {
            const diff = Math.abs(frame.data[i] - reference.data[i]);
            worst = Math.max(worst, diff);
          }
          expect(worst).toBeLessThan(1e-6);
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

describe("coverage-kind stage textures", () => {
  const LOCAL_GAIN: ProcessingStageContribution = {
    id: "acme.local",
    name: "Local gain",
    phase: "scene-linear",
    glsl: "lin *= 1.0 + gain * cov(srcUv);",
    uniforms: [{ key: "gain", glslType: "float", default: 0 }],
    textures: [{ key: "cov", kind: "coverage" }],
  };
  // A hard-edged dab over the left 45 % of a square source: fully covered at
  // x = 4/32, untouched at x = 28/32.
  const LEFT: BrushDab = { x: 0.2, y: 0.5, radius: 0.28, erase: false, feather: 0 };
  const SIZE = 32;

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
});
