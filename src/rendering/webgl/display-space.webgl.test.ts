// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A version 3 photo's screen frames encode for the display, Display P3 on a
// wide-gamut screen, and the canvas is tagged to match. Version 1 and 2 frames,
// export frames and monitor-profile frames stay what they were, and only a
// frame drawn to the canvas retags it: retagging clears the buffer.

import { afterEach, describe, expect, it } from "vitest";
import { mat3Invert } from "../transform";
import { OUT_SPACE_CODE, outMatrix, type ColorSpaceId, type DisplaySpace } from "../color-space";
import { outputPixel } from "../output-map";
import { apply3, encodePerceptual, type Vec3 } from "../stage-space";
import type { WebGLRenderer } from "./renderer";
import {
  OPEN_PROBE, adobeDisplay, each, expectColour, floatImage, glHarness, identityParams, pixelAt, toHalf, withRenderer,
  worstDifference, type Frame,
} from "./webgl.test-support";

// Display P3's green as working Rec.709, outside sRGB. slOutput reads the
// source as perceptual values, so the scene holds it encoded.
const P3_GREEN = each(apply3(mat3Invert(outMatrix("display-p3")), [0, 1, 0]), encodePerceptual);
const SCENE = floatImage(4, 4, () => P3_GREEN);
// The scene as the twin encodes it for `space`.
const twin = (space: ColorSpaceId): Vec3 => outputPixel(each(P3_GREEN, toHalf), outMatrix(space), OUT_SPACE_CODE[space]);

function onScene(processVersion: number, fn: (r: WebGLRenderer) => void): void {
  withRenderer({ stages: [], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
    r.setImage(SCENE);
    r.setParams(identityParams({ processVersion }));
    fn(r);
  });
}

function show(r: WebGLRenderer, display: DisplaySpace): Frame {
  r.setDisplaySpace(display);
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

// A captured frame leaves the canvas's tag alone; one drawn to the canvas sets it.
function tagAfterFrame(r: WebGLRenderer): PredefinedColorSpace {
  r.render();
  return glHarness().gl.drawingBufferColorSpace;
}

describe("the display space", () => {
  // The context outlives each renderer, and the next test's starts sRGB.
  afterEach(() => {
    glHarness().gl.drawingBufferColorSpace = "srgb";
  });

  // A gamut check can't tell the targets apart: sRGB's mapped green, read as
  // P3, also lies outside sRGB. So the frame is held to the twin's P3 encoding.
  it("encodes a version 3 frame for a Display P3 screen", () => {
    onScene(3, (r) => {
      const p3 = show(r, "display-p3");
      expectColour(pixelAt(p3, 2, 2), twin("display-p3"), "Display P3");
      const srgb = show(r, "srgb");
      expectColour(pixelAt(srgb, 2, 2), twin("srgb"), "sRGB");
      expect(worstDifference(p3, srgb)).toBeGreaterThan(0.1);
    });
  });

  it("leaves a version 2 frame in sRGB", () => {
    onScene(2, (r) => {
      const p3 = show(r, "display-p3");
      expect(tagAfterFrame(r)).toBe("srgb");
      expect(worstDifference(p3, show(r, "srgb"))).toBe(0);
    });
  });

  it("gives way to an export space", () => {
    onScene(3, (r) => {
      r.setOutputColorSpace("adobe-rgb");
      const p3 = show(r, "display-p3");
      expectColour(pixelAt(p3, 2, 2), twin("adobe-rgb"), "Adobe RGB");
      expect(worstDifference(p3, show(r, "srgb"))).toBe(0);
    });
  });

  // The profile's conversion wins over the display's in the uniforms, so only
  // the tag shows a frame that took both.
  it("gives way to a monitor profile", () => {
    onScene(3, (r) => {
      const plain = show(r, "srgb");
      r.setMonitorTransform(adobeDisplay());
      const p3 = show(r, "display-p3");
      expect(tagAfterFrame(r)).toBe("srgb");
      expect(worstDifference(p3, show(r, "srgb"))).toBe(0);
      expect(worstDifference(p3, plain)).toBeGreaterThan(0.02);
    });
  });

  // An export frame keeps the sRGB tag whatever it encodes: export reads the
  // canvas through toBlob and drawImage, which convert out of the tag.
  it("tags the canvas with a frame drawn to it", () => {
    onScene(3, (r) => {
      r.setDisplaySpace("display-p3");
      r.captureFloatFrame();
      expect(glHarness().gl.drawingBufferColorSpace, "after a captured frame").toBe("srgb");
      expect(tagAfterFrame(r), "after a version 3 frame").toBe("display-p3");

      r.setParams(identityParams({ processVersion: 2 }));
      expect(tagAfterFrame(r), "after a version 2 frame").toBe("srgb");

      r.setParams(identityParams({ processVersion: 3 }));
      expect(tagAfterFrame(r)).toBe("display-p3");
      r.setOutputColorSpace("display-p3");
      expect(tagAfterFrame(r), "after a Display P3 export frame").toBe("srgb");
    });
  });
});
