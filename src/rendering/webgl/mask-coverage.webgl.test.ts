// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// bakeCoverage rasterises brush strokes through a 2D canvas, so in node it can
// only be checked as far as its empty-list guard (see mask-coverage.test.ts,
// which also owns the pure coverageSignature). Here it runs for real: the two
// controls that shape a dab — flow builds coverage up, opacity caps how far it
// can build — and the RGBA packing the shader reads every mask through.

import { describe, expect, it } from "vitest";
import type { BrushDab } from "@/catalog/types";
import { MAX_BRUSH_MASKS } from "@/catalog/types";
import { bakeCoverage, type CoverageItem, type CoverageResult } from "./mask-coverage";

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

