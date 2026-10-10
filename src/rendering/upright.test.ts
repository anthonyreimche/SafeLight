// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Characterization of the Upright geometry (straighten + keystone from lines),
// fed hand-built lines so no image detection is involved. DetectedLine is not
// exported, so lines are plain { rho, theta, votes } literals.

import { describe, expect, it } from "vitest";
import type { GuidedLine } from "@/catalog/types";
import { computeGuidedCorrection, computeUprightCorrection } from "./upright";

// A keystone coefficient of 0.6 is perspective 100, so the slope 0.5 that two
// symmetric converging lines produce is 0.5 / 0.6 * 100.
const SLOPE_HALF_AS_PERSPECTIVE = 83.333;

const guided = (x1: number, y1: number, x2: number, y2: number): GuidedLine => ({
  x1,
  y1,
  x2,
  y2,
});

// The Hough form (normal angle theta, signed distance rho, in pixels) of the
// line through two pixel points. theta is kept in [0, π) as the detector does.
function houghLine(x1: number, y1: number, x2: number, y2: number, votes = 100) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  let nx = -(y2 - y1) / len;
  let ny = (x2 - x1) / len;
  if (ny < 0 || (ny === 0 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }
  return { rho: x1 * nx + y1 * ny, theta: Math.atan2(ny, nx), votes };
}

describe("computeGuidedCorrection", () => {
  it("returns zeros when there are no lines", () => {
    expect(computeGuidedCorrection([], 1.5)).toEqual({
      straighten: 0,
      perspectiveV: 0,
      perspectiveH: 0,
    });
  });

  it("straightens one tilted horizontal line by its angle and adds no perspective", () => {
    const r = computeGuidedCorrection([guided(0.1, 0.5, 0.9, 0.6)], 1);
    expect(r.straighten).toBeCloseTo(7.125, 3);
    expect(r.perspectiveV).toBe(0);
    expect(r.perspectiveH).toBe(0);
  });

  it("scales the tilt by the image aspect", () => {
    // dx = 0.8 * 2 = 1.6, dy = 0.1: atan(0.1 / 1.6) = 3.576 degrees.
    const r = computeGuidedCorrection([guided(0.1, 0.5, 0.9, 0.6)], 2);
    expect(r.straighten).toBeCloseTo(3.576, 3);
  });

  it("finds no keystone in parallel verticals", () => {
    const r = computeGuidedCorrection(
      [guided(0.2, 0.1, 0.2, 0.9), guided(0.8, 0.1, 0.8, 0.9)],
      1,
    );
    expect(r.perspectiveV).toBeCloseTo(0, 6);
    expect(r.straighten).toBeCloseTo(0, 6);
    expect(r.perspectiveH).toBe(0);
  });

  it("reads verticals converging at the top as a vertical keystone, not a roll", () => {
    const r = computeGuidedCorrection(
      [guided(0.2, 0.9, 0.3, 0.1), guided(0.8, 0.9, 0.7, 0.1)],
      1,
    );
    expect(r.straighten).toBeCloseTo(0, 6);
    expect(r.perspectiveV).toBeCloseTo(SLOPE_HALF_AS_PERSPECTIVE, 2);
    expect(r.perspectiveH).toBe(0);
  });

  it("gives the opposite keystone for verticals converging at the bottom", () => {
    const r = computeGuidedCorrection(
      [guided(0.3, 0.9, 0.2, 0.1), guided(0.7, 0.9, 0.8, 0.1)],
      1,
    );
    expect(r.perspectiveV).toBeCloseTo(-SLOPE_HALF_AS_PERSPECTIVE, 2);
  });
});

// 1000 x 1000 frame. The two verticals converge at the top (x 200 -> 300 and
// 800 -> 700) and the two horizontals converge on the right (y 200 -> 300 and
// 800 -> 700), each pair symmetric about the centre so the roll cancels.
const W = 1000;
const H = 1000;
const convergingVerticals = [
  houghLine(200, 900, 300, 100),
  houghLine(800, 900, 700, 100),
];
const convergingHorizontals = [
  houghLine(100, 200, 900, 300),
  houghLine(100, 800, 900, 700),
];
const bothFamilies = [...convergingVerticals, ...convergingHorizontals];

describe("computeUprightCorrection", () => {
  it("auto corrects roll and both keystones from lines of both families", () => {
    const r = computeUprightCorrection(bothFamilies, "auto", W, H);
    expect(r.straighten).toBeCloseTo(0, 3);
    expect(r.perspectiveV).toBeCloseTo(SLOPE_HALF_AS_PERSPECTIVE, 2);
    expect(r.perspectiveH).toBeCloseTo(-SLOPE_HALF_AS_PERSPECTIVE, 2);
  });

  it("level uses horizontals only and never sets a perspective", () => {
    const r = computeUprightCorrection(bothFamilies, "level", W, H);
    expect(r.perspectiveV).toBe(0);
    expect(r.perspectiveH).toBe(0);
    expect(r.straighten).toBeCloseTo(0, 3);
  });

  it("level straightens a tilted horizon by its angle", () => {
    const r = computeUprightCorrection([houghLine(100, 500, 900, 600)], "level", W, H);
    expect(r.straighten).toBeCloseTo(7.125, 2);
  });

  it("vertical corrects the vertical keystone but never the horizontal one", () => {
    const r = computeUprightCorrection(bothFamilies, "vertical", W, H);
    expect(r.perspectiveV).toBeCloseTo(SLOPE_HALF_AS_PERSPECTIVE, 2);
    expect(r.perspectiveH).toBe(0);
    expect(r.straighten).toBeCloseTo(0, 3);
  });

  it("off returns zeros whatever lines it is given", () => {
    expect(computeUprightCorrection(bothFamilies, "off", W, H)).toEqual({
      straighten: 0,
      perspectiveV: 0,
      perspectiveH: 0,
    });
  });

  it("guided returns zeros here, since it takes its lines from the user and not the detector", () => {
    expect(computeUprightCorrection(bothFamilies, "guided", W, H)).toEqual({
      straighten: 0,
      perspectiveV: 0,
      perspectiveH: 0,
    });
  });

  it("ignores lines that run along the image border", () => {
    // Two near-vertical lines hugging the left and right edges, a sub-degree
    // apart: kept, they would fabricate a keystone; the frame itself must not.
    const border = [houghLine(5, 0, 6, 1000), houghLine(995, 0, 994, 1000)];
    const dropped = computeUprightCorrection(border, "vertical", W, H);
    expect(dropped).toEqual({ straighten: 0, perspectiveV: 0, perspectiveH: 0 });

    const inset = [houghLine(205, 0, 206, 1000), houghLine(795, 0, 794, 1000)];
    const kept = computeUprightCorrection(inset, "vertical", W, H);
    expect(kept.perspectiveV).toBeCloseTo(-0.566, 2);
  });
});
