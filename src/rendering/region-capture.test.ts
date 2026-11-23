// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The pure halves of api.develop.captureRegion: where a patch sits in the
// frame, and its float read-back as 8-bit rows from the top.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REGION_EDGE, regionCapture, regionPatch, regionRgba8 } from "./region-capture";

describe("regionPatch", () => {
  it("centres the patch on the point, on whole frame pixels", () => {
    expect(regionPatch({ x: 0.5, y: 0.5, width: 10, height: 6 }, 100, 50)).toEqual({ x: 45, y: 22, width: 10, height: 6 });
    expect(regionPatch({ x: 0.333, y: 0.5, width: 9, height: 9 }, 100, 50)).toEqual({ x: 29, y: 21, width: 9, height: 9 });
  });

  it("keeps only the part inside the frame at an edge", () => {
    expect(regionPatch({ x: 0, y: 0, width: 10, height: 10 }, 100, 50)).toEqual({ x: 0, y: 0, width: 5, height: 5 });
    expect(regionPatch({ x: 1, y: 1, width: 10, height: 10 }, 100, 50)).toEqual({ x: 95, y: 45, width: 5, height: 5 });
  });

  it("is null for a patch wholly outside the frame", () => {
    expect(regionPatch({ x: -0.5, y: 0.5, width: 10, height: 10 }, 100, 50)).toBeNull();
    expect(regionPatch({ x: 0.5, y: 2, width: 10, height: 10 }, 100, 50)).toBeNull();
  });

  it("rounds the size and holds it between 1 and the largest edge", () => {
    expect(regionPatch({ x: 0.5, y: 0.5, width: 0.2, height: 3.6 }, 100, 50)).toEqual({ x: 50, y: 23, width: 1, height: 4 });
    const big = regionPatch({ x: 0.5, y: 0.5, width: 5000, height: 5000 }, 8000, 8000);
    expect(big).toEqual({ x: 4000 - MAX_REGION_EDGE / 2, y: 4000 - MAX_REGION_EDGE / 2, width: MAX_REGION_EDGE, height: MAX_REGION_EDGE });
  });

  it("is null for a request that isn't finite or a frame with no pixels", () => {
    expect(regionPatch({ x: Number.NaN, y: 0.5, width: 10, height: 10 }, 100, 50)).toBeNull();
    expect(regionPatch({ x: 0.5, y: 0.5, width: Infinity, height: 10 }, 100, 50)).toBeNull();
    expect(regionPatch({ x: 0.5, y: 0.5, width: 10, height: 10 }, 0, 50)).toBeNull();
  });
});

describe("regionRgba8", () => {
  it("turns bottom-up floats into 8-bit rows from the top, clamped to [0, 1]", () => {
    // 1×2, bottom row first: the bottom pixel is past white and below black.
    const raw = new Float32Array([1.5, -0.2, 0.5, 1, 0.2, 0.4, 0.6, 1]);
    expect([...regionRgba8(raw, 1, 2)]).toEqual([51, 102, 153, 255, 255, 0, 128, 255]);
  });

  it("writes opaque alpha whatever the frame held", () => {
    expect([...regionRgba8(new Float32Array([0, 0, 0, 0]), 1, 1)]).toEqual([0, 0, 0, 255]);
  });
});

describe("regionCapture", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands the patch over as a bitmap in the canvas's colour space, with where it sits", async () => {
    const images: { width: number; height: number; colorSpace?: PredefinedColorSpace }[] = [];
    class FakeImageData {
      constructor(_data: Uint8ClampedArray, width: number, height: number, settings?: ImageDataSettings) {
        images.push({ width, height, colorSpace: settings?.colorSpace });
      }
    }
    const bitmap = { width: 3, height: 2 } as ImageBitmap;
    vi.stubGlobal("ImageData", FakeImageData);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    const rect = { x: 10, y: 4, width: 3, height: 2 };
    const capture = await regionCapture({
      data: new Uint8ClampedArray(24), rect, frameWidth: 64, frameHeight: 32, colorSpace: "display-p3",
    });
    expect(capture).toEqual({ bitmap, rect, frameWidth: 64, frameHeight: 32, colorSpace: "display-p3" });
    expect(images).toEqual([{ width: 3, height: 2, colorSpace: "display-p3" }]);
  });
});
