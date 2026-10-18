// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import type { BrushDab, RetouchSpot } from "@/catalog/types";
import {
  pickLevel,
  rasterizeRegion,
  regionAnchor,
  regionBandWidth,
  regionEscape,
  runsMeet,
  spotRegion,
} from "./heal-region";
import type { HealRegion, RegionRaster, RowRuns } from "./heal-region";

const dab = (x: number, y: number, radius: number, feather = 0.5, erase = false): BrushDab => ({
  x,
  y,
  radius,
  feather,
  erase,
});

function raster(region: HealRegion, w: number, h: number): RegionRaster {
  const r = rasterizeRegion(region, w, h);
  if (!r) throw new Error("rasterizeRegion gave nothing");
  return r;
}

function pairs(a: Int32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
  return out;
}

const spot = (over: Partial<RetouchSpot>): RetouchSpot => ({
  id: "s",
  shape: "circle",
  mode: "heal",
  visible: true,
  dstX: 0.4,
  dstY: 0.6,
  srcX: 0.2,
  srcY: 0.6,
  radius: 0.05,
  feather: 50,
  opacity: 100,
  ...over,
});

describe("spotRegion", () => {
  it("reads a circle spot's centre, radius and feather", () => {
    expect(spotRegion(spot({}))).toEqual({ kind: "circle", x: 0.4, y: 0.6, radius: 0.05, feather: 0.5 });
  });

  it("reads a brush spot's dabs", () => {
    const dabs = [dab(0.1, 0.2, 0.03)];
    expect(spotRegion(spot({ shape: "brush", dabs }))).toEqual({ kind: "brush", dabs });
  });

  it("treats a brush spot without dabs as its circle", () => {
    expect(spotRegion(spot({ shape: "brush", dabs: [] })).kind).toBe("circle");
  });
});

describe("region measures", () => {
  it("anchors a stroke at its paint dabs' centroid, ignoring erases", () => {
    const a = regionAnchor({
      kind: "brush",
      dabs: [dab(0.2, 0.4, 0.02), dab(0.4, 0.6, 0.02), dab(0.9, 0.9, 0.05, 0.5, true)],
    });
    expect(a.x).toBeCloseTo(0.3, 12);
    expect(a.y).toBeCloseTo(0.5, 12);
  });

  it("anchors a stroke with no paint dabs at all its dabs' centroid", () => {
    // The overlay's fallback offset measures from the anchor, so it must stay finite.
    const a = regionAnchor({ kind: "brush", dabs: [dab(0.2, 0.4, 0.02, 0.5, true), dab(0.4, 0.6, 0.02, 0.5, true)] });
    expect(a.x).toBeCloseTo(0.3, 12);
    expect(a.y).toBeCloseTo(0.5, 12);
  });

  it("takes the band width from the radius or the widest paint dab", () => {
    expect(regionBandWidth({ kind: "circle", x: 0, y: 0, radius: 0.07, feather: 0 })).toBe(0.07);
    expect(
      regionBandWidth({ kind: "brush", dabs: [dab(0, 0, 0.02), dab(0, 0, 0.04), dab(0, 0, 0.09, 0.5, true)] }),
    ).toBe(0.04);
  });

  it("measures the escape as the narrower side of the copied box", () => {
    expect(regionEscape({ kind: "circle", x: 0.5, y: 0.5, radius: 0.1, feather: 0.5 }, 1)).toBeCloseTo(0.3, 12);
    // A horizontal stroke: 0.34 wide in height units at aspect 1.5, 0.04 tall.
    expect(regionEscape({ kind: "brush", dabs: [dab(0.3, 0.5, 0.02), dab(0.5, 0.5, 0.02)] }, 1.5)).toBeCloseTo(
      0.04,
      12,
    );
  });

  it("measures a slanted stroke's escape across it, not across its box", () => {
    // 45° in height units at aspect 1.5: its box is 0.34 square, but a move of
    // one dab width (0.04) at right angles clears it.
    const dabs: BrushDab[] = [];
    for (let i = 0; i <= 20; i++) dabs.push(dab(0.3 + i * 0.01, 0.3 + i * 0.015, 0.02));
    expect(regionEscape({ kind: "brush", dabs }, 1.5)).toBeCloseTo(0.04, 12);
  });

  it("picks the finest level where band and escape both fit", () => {
    const heights = [683, 341, 170, 85, 42, 21];
    expect(pickLevel(0.004, 0.012, heights)).toBe(0);
    expect(pickLevel(0.05, 0.15, heights)).toBe(2); // band 34 → 17 → 8.5 px
    expect(pickLevel(0.01, 1.0, heights)).toBe(3); // escape 683 → 341 → 170 → 85 px
    expect(pickLevel(2, 2, heights)).toBe(5); // fits nowhere: the coarsest
  });
});

