// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The histogram, and Auto Tone and Auto White Balance that read it, describe
// the whole picture however far the view is zoomed in. A zoomed view renders
// only its visible window, and the histogram redraws with what that render
// left bound, so it has to widen the window for its own draws and put it back.

import { describe, expect, it } from "vitest";
import type { HistogramData } from "../histogram";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  withRenderer,
} from "./webgl.test-support";

/** Black on the left half, white on the right: a window over the left half
 *  holds none of the white. */
const HALVES = floatImage(8, 4, (x) => (x < 4 ? [0, 0, 0] : [1, 1, 1]));
const LEFT_HALF = { x: 0, y: 0, w: 0.5, h: 1 };
const WINDOW_EDGE = 4;

function withHalves(fn: (renderer: WebGLRenderer) => void): void {
  withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    renderer.setImage(HALVES);
    renderer.setParams(identityParams());
    fn(renderer);
  });
}

function wholeThenZoomed(
  renderer: WebGLRenderer,
): { whole: HistogramData; zoomed: HistogramData } {
  renderer.setViewport(null);
  renderer.render();
  const whole = renderer.computeHistogram(true);
  renderer.setViewport(LEFT_HALF, WINDOW_EDGE, WINDOW_EDGE);
  renderer.render();
  const zoomed = renderer.computeHistogram(true);
  return { whole, zoomed };
}

function extendedLuma(histogram: HistogramData): number[] {
  if (!histogram.extended) throw new Error("no extended histogram");
  return [...histogram.extended.luma];
}

describe("the histogram of a zoomed view", () => {
  it("measures the whole picture, not the visible window", () => {
    withHalves((renderer) => {
      const { whole, zoomed } = wholeThenZoomed(renderer);

      // Both halves show in the whole-picture histogram, so a match below can't
      // be two black frames agreeing.
      const total = whole.luma.reduce((sum, count) => sum + count, 0);
      const bright = whole.luma.slice(128).reduce((sum, count) => sum + count, 0);
      expect(whole.luma[0]).toBeGreaterThan(total * 0.4);
      expect(bright).toBeGreaterThan(total * 0.4);

      expect([...zoomed.luma]).toEqual([...whole.luma]);
      expect(extendedLuma(zoomed)).toEqual(extendedLuma(whole));
    });
  });

  it("leaves the next render on the visible window", () => {
    withHalves((renderer) => {
      wholeThenZoomed(renderer);
      const { canvas, gl } = glHarness();

      // render() sets the window again on every frame, so only the program's
      // own uniform shows whether the histogram put it back.
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      if (!(program instanceof WebGLProgram)) throw new Error("no program bound");
      const viewport = gl.getUniformLocation(program, "uViewport");
      if (!viewport) throw new Error("the develop program has no uViewport");
      expect(gl.getUniform(program, viewport)).toEqual(
        new Float32Array([LEFT_HALF.x, LEFT_HALF.y, LEFT_HALF.w, LEFT_HALF.h]),
      );

      renderer.render();
      expect([canvas.width, canvas.height]).toEqual([WINDOW_EDGE, WINDOW_EDGE]);
      const pixels = new Uint8Array(WINDOW_EDGE * WINDOW_EDGE * 4);
      gl.readPixels(0, 0, WINDOW_EDGE, WINDOW_EDGE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const brightest = Math.max(...pixels.filter((_, i) => i % 4 !== 3));
      expect(brightest).toBeLessThanOrEqual(1);
    });
  });
});
