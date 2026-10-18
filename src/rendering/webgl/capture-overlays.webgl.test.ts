// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A measuring capture renders with `viewOverlays: false`: the clipping warning,
// the mask tint and the sharpening preview are view aids, and an extension that
// measures the frame (a gain map, a colour picker) must get the plain image. The
// next live render shows them again.

import { describe, expect, it } from "vitest";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  withRenderer,
} from "./webgl.test-support";

const BLACK = floatImage(4, 4, () => [0, 0, 0]);
const OPTS = { stages: [], pipeline: LINEAR_PROBE_PIPELINE };
const SHADOW_CLIPPING = 1;

/** The blue channel of the frame on the canvas, brightest pixel, 0..255. */
function brightestBlue(): number {
  const { canvas, gl } = glHarness();
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return Math.max(...pixels.filter((_, i) => i % 4 === 2));
}

describe("view overlays in a render", () => {
  it("paints black with the shadow clipping warning in a live render", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.uploadSource("black:0", BLACK);
      renderer.setShowClipping(SHADOW_CLIPPING);
      renderer.render();
      expect(brightestBlue()).toBeGreaterThan(200);
    });
  });

  it("leaves the warning out of a measuring render and brings it back after", () => {
    withRenderer(OPTS, (renderer) => {
      renderer.setParams(identityParams());
      renderer.uploadSource("black:0", BLACK);
      renderer.setShowClipping(SHADOW_CLIPPING);
      renderer.render({ viewOverlays: false });
      expect(brightestBlue()).toBeLessThanOrEqual(1);
      renderer.render();
      expect(brightestBlue()).toBeGreaterThan(200);
    });
  });
});
