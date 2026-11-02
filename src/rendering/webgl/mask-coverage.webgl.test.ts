// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// bakeCoverage rasterises brush strokes through a 2D canvas, so in node it can
// only be checked as far as its empty-list guard (see mask-coverage.test.ts,
// which also owns the pure coverageSignature). Here it runs for real: the two
// controls that shape a dab — flow builds coverage up, opacity caps how far it
// can build — and the RGBA packing the shader reads every mask through.

import { describe, expect, it, vi } from "vitest";
import type { BrushDab } from "@/catalog/types";
import { MAX_BRUSH_MASKS } from "@/catalog/types";
import { CoverageBaker, bakeCoverage, type CoverageItem, type CoverageResult } from "./mask-coverage";

function dab(over: Partial<BrushDab> = {}): BrushDab {
  return { x: 0.5, y: 0.5, radius: 0.2, erase: false, feather: 0, ...over };
}

function bake(dabs: BrushDab[], aspect = 1): CoverageResult {
  const result = bakeCoverage([{ id: "a", dabs }], aspect);
  if (!result) throw new Error("bakeCoverage returned null");
  return result;
}

/** Coverage byte at a normalized position, in the given atlas channel. */
function coverageAt(result: CoverageResult, u: number, v: number, channel = 0): number {
  const x = Math.min(result.size - 1, Math.max(0, Math.round(u * result.size)));
  const y = Math.min(result.size - 1, Math.max(0, Math.round(v * result.size)));
  return result.data[(y * result.size + x) * 4 + channel];
}

