// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the crop geometry: aspect fitting, the "does this rectangle still
// sit on image pixels" test, and the drag constraints that keep a handle riding
// a rotated or keystoned image edge. Run with `npm test`.

import { describe, it, expect } from "vitest";
import {
  computeCropForAspect,
  constrainCropToImage,
  cropFitsImage,
  fitCropToImage,
  fitLockedCrop,
  maxCropForTransform,
  sourceUV,
  transformedToSource,
  transformedViewCrop,
  type LensDistort,
} from "./crop-transform";
import { buildForwardTransform, buildInverseTransform, type Mat3 } from "./transform";
import { DEFAULT_TRANSFORM } from "@/catalog/types";
import type { CropRect } from "@/catalog/types";

// An untransformed image: the crop frame and the source UV space coincide.
const ID: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const FULL: CropRect = { x: 0, y: 0, width: 1, height: 1 };

// Barrel distortion (poly3 with b < 0) pushes mid-edge pixels outside the
// source frame while leaving the corners exactly where they were.
const BARREL: LensDistort = {
  model: 1,
  a: 0,
  b: -0.1,
  c: 0,
  manual: 0,
  autoCropScale: 1,
  aspect: 1,
};

function ratioOf(c: CropRect, imageAspect: number): number {
  return (c.width / c.height) * imageAspect;
}

// How far the worst crop corner reaches outside the source frame, in UV units.
// Zero means the crop is riding the image edge exactly.
function worstOverhang(c: CropRect, inv: Mat3): number {
  const corners = [
    { x: c.x, y: c.y },
    { x: c.x + c.width, y: c.y },
    { x: c.x, y: c.y + c.height },
    { x: c.x + c.width, y: c.y + c.height },
  ];
  const slack = corners
    .map((p) => transformedToSource(p, inv))
    .flatMap((u) => [-u.x, u.x - 1, -u.y, u.y - 1]);
  return Math.max(...slack);
}

describe("transformedToSource / sourceUV", () => {
  it("reads straight through an untransformed frame", () => {
    expect(transformedToSource({ x: 0.3, y: 0.7 }, ID)).toEqual({ x: 0.3, y: 0.7 });
  });

  it("sourceUV walks the crop's own 0..1 box through the same inverse", () => {
    const crop: CropRect = { x: 0.2, y: 0.1, width: 0.5, height: 0.4 };
    const inv = buildInverseTransform(6, { ...DEFAULT_TRANSFORM, scale: 120 }, 1.5);
    for (const o of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.35, y: 0.8 },
    ]) {
      const expected = transformedToSource(
        { x: crop.x + o.x * crop.width, y: crop.y + o.y * crop.height },
        inv,
      );
      expect(sourceUV(o, crop, inv)).toEqual(expected);
    }
  });
});

describe("computeCropForAspect", () => {
  it("hits the requested pixel ratio and stays centred inside the frame", () => {
    const cases: [number, number][] = [
      [1, 1.5],
      [16 / 9, 1.5],
      [1.5, 1.5],
      [2 / 3, 1.5],
      [4 / 3, 2 / 3],
    ];
    for (const [target, imageAspect] of cases) {
      const c = computeCropForAspect(target, imageAspect);
      expect(ratioOf(c, imageAspect)).toBeCloseTo(target, 12);
      expect(c.x).toBeCloseTo((1 - c.width) / 2, 12);
      expect(c.y).toBeCloseTo((1 - c.height) / 2, 12);
      expect(c.width).toBeLessThanOrEqual(1);
      expect(c.height).toBeLessThanOrEqual(1);
      // Largest fit: one axis always spans the whole image.
      expect(Math.max(c.width, c.height)).toBe(1);
    }
  });

  it("leaves a matching ratio untouched", () => {
    expect(computeCropForAspect(1.5, 1.5)).toEqual(FULL);
  });

  it("letterboxes a square crop in a 3:2 frame", () => {
    const c = computeCropForAspect(1, 1.5);
    expect(c.width).toBeCloseTo(2 / 3, 12);
    expect(c.height).toBe(1);
    expect(c.x).toBeCloseTo(1 / 6, 12);
  });
});

