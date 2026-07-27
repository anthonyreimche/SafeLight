// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Renderer lifecycle and end-to-end pixel behaviour. The directional pixel
// assertions run through LINEAR_PROBE_PIPELINE, a display transform that hands
// the scene-linear working colour straight to the framebuffer: the full develop
// path still executes, but the read-back value is the linear one the tone chain
// produced, so "+1 EV doubles it" can be asserted without inverting a curve.

import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, DEFAULT_TRANSFORM } from "@/catalog/types";
import { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  PIXEL_TOLERANCE,
  type Frame,
  type GlObjectCounts,
  builtinStages,
  drainGlErrors,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
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