describe("rasterizeRegion", () => {
  // Radius 20 px with 10 px of feather, centred on a 200² level.
  const disc: HealRegion = { kind: "circle", x: 0.5, y: 0.5, radius: 0.1, feather: 0.5 };
  const from = (r: RegionRaster, [x, y]: [number, number]) => Math.hypot(x - r.ax, y - r.ay);
  const countWithin = (radius: number) => {
    let n = 0;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (Math.hypot(x - 99.5, y - 99.5) < radius) n++;
    return n;
  };

  it("anchors on the circle's centre in level pixels", () => {
    const r = raster(disc, 200, 200);
    expect([r.ax, r.ay]).toEqual([99.5, 99.5]);
    expect(r.bandPx).toBeCloseTo(20, 12);
  });

  it("splits a circle into blemish, copied disc and band", () => {
    const r = raster(disc, 200, 200);
    for (const p of pairs(r.interior)) expect(from(r, p)).toBeLessThan(20);
    for (const p of pairs(r.copied)) expect(from(r, p)).toBeLessThan(30);
    expect(r.copied.length / 2).toBe(countWithin(30)); // kept whole
    // From the blemish's edge out past the feather and one band width.
    for (const p of pairs(r.band)) {
      expect(from(r, p)).toBeGreaterThanOrEqual(20);
      expect(from(r, p)).toBeLessThanOrEqual(51.5);
    }
  });

  it("copies only the blemish of a feather-free circle", () => {
    const r = raster({ kind: "circle", x: 0.5, y: 0.5, radius: 0.1, feather: 0 }, 200, 200);
    expect(r.copied.length / 2).toBe(countWithin(20));
  });

  it("weights the band toward the seam", () => {
    const r = raster(disc, 200, 200);
    const near: number[] = [];
    const far: number[] = [];
    pairs(r.band).forEach((p, k) => {
      const d = from(r, p);
      if (d < 25) near.push(r.bandWeight[k]);
      else if (d > 45) far.push(r.bandWeight[k]);
    });
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mean(near)).toBeGreaterThan(0.8);
    expect(mean(far)).toBeLessThan(0.2);
    for (const wt of r.bandWeight) {
      expect(wt).toBeGreaterThan(0);
      expect(wt).toBeLessThanOrEqual(1);
    }
  });

  it("thins band and interior to a few hundred points", () => {
    const r = raster(disc, 200, 200);
    expect(r.interior.length / 2).toBeGreaterThan(128 * 0.7);
    expect(r.interior.length / 2).toBeLessThan(128 * 1.3);
    expect(r.band.length / 2).toBeGreaterThan(256 * 0.7);
    expect(r.band.length / 2).toBeLessThan(256 * 1.3);
  });

  it("reports reaches and bounds covering what it keeps", () => {
    const r = raster(disc, 200, 200);
    expect(r.interiorReach).toBeGreaterThan(19);
    expect(r.interiorReach).toBeLessThan(20);
    expect(r.copiedReach).toBeGreaterThan(29);
    expect(r.copiedReach).toBeLessThan(30);
    expect(r.reach).toBeGreaterThan(49);
    expect(r.reach).toBeLessThan(51.5);
    const inside = (b: typeof r.bounds, pts: [number, number][]) => {
      for (const [x, y] of pts) {
        expect(x - r.ax).toBeGreaterThanOrEqual(b.minDx);
        expect(x - r.ax).toBeLessThanOrEqual(b.maxDx);
        expect(y - r.ay).toBeGreaterThanOrEqual(b.minDy);
        expect(y - r.ay).toBeLessThanOrEqual(b.maxDy);
      }
    };
    inside(r.bounds, [...pairs(r.copied), ...pairs(r.band)]);
    inside(r.copiedBounds, pairs(r.copied));
    inside(r.interiorBounds, pairs(r.interior));
  });

  it("measures the distance to the blemish", () => {
    const r = raster(disc, 200, 200);
    expect(r.distToInterior(99.5, 99.5)).toBe(0);
    // (125, 100) is 25.5 px out; the blemish's last pixel on that row is (119, 100).
    expect(r.distToInterior(125, 100)).toBeCloseTo(6, 5);
    // Off the grid: its margin, one band width plus two.
    expect(r.distToInterior(0, 0)).toBeCloseTo(22, 12);
  });

  it("still blots out the pixel under a spot smaller than a pixel", () => {
    const r = raster({ kind: "circle", x: 0.5, y: 0.5, radius: 0.001, feather: 0.5 }, 200, 200);
    expect(pairs(r.interior)).toEqual([[100, 100]]);
    expect(r.band.length).toBeGreaterThan(0);
  });

  it("clips to the frame", () => {
    const r = raster({ kind: "circle", x: 0, y: 0, radius: 0.05, feather: 0.5 }, 200, 200);
    for (const [x, y] of [...pairs(r.interior), ...pairs(r.copied), ...pairs(r.band)]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns nothing for a circle off the frame or a stroke erased away", () => {
    expect(rasterizeRegion({ kind: "circle", x: 3, y: 3, radius: 0.05, feather: 0 }, 200, 200)).toBeNull();
    expect(rasterizeRegion({ kind: "brush", dabs: [dab(0.5, 0.5, 0.05, 0.5, true)] }, 200, 200)).toBeNull();
  });

  it("takes a stroke's blemish where its coverage reaches half", () => {
    // Dabs of radius 4 px (feather 0.5: solid to 2 px, fading out at 4 px) every 2 px along y = 99.5.
    const dabs: BrushDab[] = [];
    for (let i = 0; i <= 40; i++) dabs.push(dab(0.3 + i * 0.01, 0.5, 0.02));
    const r = raster({ kind: "brush", dabs }, 200, 200);
    for (const [, y] of pairs(r.interior)) expect(Math.abs(y - 99.5)).toBeLessThanOrEqual(3);
    for (const [, y] of pairs(r.copied)) expect(Math.abs(y - 99.5)).toBeLessThan(4);
  });

  it("lets an erase dab cut the blemish back", () => {
    // A hard 10 px erase in the middle of a 20 px paint dab.
    const r = raster({ kind: "brush", dabs: [dab(0.5, 0.5, 0.1), dab(0.5, 0.5, 0.05, 0, true)] }, 200, 200);
    expect(r.distToInterior(99.5, 99.5)).toBeGreaterThan(5);
    for (const [x, y] of pairs(r.interior)) expect(Math.hypot(x - 99.5, y - 99.5)).toBeGreaterThanOrEqual(10);
  });

  // A ring (a paint dab with a hard erase in its middle), a small disc and a
  // thin 45° stroke, on a 200² level.
  const ring: HealRegion = { kind: "brush", dabs: [dab(0.5, 0.5, 0.06), dab(0.5, 0.5, 0.03, 0, true)] };
  const small: HealRegion = { kind: "circle", x: 0.5, y: 0.5, radius: 0.05, feather: 0.5 };
  const slant: HealRegion = {
    kind: "brush",
    dabs: Array.from({ length: 41 }, (_, i) => dab(0.3 + i * 0.01, 0.3 + i * 0.01, 0.01)),
  };
  const runPixels = (runs: RowRuns) => {
    const out: string[] = [];
    for (let y = 0; y < runs.h; y++) {
      for (let k = runs.start[y]; k < runs.start[y + 1]; k += 2) {
        for (let x = runs.xs[k]; x <= runs.xs[k + 1]; x++) out.push(`${x},${runs.y0 + y}`);
      }
    }
    return out.sort();
  };

  it("lists the copied pixels and the blemish as runs along each row", () => {
    for (const region of [ring, small, slant]) {
      const r = raster(region, 200, 200);
      const copied = pairs(r.copied);
      expect(runPixels(r.copiedRuns)).toEqual(copied.map(([x, y]) => `${x},${y}`).sort());
      const blemish = copied.filter(([x, y]) => r.distToInterior(x, y) === 0);
      expect(runPixels(r.interiorRuns)).toEqual(blemish.map(([x, y]) => `${x},${y}`).sort());
    }
    // Row 100 crosses the ring's hole, so it holds two runs of blemish.
    const r = raster(ring, 200, 200);
    const mid = 100 - r.interiorRuns.y0;
    expect(r.interiorRuns.start[mid + 1] - r.interiorRuns.start[mid]).toBe(4);
  });

  it("finds a shifted copy landing on the blemish exactly when the pixel walk does", () => {
    for (const region of [ring, small, slant]) {
      const r = raster(region, 200, 200);
      const copied = pairs(r.copied);
      const disagree: string[] = [];
      for (let ty = -30; ty <= 30; ty++) {
        for (let tx = -30; tx <= 30; tx++) {
          const walk = copied.some(([x, y]) => r.distToInterior(x + tx, y + ty) < 1);
          if (runsMeet(r.copiedRuns, r.interiorRuns, tx, ty) !== walk) disagree.push(`${tx},${ty}`);
        }
      }
      expect(disagree).toEqual([]);
    }
  });
});
