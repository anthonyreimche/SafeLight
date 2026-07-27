// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Geometry tests for the crop composition overlays.

import { describe, it, expect } from "vitest";
import {
  CROP_GUIDES,
  guideShapes,
  nextGuide,
  type CropGuide,
  type GuideShapes,
} from "./crop-guides.ts";

type Line = GuideShapes["lines"][number];
type Point = { x: number; y: number };

// A 16:10 box, so an aspect-blind implementation would show up immediately.
const W = 1600;
const H = 1000;

const PHI = (1 + Math.sqrt(5)) / 2;

const verticals = (s: GuideShapes): Line[] => s.lines.filter((l) => l.x1 === l.x2);
const horizontals = (s: GuideShapes): Line[] => s.lines.filter((l) => l.y1 === l.y2);

// The spiral is emitted as "M x y L x y …" with coordinates rounded to 2dp.
function pathPoints(d: string): Point[] {
  return d
    .split(/(?=[ML] )/)
    .map((seg) => seg.trim().split(/\s+/))
    .map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
}

describe("nextGuide", () => {
  it("advances in CROP_GUIDES order and wraps at the end", () => {
    expect(nextGuide("thirds")).toBe("golden");
    expect(nextGuide(CROP_GUIDES[CROP_GUIDES.length - 1].id)).toBe(CROP_GUIDES[0].id);
  });

  it("visits every guide exactly once per full cycle", () => {
    const seen = new Set<CropGuide>();
    let g: CropGuide = CROP_GUIDES[0].id;
    for (let i = 0; i < CROP_GUIDES.length; i++) {
      seen.add(g);
      g = nextGuide(g);
    }
    expect(seen.size).toBe(CROP_GUIDES.length);
    expect(g).toBe(CROP_GUIDES[0].id);
  });
});

describe("guideShapes: thirds", () => {
  it("splits both axes at 1/3 and 2/3", () => {
    const s = guideShapes("thirds", W, H);
    expect(s.lines).toHaveLength(4);

    const vs = verticals(s);
    expect(vs).toHaveLength(2);
    expect(vs[0].x1).toBeCloseTo(W / 3, 6);
    expect(vs[1].x1).toBeCloseTo((2 * W) / 3, 6);

    const hs = horizontals(s);
    expect(hs[0].y1).toBeCloseTo(H / 3, 6);
    expect(hs[1].y1).toBeCloseTo((2 * H) / 3, 6);
  });

  it("spans each line across the full box", () => {
    const s = guideShapes("thirds", W, H);
    for (const l of verticals(s)) {
      expect(l.y1).toBe(0);
      expect(l.y2).toBe(H);
    }
    for (const l of horizontals(s)) {
      expect(l.x1).toBe(0);
      expect(l.x2).toBe(W);
    }
  });
});

describe("guideShapes: golden", () => {
  it("places the phi lines symmetrically about the centre", () => {
    const s = guideShapes("golden", W, H);
    expect(s.lines).toHaveLength(4);
    const [v1, v2] = verticals(s).map((l) => l.x1 / W);
    expect(v1).toBeCloseTo(0.2763932, 6);
    expect(v2).toBeCloseTo(1 - v1, 6);

    const [h1, h2] = horizontals(s).map((l) => l.y1 / H);
    expect(h1).toBeCloseTo(v1, 6);
    expect(h2).toBeCloseTo(1 - v1, 6);
  });

  it("makes the middle band phi times the outer bands", () => {
    const [v1, v2] = verticals(guideShapes("golden", W, H)).map((l) => l.x1);
    expect((v2 - v1) / v1).toBeCloseTo(PHI, 6);
    expect((v2 - v1) / (W - v2)).toBeCloseTo(PHI, 6);
  });
});

describe("guideShapes: grid", () => {
  it("draws the seven interior lines of an 8×8 grid on each axis", () => {
    const s = guideShapes("grid", W, H);
    expect(s.lines).toHaveLength(14);

    const vs = verticals(s);
    const hs = horizontals(s);
    expect(vs).toHaveLength(7);
    expect(hs).toHaveLength(7);
    vs.forEach((l, i) => expect(l.x1).toBeCloseTo(((i + 1) * W) / 8, 6));
    hs.forEach((l, i) => expect(l.y1).toBeCloseTo(((i + 1) * H) / 8, 6));
  });

  it("leaves the box border undrawn", () => {
    const s = guideShapes("grid", W, H);
    for (const l of verticals(s)) {
      expect(l.x1).toBeGreaterThan(0);
      expect(l.x1).toBeLessThan(W);
    }
    for (const l of horizontals(s)) {
      expect(l.y1).toBeGreaterThan(0);
      expect(l.y1).toBeLessThan(H);
    }
  });
});

