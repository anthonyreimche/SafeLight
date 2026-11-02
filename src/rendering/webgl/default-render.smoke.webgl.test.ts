// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: one photo through the pipeline a fresh photo opens with — the shipped
// stages, the stock display transform, a new photo's params and the colour NR
// its defaults turn on — draws a picture: no build error, every pixel opaque
// and drawn, not black, not blown out, and darker where the scene is darker.

import { describe, expect, it } from "vitest";
import { freshParams } from "@/catalog/types";
import { denoiseBag } from "./builtin-denoise";
import {
  builtinStages,
  glHarness,
  liveFrame,
  floatImage,
  rendererBuildError,
  withRenderer,
} from "./webgl.test-support";

const W = 64;
const H = 32;
// A warm ramp from deep shadow to a bright midtone, as a RAW decode hands it over.
const SCENE = floatImage(W, H, (x) => {
  const v = 0.02 + (x / (W - 1)) * 0.6;
  return [v, v * 0.92, v * 0.85];
});

const luma = (px: Uint8Array, x: number, y: number): number => {
  const o = (y * W + x) * 4;
  return 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
};

describe("smoke: the default render path", () => {
  it("builds every program a fresh photo needs", () => {
    expect(rendererBuildError({ stages: builtinStages() })).toBeNull();
  });

  it("draws a fresh photo non-black, unclipped and in order", () => {
    const params = freshParams();
    const { px, width, height, float } = withRenderer({ stages: builtinStages() }, (r) => {
      r.setImage(SCENE);
      r.setParams(params);
      r.setContributedParams(denoiseBag(params));
      liveFrame(r);
      const shown = liveFrame(r);
      const { gl } = glHarness();
      return {
        px: shown,
        width: gl.drawingBufferWidth,
        height: gl.drawingBufferHeight,
        float: r.captureFloatFrame(),
      };
    });

    expect([width, height]).toEqual([W, H]);
    let magenta = 0;
    let opaque = 0;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === 255 && px[i + 1] === 0 && px[i + 2] === 255) magenta++;
      if (px[i + 3] === 255) opaque++;
      sum += px[i] + px[i + 1] + px[i + 2];
    }
    expect(magenta).toBe(0);
    expect(opaque).toBe(W * H);
    const mean = sum / (W * H * 3);
    expect(mean).toBeGreaterThan(40);
    expect(mean).toBeLessThan(230);

    const row = H >> 1;
    const shadow = luma(px, 2, row);
    const mid = luma(px, W >> 1, row);
    const bright = luma(px, W - 3, row);
    expect(shadow).toBeGreaterThan(0);
    expect(shadow).toBeLessThan(mid);
    expect(mid).toBeLessThan(bright);
    expect(bright).toBeLessThan(255);

    if (float) {
      expect(float.data.every(Number.isFinite)).toBe(true);
    }
  });
});
