// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop decodes the open photo's neighbours into the GPU source cache ahead of time,
// without binding them. The renderer then binds back the source it held before, but
// only one it held under a key, so Develop hands over every source a load settles on
// under one: a fallback under a key no open binds (fallbackKey in use-develop-renderer).

import { describe, expect, it } from "vitest";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  withRenderer,
} from "./webgl.test-support";

const BLACK = floatImage(4, 4, () => [0, 0, 0]);
const WHITE = floatImage(4, 4, () => [1, 1, 1]);
const OPTS = { stages: [], pipeline: LINEAR_PROBE_PIPELINE };

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

      renderer.uploadSource("b:0", WHITE, undefined, false, false, false);
      renderer.render();
      expect(brightest()).toBeLessThanOrEqual(1);
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
