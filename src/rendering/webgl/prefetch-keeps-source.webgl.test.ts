// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop decodes the open photo's neighbours into the GPU source cache ahead of time,
// without binding them, often while the open photo is being edited. The open photo's
// source, keyed or not, its prepass results and the canvas are left as they were.

import { describe, expect, it } from "vitest";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  changedState,
  floatImage,
  glHarness,
  glState,
  identityParams,
  markerStage,
  takingStages,
  withRenderer,
} from "./webgl.test-support";

const BLACK = floatImage(4, 4, () => [0, 0, 0]);
const WHITE = floatImage(4, 4, () => [1, 1, 1]);
// Another size than the open photo's, so a prefetch that sized the canvas shows.
const WIDE_WHITE = floatImage(12, 3, () => [1, 1, 1]);
const OPTS = { stages: [], pipeline: LINEAR_PROBE_PIPELINE };
const MARKER = markerStage(0, 0.25);

/** How often the canvas's width or height is set while `fn` runs: each set
 *  reallocates its backbuffer, whatever the value. */
function canvasResizes(fn: () => void): number {
  const { canvas } = glHarness();
  let sets = 0;
  for (const side of ["width", "height"] as const) {
    const own = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, side);
    Object.defineProperty(canvas, side, {
      configurable: true,
      get: (): unknown => own?.get?.call(canvas),
      set: (value: number) => {
        sets++;
        own?.set?.call(canvas, value);
      },
    });
  }
  try {
    fn();
  } finally {
    Reflect.deleteProperty(canvas, "width");
    Reflect.deleteProperty(canvas, "height");
  }
  return sets;
}

const sourceEpoch = (renderer: WebGLRenderer): unknown => Reflect.get(renderer, "sourceEpoch");

/** The brightest channel of the frame on the canvas, 0..255. */
function brightest(): number {
  const { canvas, gl } = glHarness();
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return Math.max(...pixels.filter((_, i) => i % 4 !== 3));
}

describe("a neighbour decoded ahead", () => {
  it("leaves the open photo's fallback, held under a key of its own, on screen", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.uploadSource("a:0#fallback", BLACK);
      renderer.render();
      expect(brightest()).toBeLessThanOrEqual(1);

      renderer.uploadSource("b:0", WHITE, undefined, false, false);
      renderer.render();
      expect(brightest()).toBeLessThanOrEqual(1);
    });
  });

  // A preview tier is handed over with setImage, under no key.
  it("leaves an open photo held under no key on screen", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.setImage(BLACK);
      renderer.render();
      expect(brightest()).toBeLessThanOrEqual(1);

      renderer.uploadSource("b:0", WHITE, undefined, false, false);
      renderer.render();
      expect(brightest()).toBeLessThanOrEqual(1);

      expect(renderer.bindSource("b:0")).toBe(true);
      renderer.render();
      expect(brightest()).toBeGreaterThan(100);
    });
  });

  // So a dark frame above can't be a frame that shows nothing.
  it("draws white from the neighbour once it is the source bound", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.uploadSource("b:0", WHITE);
      renderer.render();
      expect(brightest()).toBeGreaterThan(100);
    });
  });
});

describe("a neighbour decoded ahead of an edit in progress", () => {
  it.each([
    ["under a key", (r: WebGLRenderer) => r.uploadSource("a:0", BLACK)],
    ["under no key", (r: WebGLRenderer) => r.setImage(BLACK)],
  ])("reruns none of the prepasses of an open photo held %s", (_label, open) => {
    withRenderer({ stages: [MARKER], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setParams(identityParams());
      renderer.setContributedParams(takingStages([MARKER]));
      open(renderer);
      renderer.render();
      const before = renderer.renderDrawCounts;
      expect(before.pass).toBeGreaterThan(0);
      const epoch = sourceEpoch(renderer);

      renderer.uploadSource("b:0", WIDE_WHITE, undefined, false, false);
      expect(sourceEpoch(renderer)).toBe(epoch);
      renderer.render();
      expect(renderer.renderDrawCounts).toEqual(before);
    });
  });

  it("leaves the canvas and the texture units the next draw inherits as they were", () => {
    withRenderer(OPTS, (renderer) => {
      const { gl } = glHarness();
      renderer.setParams(identityParams());
      renderer.uploadSource("a:0", BLACK);
      renderer.render();
      const state = glState(gl);

      const resizes = canvasResizes(() => renderer.uploadSource("b:0", WIDE_WHITE, undefined, false, false));
      expect(resizes).toBe(0);
      expect(changedState(state, glState(gl))).toEqual([]);
      expect(renderer.hasSource("b:0")).toBe(true);
    });
  });
});
