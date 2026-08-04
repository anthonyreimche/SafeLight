// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// bakeCoverage rasterises through a 2D canvas (DOM or OffscreenCanvas), neither
// of which exists in the node test environment, so only its empty-list guard —
// which returns before any canvas is touched — is exercised here. The cache
// signature it is paired with is pure and gets the real coverage.

import { describe, it, expect } from "vitest";
import { bakeCoverage, coverageSignature } from "./mask-coverage";
import type { CoverageItem } from "./mask-coverage";
import type { BrushDab } from "@/catalog/types";

const dab = (patch: Partial<BrushDab> = {}): BrushDab => ({
  x: 0.5,
  y: 0.5,
  radius: 0.1,
  erase: false,
  feather: 0.5,
  ...patch,
});

const item = (id: string, dabs: BrushDab[]): CoverageItem => ({ id, dabs });

describe("coverageSignature", () => {
  it("changes when the image aspect changes, even with identical dabs", () => {
    const items = [item("m1", [dab()])];
    expect(coverageSignature(items, 1.5)).not.toBe(coverageSignature(items, 1.5001));
  });

  it("treats absent opacity and flow as fully on", () => {
    expect(coverageSignature([item("m1", [dab()])], 1)).toBe(
      coverageSignature([item("m1", [dab({ opacity: 1, flow: 1 })])], 1),
    );
  });

  it("tracks every property that reshapes a dab", () => {
    const base = coverageSignature([item("m1", [dab()])], 1);
    const variants: Array<Partial<BrushDab>> = [
      { x: 0.51 },
      { y: 0.51 },
      { radius: 0.11 },
      { feather: 0.4 },
      { opacity: 0.5 },
      { flow: 0.5 },
      { erase: true },
    ];
    for (const patch of variants) {
      expect(coverageSignature([item("m1", [dab(patch)])], 1)).not.toBe(base);
    }
  });

  it("quantises geometry below the bake's resolvable precision", () => {
    // 4 decimals of UV over a 768 px bake is well under a texel, so a nudge that
    // small must not invalidate the cached atlas.
    expect(coverageSignature([item("m1", [dab({ x: 0.5000004 })])], 1)).toBe(
      coverageSignature([item("m1", [dab({ x: 0.5 })])], 1),
    );
  });

  it("distinguishes item identity, ordering and dab count", () => {
    const a = item("m1", [dab()]);
    const b = item("m2", [dab()]);
    expect(coverageSignature([a], 1)).not.toBe(coverageSignature([b], 1));
    expect(coverageSignature([a, b], 1)).not.toBe(coverageSignature([b, a], 1));
    expect(coverageSignature([item("m1", [dab(), dab()])], 1)).not.toBe(
      coverageSignature([a], 1),
    );
  });

  it("is stable for an empty item list", () => {
    expect(coverageSignature([], 1.25)).toBe(coverageSignature([], 1.25));
    expect(coverageSignature([], 1.25)).not.toBe(coverageSignature([], 2));
  });

  it("separates an item with no dabs from no item at all", () => {
    expect(coverageSignature([item("m1", [])], 1)).not.toBe(coverageSignature([], 1));
  });
});

describe("bakeCoverage", () => {
  it("returns nothing to bake for an empty item list", () => {
    expect(bakeCoverage([], 1.5)).toBeNull();
  });
});
