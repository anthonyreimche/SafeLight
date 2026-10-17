// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import {
  clampView,
  easeOutCubic,
  interpolateView,
  placeBuffer,
  viewWindow,
  type View,
} from "./viewport-view";

// A 1600×1200 image in an 800×600 frame: fit is a scale of 0.5 at (0, 0).
const IMAGE = { w: 1600, h: 1200 };
const FRAME = { w: 800, h: 600 };
const FIT: View = { scale: 0.5, x: 0, y: 0 };
// 100% anchored at the frame centre: the image point (800, 600) stays at (400, 300).
const FULL: View = { scale: 1, x: -400, y: -300 };

const under = (v: View, at: { x: number; y: number }) => ({
  x: (at.x - v.x) / v.scale,
  y: (at.y - v.y) / v.scale,
});

describe("placeBuffer", () => {
  it("puts a whole-image buffer at the image rect", () => {
    expect(placeBuffer(null, FULL, IMAGE)).toEqual({ x: -400, y: -300, w: 1600, h: 1200 });
  });

  it("puts a window buffer at its window of the image rect", () => {
    const view = { scale: 2, x: -100, y: -50 };
    expect(placeBuffer({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, view, IMAGE)).toEqual({
      x: 700,
      y: 1150,
      w: 1600,
      h: 600,
    });
  });

  it("fills the frame with the window the view shows", () => {
    const view = { scale: 1.25, x: -300, y: -200 };
    const placed = placeBuffer(viewWindow(view, FRAME, IMAGE), view, IMAGE);
    expect(placed.x).toBeCloseTo(0, 9);
    expect(placed.y).toBeCloseTo(0, 9);
    expect(placed.w).toBeCloseTo(800, 9);
    expect(placed.h).toBeCloseTo(600, 9);
  });
});

describe("viewWindow", () => {
  it("is the region the view shows, normalized", () => {
    expect(viewWindow(FULL, FRAME, IMAGE)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });

  it("is the whole image at fit", () => {
    expect(viewWindow(FIT, FRAME, IMAGE)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("clampView", () => {
  it("keeps a zoomed image covering the frame", () => {
    expect(clampView({ scale: 1, x: 50, y: -900 }, FRAME, IMAGE)).toEqual({ scale: 1, x: 0, y: -600 });
  });

  it("centres an image smaller than the frame", () => {
    expect(clampView({ scale: 0.25, x: 9, y: 9 }, FRAME, IMAGE)).toEqual({ scale: 0.25, x: 200, y: 150 });
  });
});

describe("interpolateView", () => {
  it("starts and ends exactly on the two views", () => {
    expect(interpolateView(FIT, FULL, 0)).toBe(FIT);
    expect(interpolateView(FIT, FULL, 1)).toBe(FULL);
  });

  it("keeps the anchor's image point under it all the way", () => {
    for (const e of [0.25, 0.5, 0.75]) {
      const p = under(interpolateView(FIT, FULL, e), { x: 400, y: 300 });
      expect(p.x).toBeCloseTo(800, 9);
      expect(p.y).toBeCloseTo(600, 9);
    }
  });

  it("moves the scale geometrically", () => {
    expect(interpolateView(FIT, FULL, 0.5).scale).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it("moves a pure pan in a line", () => {
    const to = { scale: 1, x: -200, y: -100 };
    expect(interpolateView(FULL, to, 0.5)).toEqual({ scale: 1, x: -300, y: -200 });
  });
});

describe("easeOutCubic", () => {
  it("runs from 0 to 1, fast at first", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBe(0.875);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});
