// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// readRegion on the real renderer: a patch of the frame at the frame's own
// pixels, whatever window the view is zoomed to, equal pixel for pixel to the
// whole frame's, and drawn without disturbing the live frame.

import { describe, expect, it } from "vitest";
import { encodeCachedPreview } from "@/raw/cache-encode";
import { lumaHalves } from "@/raw/frame-job";
import { cutDetailGain } from "@/raw/native-frame";
import { denoiseBag } from "./builtin-denoise";
import type { WebGLRenderer } from "./renderer";
import { builtinStages, cropStages, floatImage, identityParams, pixelAt, withRenderer, type Frame } from "./webgl.test-support";

// Every pixel its own colour: red across, green down.
const SCENE = floatImage(64, 32, (x, y) => [(x + 0.5) / 64, (y + 0.5) / 32, 0.3]);

function onScene<T>(fn: (r: WebGLRenderer) => T, maxEdge?: number): T {
  return withRenderer(undefined, (r) => {
    r.setImage(SCENE, maxEdge);
    r.setParams(identityParams({ processVersion: 2 }));
    r.render();
    return fn(r);
  });
}

function whole(r: WebGLRenderer): Frame {
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

/** The largest difference, in 8-bit codes, between the patch and the frame's
 *  pixels under it. */
function worstAgainst(frame: Frame, patch: NonNullable<ReturnType<WebGLRenderer["readRegion"]>>): number {
  let worst = 0;
  const { rect, data } = patch;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const want = pixelAt(frame, rect.x + x, rect.y + y);
      const o = (y * rect.width + x) * 4;
      for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(data[o + ch] - want[ch] * 255));
    }
  }
  return worst;
}

describe("readRegion", () => {
  it("reads the frame's own pixels under the patch", () => {
    onScene((r) => {
      const frame = whole(r);
      const patch = r.readRegion({ x: 0.5, y: 0.5, width: 8, height: 6 });
      expect(patch?.rect).toEqual({ x: 28, y: 13, width: 8, height: 6 });
      expect(patch).toMatchObject({ frameWidth: 64, frameHeight: 32 });
      expect(worstAgainst(frame, patch!)).toBeLessThanOrEqual(1);
    });
  });

  it("keeps the part inside the frame at its edge", () => {
    onScene((r) => {
      const frame = whole(r);
      const patch = r.readRegion({ x: 1, y: 0, width: 10, height: 10 });
      expect(patch?.rect).toEqual({ x: 59, y: 0, width: 5, height: 5 });
      expect(worstAgainst(frame, patch!)).toBeLessThanOrEqual(1);
    });
  });

  it("reads at the frame's pixels while the view is zoomed to a window", () => {
    onScene((r) => {
      const frame = whole(r);
      r.setViewport({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, 64, 32);
      r.render();
      const patch = r.readRegion({ x: 0.25, y: 0.25, width: 12, height: 8 });
      expect(patch?.rect).toEqual({ x: 10, y: 4, width: 12, height: 8 });
      expect(worstAgainst(frame, patch!)).toBeLessThanOrEqual(1);
    });
  });

  it("leaves the live frame as it was", () => {
    onScene((r) => {
      r.setViewport({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 32, 16);
      r.render();
      const before = whole(r);
      r.readRegion({ x: 0.1, y: 0.9, width: 16, height: 16 });
      const after = whole(r);
      expect([after.width, after.height]).toEqual([before.width, before.height]);
      expect([...after.data]).toEqual([...before.data]);
    });
  });

  it("counts the frame in the view's pixels, at most the render resolution, as Develop's zoom does", () => {
    onScene((r) => {
      const frame = whole(r);
      expect([frame.width, frame.height]).toEqual([32, 16]);
      const patch = r.readRegion({ x: 0.5, y: 0.5, width: 8, height: 6 });
      expect(patch).toMatchObject({ rect: { x: 12, y: 5, width: 8, height: 6 }, frameWidth: 32, frameHeight: 16 });
      expect(worstAgainst(frame, patch!)).toBeLessThanOrEqual(1);
    }, 32);
  });

  it("reads the cropped frame's pixels", () => {
    withRenderer({ stages: cropStages() }, (r) => {
      r.setImage(SCENE);
      r.setParams(identityParams({ processVersion: 2, crop: { x: 0.25, y: 0, width: 0.5, height: 0.5 } }));
      r.render();
      const frame = whole(r);
      expect([frame.width, frame.height]).toEqual([32, 16]);
      const patch = r.readRegion({ x: 0.5, y: 0.5, width: 8, height: 6 });
      expect(patch).toMatchObject({ rect: { x: 12, y: 5, width: 8, height: 6 }, frameWidth: 32, frameHeight: 16 });
      expect(worstAgainst(frame, patch!)).toBeLessThanOrEqual(1);
    });
  });

  it("leaves a live frame drawn denser by a detail gain at its size, and its histogram as it was", () => {
    // A 256×192 native frame held as a 128×96 base, zoomed 1:1 to native on a 64×48 window.
    const native = floatImage(256, 192, (x, y) => {
      const v = (0.12 + 0.5 * (x / 256)) * ((x + y) % 2 === 0 ? 1.25 : 0.75);
      return [v, v, v];
    });
    const preview = encodeCachedPreview(native.data, 256, 192, 128);
    const params = identityParams({ processVersion: 2 });
    withRenderer({ stages: builtinStages(2) }, (r) => {
      r.keepNativeFrame = true;
      r.uploadSource("photo:0", { kind: "float16", data: preview.data, width: preview.width, height: preview.height, fullWidth: 256, fullHeight: 192 });
      r.setParams(params);
      r.setContributedParams(denoiseBag(params));
      r.setViewport({ x: 0.25, y: 0.375, w: 0.25, h: 0.25 }, 64, 48);
      const luma = { data: lumaHalves(native.data), width: 256, height: 192 };
      expect(r.setNativeFrame("photo:0", luma)).toBe(true);
      r.render();
      const want = r.requestDetail();
      if (!want) throw new Error("no detail request");
      expect(r.setDetailGain(want.request, cutDetailGain(luma, want.rect, want.outW, want.outH, want.baseW, want.baseH))).toBe(true);
      r.render();
      expect([r.bufferWidth, r.bufferHeight]).toEqual([64, 48]);
      const histogram = r.computeHistogram(true);
      expect(r.readRegion({ x: 0.4, y: 0.5, width: 16, height: 16 })).not.toBeNull();
      expect([r.bufferWidth, r.bufferHeight]).toEqual([64, 48]);
      const after = r.computeHistogram(true);
      expect([...after.luma]).toEqual([...histogram.luma]);
    });
  });

  it("is null for a patch outside the frame", () => {
    onScene((r) => {
      expect(r.readRegion({ x: 2, y: 0.5, width: 8, height: 8 })).toBeNull();
    });
  });
});
