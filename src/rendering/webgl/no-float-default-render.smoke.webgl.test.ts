// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: the default render path on the hardware a VM or an old GPU gives — no
// float render targets, and a smaller texture limit than a photo. It still
// draws a picture, and runs on 8-bit targets.

import { afterAll, describe, expect, it, vi } from "vitest";
import { freshParams } from "@/catalog/types";
import { denoiseBag } from "./builtin-denoise";
import {
  builtinStages,
  drainGlErrors,
  floatImage,
  freshContext,
  glHarness,
  liveFrame,
  withRenderer,
  type FreshContext,
} from "./webgl.test-support";

const W = 64;
const H = 32;
const SCENE = floatImage(W, H, (x) => {
  const v = 0.02 + (x / (W - 1)) * 0.6;
  return [v, v * 0.92, v * 0.85];
});

let floatless: FreshContext | null = null;

afterAll(() => {
  floatless?.release();
  floatless = null;
});

function readCanvas(gl: WebGL2RenderingContext): Uint8Array {
  const raw = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  return raw;
}

const distinctValues = (px: Uint8Array): number => {
  const seen = new Set<number>();
  for (let i = 0; i < px.length; i += 4) seen.add(px[i] | (px[i + 1] << 8) | (px[i + 2] << 16));
  return seen.size;
};

describe("smoke: the default render path without float render targets", () => {
  it("draws a fresh photo, not black and not flat, and runs without float targets", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    floatless ??= freshContext({ noFloat: true });
    const { canvas, gl } = floatless;
    const params = freshParams();
    drainGlErrors(gl);
    try {
      const { px, float } = withRenderer(
        { stages: builtinStages() },
        (r) => {
          r.setImage(SCENE);
          r.setParams(params);
          r.setContributedParams(denoiseBag(params));
          r.render();
          r.render();
          return { px: readCanvas(gl), float: r.colorBufferFloat };
        },
        canvas,
      );

      expect(gl.getError()).toBe(gl.NO_ERROR);
      expect(float).toBe(false);
      expect(px.some((v, i) => i % 4 !== 3 && v > 0)).toBe(true);
      expect(distinctValues(px)).toBeGreaterThan(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("smoke: a photo wider than the GPU's texture limit", () => {
  it("is drawn downscaled, not black", () => {
    const { gl } = glHarness();
    const { getParameter } = gl;
    gl.getParameter = (pname: number): unknown =>
      pname === gl.MAX_TEXTURE_SIZE ? 4096 : getParameter.call(gl, pname);
    try {
      const params = freshParams();
      const { px, width } = withRenderer({ stages: builtinStages() }, (r) => {
        r.setImage(floatImage(5000, 100, (x) => [0.05 + (x / 4999) * 0.5, 0.2, 0.2]));
        r.setParams(params);
        r.setContributedParams(denoiseBag(params));
        liveFrame(r);
        drainGlErrors(gl);
        const shown = liveFrame(r);
        expect(gl.getError()).toBe(gl.NO_ERROR);
        expect(r.sourceWidth).toBeLessThanOrEqual(4096);
        return { px: shown, width: r.sourceWidth };
      });

      expect(width).toBeGreaterThan(0);
      const magenta = px.every((v, i) => v === [255, 0, 255, 255][i % 4]);
      expect(magenta).toBe(false);
      expect(px.some((v, i) => i % 4 !== 3 && v > 0 && !(px[i - (i % 4)] === 255 && px[i - (i % 4) + 2] === 255))).toBe(true);
      expect(distinctValues(px)).toBeGreaterThan(1);
    } finally {
      gl.getParameter = getParameter;
    }
  });
});
