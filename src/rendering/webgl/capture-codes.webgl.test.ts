// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// captureCodes16 is captureFloatFrame quantised, read back in bands instead of
// as one float frame of the whole image: the codes must be the same.

import { describe, expect, it, vi } from "vitest";
import { quantise16 } from "./export-draw";
import {
  OPEN_PROBE, cropStages, differing, floatImage, glHarness, identityParams, withRenderer,
} from "./webgl.test-support";

const W = 160;
const H = 200;

function withFrame<T>(fn: (r: import("./renderer").WebGLRenderer) => T): T {
  return withRenderer({ stages: cropStages(), pipeline: OPEN_PROBE }, (r) => {
    r.setImage(floatImage(W, H, (x, y) => [x / W, y / H, ((x * 7 + y * 3) % 50) / 50]));
    r.setParams(
      identityParams({
        crop: { x: 0.1, y: 0.1, width: 0.6, height: 0.8 },
        straighten: 3,
        transform: {
          perspectiveV: 0, perspectiveH: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0,
          flipH: true, flipV: true,
        },
      }),
    );
    return fn(r);
  });
}

describe("captureCodes16", () => {
  it("equals captureFloatFrame quantised, on a cropped, straightened, flipped frame", () => {
    withFrame((r) => {
      const frame = r.captureFloatFrame();
      const codes = r.captureCodes16();
      if (!frame || !codes) throw new Error("capture returned null");
      expect([codes.width, codes.height]).toEqual([frame.width, frame.height]);
      expect(codes.height).toBeGreaterThan(64);
      expect(codes.width).not.toBe(codes.height);
      expect(differing(codes.data, Uint16Array.from(frame.data, quantise16))).toBe(0);
    });
  });

  it("reads back in bands of at most 64 rows", () => {
    const { gl } = glHarness();
    withFrame((r) => {
      const reads = vi.spyOn(gl, "readPixels");
      const codes = r.captureCodes16();
      const heights = reads.mock.calls.map((c) => c[3] as number);
      reads.mockRestore();
      expect(codes).not.toBeNull();
      expect(heights.length).toBeGreaterThan(1);
      expect(Math.max(...heights)).toBeLessThanOrEqual(64);
    });
  });
});