describe("transformedViewCrop", () => {
  it("pads the untransformed frame outward from its centre", () => {
    const c = transformedViewCrop(ID);
    expect(c.width).toBeCloseTo(1.06, 12);
    expect(c.height).toBeCloseTo(1.06, 12);
    expect(c.x).toBeCloseTo(-0.03, 12);
    expect(c.y).toBeCloseTo(-0.03, 12);
    expect(transformedViewCrop(ID, 1)).toEqual(FULL);
  });

  it("encloses the rotated image", () => {
    // A unit square turned 45° needs a √2-wide box, still centred on 0.5.
    const c = transformedViewCrop(buildForwardTransform(45, DEFAULT_TRANSFORM, 1), 1);
    expect(c.width).toBeCloseTo(Math.SQRT2, 12);
    expect(c.height).toBeCloseTo(Math.SQRT2, 12);
    expect(c.x + c.width / 2).toBeCloseTo(0.5, 12);
    expect(c.y + c.height / 2).toBeCloseTo(0.5, 12);
  });
});

describe("cropFitsImage", () => {
  it("accepts the full frame and its boundary, rejects any overhang", () => {
    expect(cropFitsImage(FULL, ID)).toBe(true);
    expect(cropFitsImage({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, ID)).toBe(true);
    expect(cropFitsImage({ x: -0.001, y: 0, width: 1, height: 1 }, ID)).toBe(false);
    expect(cropFitsImage({ x: 0, y: 0, width: 1.001, height: 1 }, ID)).toBe(false);
  });

  it("rejects a full-frame crop once the image is rotated", () => {
    const inv = buildInverseTransform(10, DEFAULT_TRANSFORM, 1);
    expect(cropFitsImage(FULL, inv)).toBe(false);
    expect(cropFitsImage({ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, inv)).toBe(true);
  });

  it("samples along the edges so a curved boundary cannot slip through", () => {
    // Barrel distortion leaves the corners fixed, so a corner-only test would
    // wrongly accept the full frame; the edge midpoints are what bulge out.
    expect(cropFitsImage(FULL, ID, null)).toBe(true);
    expect(cropFitsImage(FULL, ID, BARREL)).toBe(false);
    expect(cropFitsImage({ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, ID, BARREL)).toBe(true);
  });
});

describe("fitCropToImage", () => {
  it("returns a fitting crop untouched", () => {
    const crop: CropRect = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    expect(fitCropToImage(crop, ID)).toBe(crop);
  });

  it("shrinks about the centre until it fits", () => {
    const c = fitCropToImage({ x: -0.2, y: -0.2, width: 1.4, height: 1.4 }, ID);
    expect(cropFitsImage(c, ID)).toBe(true);
    expect(c.width).toBeCloseTo(1, 6);
    expect(c.x).toBeCloseTo(0, 6);
    expect(c.x + c.width / 2).toBeCloseTo(0.5, 12);
  });

  it("keeps the centre and the shape while shrinking into a rotated image", () => {
    const inv = buildInverseTransform(15, DEFAULT_TRANSFORM, 1.5);
    const c = fitCropToImage({ x: 0.05, y: 0.1, width: 0.9, height: 0.8 }, inv);
    expect(cropFitsImage(c, inv)).toBe(true);
    expect(c.width / c.height).toBeCloseTo(0.9 / 0.8, 12);
    expect(c.x + c.width / 2).toBeCloseTo(0.5, 12);
    expect(c.y + c.height / 2).toBeCloseTo(0.5, 12);
    expect(c.width).toBeLessThan(0.9);
  });
});

describe("fitLockedCrop", () => {
  it("shrinks about the anchor corner, holding the ratio", () => {
    const target: CropRect = { x: 0, y: 0, width: 1.5, height: 1 };
    const c = fitLockedCrop(target, 0, 0, ID);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
    expect(c.width / c.height).toBeCloseTo(1.5, 12);
    expect(c.width).toBeCloseTo(1, 6);
    expect(cropFitsImage(c, ID)).toBe(true);
  });

  it("anchors the opposite corner when the drag came from the north-west", () => {
    const target: CropRect = { x: -0.4, y: -0.4, width: 1.2, height: 1.2 };
    const c = fitLockedCrop(target, 0.8, 0.8, ID);
    expect(c.x + c.width).toBeCloseTo(0.8, 12);
    expect(c.y + c.height).toBeCloseTo(0.8, 12);
    expect(c.width / c.height).toBeCloseTo(1, 12);
    expect(cropFitsImage(c, ID)).toBe(true);
  });
});

describe("maxCropForTransform", () => {
  it("is the whole frame when nothing constrains it", () => {
    expect(maxCropForTransform(ID, 0, 1.5)).toEqual(FULL);
  });

  it("keeps the requested ratio, centred", () => {
    const c = maxCropForTransform(ID, 1, 1.5);
    expect(ratioOf(c, 1.5)).toBeCloseTo(1, 12);
    expect(c.x).toBeCloseTo(1 / 6, 12);
  });

  it("finds the largest square inside a rotated square image", () => {
    // Classic result: a unit square turned by θ admits a concentric axis-aligned
    // square of side 1/(cos θ + sin θ).
    const theta = (20 * Math.PI) / 180;
    const inv = buildInverseTransform(20, DEFAULT_TRANSFORM, 1);
    const c = maxCropForTransform(inv, 0, 1);
    expect(c.width).toBeCloseTo(1 / (Math.cos(theta) + Math.sin(theta)), 6);
    expect(cropFitsImage(c, inv)).toBe(true);
  });

  it("respects a locked ratio inside a keystoned image", () => {
    const t = { ...DEFAULT_TRANSFORM, perspectiveV: 40 };
    const inv = buildInverseTransform(0, t, 1.5);
    const c = maxCropForTransform(inv, 16 / 9, 1.5);
    expect(cropFitsImage(c, inv)).toBe(true);
    expect(ratioOf(c, 1.5)).toBeCloseTo(16 / 9, 12);
    expect(c.width).toBeLessThan(1);
  });
});

describe("constrainCropToImage", () => {
  const fwd = ID;
  const start: CropRect = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };

  it("passes a valid target straight through", () => {
    const target: CropRect = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
    expect(constrainCropToImage(start, target, "move", ID, fwd, 1.5, false)).toBe(target);
  });

  it("slides a move against the image edge, keeping its size", () => {
    const target: CropRect = { x: 0.7, y: 0.1, width: 0.5, height: 0.5 };
    const c = constrainCropToImage(start, target, "move", ID, fwd, 1.5, false);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0.1, 12);
    expect(c.width).toBe(0.5);
    expect(c.height).toBe(0.5);
  });

  it("projects a diagonal move onto the nearest valid corner", () => {
    const target: CropRect = { x: 0.9, y: -0.3, width: 0.5, height: 0.5 };
    const c = constrainCropToImage(start, target, "move", ID, fwd, 1.5, false);
    expect(c.x).toBeCloseTo(0.5, 12);
    expect(c.y).toBeCloseTo(0, 12);
    expect(cropFitsImage(c, ID)).toBe(true);
  });

  it("parks a move against the edge of a rotated image", () => {
    const inv = buildInverseTransform(12, DEFAULT_TRANSFORM, 1);
    const forward = buildForwardTransform(12, DEFAULT_TRANSFORM, 1);
    const from: CropRect = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 };
    const to: CropRect = { x: 0.85, y: 0.35, width: 0.3, height: 0.3 };
    const c = constrainCropToImage(from, to, "move", inv, forward, 1, false);
    expect(c.width).toBe(0.3);
    expect(c.height).toBe(0.3);
    expect(c.x).toBeGreaterThan(from.x);
    expect(c.x).toBeLessThan(to.x);
    // The half-plane projection is exact, so a corner lands on the boundary
    // itself: the result must still pass the test that rejected the target.
    expect(worstOverhang(c, inv)).toBeCloseTo(0, 9);
    expect(cropFitsImage(c, inv)).toBe(true);
  });

  it("returns a parked move that survives re-validation unshrunk", () => {
    // A stored crop is re-fitted on load, so a result the fit test rejects would
    // shrink the crop a little on every round trip.
    const inv = buildInverseTransform(12, DEFAULT_TRANSFORM, 1);
    const forward = buildForwardTransform(12, DEFAULT_TRANSFORM, 1);
    const from: CropRect = { x: 0.35, y: 0.35, width: 0.3, height: 0.3 };
    const to: CropRect = { x: 0.85, y: 0.35, width: 0.3, height: 0.3 };
    const c = constrainCropToImage(from, to, "move", inv, forward, 1, false);
    expect(fitCropToImage(c, inv)).toBe(c);
  });

  it("walks a move toward the cursor when lens distortion curves the boundary", () => {
    const from: CropRect = { x: 0.3, y: 0.3, width: 0.2, height: 0.2 };
    const to: CropRect = { x: 0.85, y: 0.3, width: 0.2, height: 0.2 };
    const c = constrainCropToImage(from, to, "move", ID, fwd, 1, false, BARREL);
    expect(cropFitsImage(c, ID, BARREL)).toBe(true);
    expect(c.x).toBeGreaterThan(from.x);
    expect(c.x).toBeLessThan(to.x);
    expect(c.y).toBeCloseTo(0.3, 12);
  });

  it("stops a free edge drag at the image border", () => {
    const target: CropRect = { x: 0.1, y: 0.1, width: 1.2, height: 0.5 };
    const c = constrainCropToImage(start, target, "e", ID, fwd, 1.5, false);
    expect(c.x).toBe(0.1);
    expect(c.x + c.width).toBeCloseTo(1, 5);
    expect(c.height).toBe(0.5);
  });

  it("never lets a free drag collapse the crop below the minimum edge", () => {
    // Dragging the west handle past the east one (and off the image): it must
    // stop MIN_CROP short of the fixed right edge.
    const target: CropRect = { x: 1.1, y: 0.1, width: -0.5, height: 0.5 };
    const c = constrainCropToImage(start, target, "w", ID, fwd, 1.5, false);
    expect(c.width).toBeCloseTo(0.04, 5);
    expect(c.x + c.width).toBeCloseTo(0.6, 12);
  });

  it("shrinks a ratio-locked corner drag about the opposite corner", () => {
    const from: CropRect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
    const target: CropRect = { x: 0.2, y: 0.2, width: 1, height: 1 };
    const c = constrainCropToImage(from, target, "se", ID, fwd, 1, true);
    expect(c.x).toBe(0.2);
    expect(c.y).toBe(0.2);
    expect(c.width).toBeCloseTo(0.8, 6);
    expect(c.width / c.height).toBeCloseTo(1, 12);
    expect(cropFitsImage(c, ID)).toBe(true);
  });

  it("centres the perpendicular axis for a ratio-locked edge drag", () => {
    // The east handle anchors the west edge's midpoint, so the box shrinks
    // symmetrically about y while the left edge stays put.
    const from: CropRect = { x: 0.2, y: 0.2, width: 0.4, height: 0.2 };
    const target: CropRect = { x: 0.2, y: 0.05, width: 1.1, height: 0.55 };
    const c = constrainCropToImage(from, target, "e", ID, fwd, 1, true);
    expect(c.x).toBe(0.2);
    expect(c.y + c.height / 2).toBeCloseTo(0.325, 12);
    expect(c.width / c.height).toBeCloseTo(2, 12);
    expect(cropFitsImage(c, ID)).toBe(true);
  });
});