describe("bakeCoverage", () => {
  it("bakes an empty atlas for an item nothing has been painted on yet", () => {
    const baked = bakeCoverage([{ id: "a", dabs: [] }], 1);
    if (!baked) throw new Error("bakeCoverage returned null");
    expect(baked.channelOf).toEqual({ a: 0 });
    expect(baked.data.every((byte) => byte === 0)).toBe(true);
  });

  it("fills a hard-edged dab solidly and leaves the rest clear", () => {
    const baked = bake([dab()]);
    expect(coverageAt(baked, 0.5, 0.5)).toBe(255);
    expect(coverageAt(baked, 0.6, 0.5)).toBe(255);
    expect(coverageAt(baked, 0.9, 0.5)).toBe(0);
    expect(baked.channelOf).toEqual({ a: 0 });
  });

  it("falls off across the feathered band", () => {
    const baked = bake([dab({ feather: 1 })]);
    const samples = [0.5, 0.56, 0.62, 0.68].map((u) => coverageAt(baked, u, 0.5));
    // Full feather leaves no solid core — the gradient starts at the dab centre,
    // so the peak is a hair under 255 and every step outward is strictly lower.
    expect(samples[0]).toBeGreaterThan(250);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThan(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBeLessThan(64);
  });

  it("caps coverage at the dab's opacity", () => {
    const baked = bake([dab({ opacity: 0.5 })]);
    expect(coverageAt(baked, 0.5, 0.5)).toBeCloseTo(128, -1);
  });

  it("builds coverage up as low-flow dabs overlap", () => {
    const once = coverageAt(bake([dab({ flow: 0.5 })]), 0.5, 0.5);
    const twice = coverageAt(bake([dab({ flow: 0.5 }), dab({ flow: 0.5 })]), 0.5, 0.5);
    expect(once).toBeCloseTo(128, -1);
    expect(twice).toBeGreaterThan(once);
    expect(twice).toBeLessThan(255);
  });

  it("never builds past the opacity ceiling", () => {
    const dabs = [dab({ opacity: 0.5 }), dab({ opacity: 0.5 }), dab({ opacity: 0.5 })];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBeCloseTo(128, -1);
  });

  it("lays each new stroke over the last, so low opacity builds up stroke by stroke", () => {
    const one = coverageAt(bake([dab({ opacity: 0.5, strokeStart: true })]), 0.5, 0.5);
    const two = coverageAt(
      bake([dab({ opacity: 0.5, strokeStart: true }), dab({ opacity: 0.5, strokeStart: true })]),
      0.5,
      0.5,
    );
    const three = coverageAt(
      bake([
        dab({ opacity: 0.2, strokeStart: true }),
        dab({ opacity: 0.2, strokeStart: true }),
        dab({ opacity: 0.2, strokeStart: true }),
      ]),
      0.5,
      0.5,
    );
    expect(one).toBeCloseTo(128, -1);
    expect(two).toBeCloseTo(191, -1); // 0.5 over 0.5
    expect(three).toBeCloseTo(124, -1); // 1 - 0.8³
  });

  it("caps each stroke at its own opacity, however many dabs it lays", () => {
    const dabs = [
      dab({ opacity: 0.5, strokeStart: true }),
      dab({ opacity: 0.5 }),
      dab({ opacity: 0.5 }),
      dab({ opacity: 0.3, strokeStart: true }),
      dab({ opacity: 0.3 }),
    ];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBeCloseTo(166, -1); // 0.3 over 0.5
  });

  it("lets a stroke reach past an earlier, lower one", () => {
    const dabs = [dab({ opacity: 0.2, strokeStart: true }), dab({ opacity: 1, strokeStart: true })];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBe(255);
  });

  it("erases by the erase stroke's opacity", () => {
    const dabs = [dab({ strokeStart: true }), dab({ erase: true, opacity: 0.5, strokeStart: true })];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBeCloseTo(128, -1);
  });

  it("only touches what a stroke covers", () => {
    const dabs = [
      dab({ x: 0.25, radius: 0.1, opacity: 0.5, strokeStart: true }),
      dab({ x: 0.75, radius: 0.1, opacity: 0.5, strokeStart: true }),
    ];
    const baked = bake(dabs);
    expect(coverageAt(baked, 0.25, 0.5)).toBeCloseTo(128, -1);
    expect(coverageAt(baked, 0.75, 0.5)).toBeCloseTo(128, -1);
    expect(coverageAt(baked, 0.5, 0.5)).toBe(0);
  });

  it("removes coverage under an erase dab", () => {
    const baked = bake([dab({ radius: 0.3 }), dab({ radius: 0.1, erase: true })]);
    expect(coverageAt(baked, 0.5, 0.5)).toBe(0);
    expect(coverageAt(baked, 0.7, 0.5)).toBe(255);
  });

  it("keeps a dab round on screen by dividing its x-radius by the aspect", () => {
    const baked = bake([dab({ radius: 0.2 })], 2);
    // Half the horizontal reach, unchanged vertically.
    expect(coverageAt(baked, 0.59, 0.5)).toBe(255);
    expect(coverageAt(baked, 0.65, 0.5)).toBe(0);
    expect(coverageAt(baked, 0.5, 0.69)).toBe(255);
  });

  it("packs one item per channel and drops what the atlas cannot hold", () => {
    const items: CoverageItem[] = [0, 1, 2, 3, 4].map((i) => ({
      id: `item${i}`,
      dabs: [dab({ x: 0.1 + i * 0.15 })],
    }));
    const baked = bakeCoverage(items, 1);
    if (!baked) throw new Error("bakeCoverage returned null");
    expect(Object.keys(baked.channelOf)).toHaveLength(MAX_BRUSH_MASKS);
    expect(baked.channelOf.item4).toBeUndefined();
    for (let channel = 0; channel < MAX_BRUSH_MASKS; channel++) {
      expect(coverageAt(baked, 0.1 + channel * 0.15, 0.5, channel)).toBe(255);
    }
  });
});

// A brush stroke grows by a few dabs a frame, and each frame's params hand the
// renderer the whole stroke history again, cloned. CoverageBaker keeps what it
// baked, so a frame rasterises only the stroke still being painted, and an item
// whose dabs didn't change not at all, and comes out byte for byte as a full bake.
describe("CoverageBaker", () => {
  /** A soft, low-flow stroke of `n` dabs along a line, so overlaps build up. */
  function stroke(n: number, over: Partial<BrushDab> = {}, y = 0.5): BrushDab[] {
    return Array.from({ length: n }, (_, i) =>
      dab({ x: 0.2 + i * 0.03, y, radius: 0.08, feather: 0.6, flow: 0.4, opacity: 0.8, strokeStart: i === 0, ...over }),
    );
  }

  function expectSameAsFullBake(baked: CoverageResult | null, items: CoverageItem[], aspect = 1) {
    const full = bakeCoverage(items, aspect);
    if (!baked || !full) throw new Error("a bake returned null");
    expect(baked.channelOf).toEqual(full.channelOf);
    let differing = 0;
    for (let i = 0; i < full.data.length; i++) if (baked.data[i] !== full.data[i]) differing++;
    expect(differing).toBe(0);
  }

  /** The radial gradients a call creates: two for every dab it rasterises. */
  function gradientsDuring(run: () => void): number {
    const spy = vi.spyOn(CanvasRenderingContext2D.prototype, "createRadialGradient");
    try {
      run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it("matches a full bake as a stroke grows, new strokes start and an erase stroke cuts in", () => {
    const baker = new CoverageBaker();
    let dabs: BrushDab[] = [];
    const steps = [
      stroke(3),
      stroke(4).slice(1).map((d) => ({ ...d, x: d.x + 0.01 })),
      stroke(5, { opacity: 0.5 }, 0.55),
      stroke(2, { erase: true, opacity: 0.6 }, 0.5),
      stroke(3, { erase: true, opacity: 0.6, strokeStart: false }, 0.52),
      stroke(4, { flow: 1, opacity: 1 }, 0.45),
    ];
    for (const added of steps) {
      dabs = structuredClone([...dabs, ...added]);
      const items = [{ id: "a", dabs }];
      expectSameAsFullBake(baker.bake(items, 1), items);
    }
  });

  it("matches a full bake for dabs painted before strokes were recorded", () => {
    const baker = new CoverageBaker();
    const legacy = stroke(6, { strokeStart: undefined });
    for (const dabs of [legacy.slice(0, 2), legacy.slice(0, 4), [...legacy.slice(0, 4), dab({ x: 0.3, erase: true, radius: 0.05 })], legacy]) {
      const items = [{ id: "a", dabs: structuredClone(dabs) }];
      expectSameAsFullBake(baker.bake(items, 1.5), items, 1.5);
    }
  });

  it("matches a full bake after an undo, an edited dab, or a new aspect", () => {
    const baker = new CoverageBaker();
    const two = [...stroke(4), ...stroke(4, {}, 0.6)];
    const bake = (dabs: BrushDab[], aspect = 1) => {
      const items = [{ id: "a", dabs: structuredClone(dabs) }];
      expectSameAsFullBake(baker.bake(items, aspect), items, aspect);
    };
    bake(two);
    bake(stroke(4));
    bake([{ ...two[0], x: 0.25 }, ...two.slice(1)]);
    bake(two, 2);
  });

  it("rasterises only the stroke still being painted, and nothing for an unchanged item", () => {
    const baker = new CoverageBaker();
    const other = { id: "b", dabs: stroke(10, {}, 0.3) };
    const history = stroke(20);
    baker.bake([{ id: "a", dabs: history }, other], 1);

    const next = structuredClone([...history, ...stroke(2, {}, 0.7)]);
    expect(gradientsDuring(() => baker.bake([{ id: "a", dabs: next }, other], 1))).toBe(4);

    const grown = structuredClone([...next, dab({ x: 0.5, y: 0.7, radius: 0.08 })]);
    const items = [{ id: "a", dabs: grown }, structuredClone(other)];
    let baked: CoverageResult | null = null;
    expect(gradientsDuring(() => (baked = baker.bake(items, 1)))).toBe(6);
    expectSameAsFullBake(baked, items);
  });
});