describe("guideShapes: diagonal", () => {
  it("starts a line at each corner", () => {
    const s = guideShapes("diagonal", W, H);
    expect(s.lines).toHaveLength(4);
    expect(s.lines.map((l) => [l.x1, l.y1])).toEqual([
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ]);
  });

  it("keeps the legs at 45° by clamping them to the short edge", () => {
    const boxes: [number, number][] = [
      [W, H],
      [H, W],
    ];
    for (const [w, h] of boxes) {
      for (const l of guideShapes("diagonal", w, h).lines) {
        expect(Math.abs(l.x2 - l.x1)).toBeCloseTo(Math.min(w, h), 6);
        expect(Math.abs(l.y2 - l.y1)).toBeCloseTo(Math.min(w, h), 6);
      }
    }
  });
});

describe("guideShapes: triangle", () => {
  it("drops perpendiculars from the off-corners onto the main diagonal", () => {
    const s = guideShapes("triangle", W, H);
    expect(s.lines).toHaveLength(3);
    const [diag, fromTopRight, fromBottomLeft] = s.lines;
    expect(diag).toEqual({ x1: 0, y1: 0, x2: W, y2: H });
    expect([fromTopRight.x1, fromTopRight.y1]).toEqual([W, 0]);
    expect([fromBottomLeft.x1, fromBottomLeft.y1]).toEqual([0, H]);

    for (const l of [fromTopRight, fromBottomLeft]) {
      // The far end sits on y = (H/W)·x …
      expect(l.y2).toBeCloseTo((H / W) * l.x2, 6);
      // … and the segment meets the diagonal at a right angle. The dot product
      // is normalized by |diagonal|² so the tolerance stays scale-free.
      const dot = ((l.x2 - l.x1) * W + (l.y2 - l.y1) * H) / (W * W + H * H);
      expect(dot).toBeCloseTo(0, 8);
    }
  });
});

describe("guideShapes: spiral", () => {
  it("reuses the golden grid as its reference lines", () => {
    expect(guideShapes("spiral", W, H).lines).toEqual(guideShapes("golden", W, H).lines);
  });

  it("winds inward onto the golden eye", () => {
    const s = guideShapes("spiral", W, H);
    expect(s.paths).toHaveLength(1);

    const pts = pathPoints(s.paths[0]);
    expect(pts).toHaveLength(121);
    expect(s.paths[0].startsWith("M ")).toBe(true);

    const eye = { x: W / PHI, y: H - H / PHI };
    const radii = pts.map((p) => Math.hypot(p.x - eye.x, p.y - eye.y));
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeLessThan(radii[i - 1]);
    }
    // 4.5 quarter turns at phi per turn shrinks the radius by phi^4.5 ≈ 8.7.
    expect(radii[radii.length - 1]).toBeLessThan(radii[0] / 8);
  });

  it("starts outside the box so the curve fills it (the viewport clips)", () => {
    const [first] = pathPoints(guideShapes("spiral", W, H).paths[0]);
    expect(first.x > W || first.y < 0).toBe(true);
  });
});

describe("guideShapes: shared invariants", () => {
  it("returns a path only for the spiral", () => {
    for (const { id } of CROP_GUIDES) {
      expect(guideShapes(id, W, H).paths).toHaveLength(id === "spiral" ? 1 : 0);
    }
  });

  it("keeps every line inside the box, in box-local coordinates", () => {
    // The overlay positions the crop box itself, so the origin is always (0,0).
    for (const { id } of CROP_GUIDES) {
      for (const l of guideShapes(id, W, H).lines) {
        for (const x of [l.x1, l.x2]) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(W);
        }
        for (const y of [l.y1, l.y2]) {
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(H);
        }
      }
    }
  });

  it("scales the fractional guides with the box aspect", () => {
    for (const id of ["thirds", "golden", "grid"] as const) {
      const square = guideShapes(id, 400, 400);
      const wide = guideShapes(id, W, H);
      square.lines.forEach((a, i) => {
        const b = wide.lines[i];
        expect(b.x1 / W).toBeCloseTo(a.x1 / 400, 6);
        expect(b.x2 / W).toBeCloseTo(a.x2 / 400, 6);
        expect(b.y1 / H).toBeCloseTo(a.y1 / 400, 6);
        expect(b.y2 / H).toBeCloseTo(a.y2 / 400, 6);
      });
    }
  });
});
