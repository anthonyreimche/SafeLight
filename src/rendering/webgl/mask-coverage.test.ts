// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// bakeCoverage rasterises through a 2D canvas (DOM or OffscreenCanvas), neither
// of which exists in the node test environment, so only its empty-list guard —
// which returns before any canvas is touched — is exercised here. The cache
// signature it is paired with, and the identity memo that spares it, are pure
// and get the real coverage.

import { describe, it, expect, vi } from "vitest";
import { CoverageInputs, bakeCoverage, coverageSignature } from "./mask-coverage";
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

describe("CoverageInputs", () => {
  it("reports a change on the first call", () => {
    expect(new CoverageInputs().changed([])).toBe(true);
    expect(new CoverageInputs().changed([[], 1, undefined])).toBe(true);
  });

  it("reports no change while every input is the same by identity", () => {
    const masks: unknown[] = [];
    const bag = {};
    const inputs = new CoverageInputs();
    expect(inputs.changed([masks, 64, 48, bag, undefined])).toBe(true);
    expect(inputs.changed([masks, 64, 48, bag, undefined])).toBe(false);
    expect(inputs.changed([masks, 64, 48, bag, undefined])).toBe(false);
  });

  it("compares by identity, not by value", () => {
    const inputs = new CoverageInputs();
    inputs.changed([[dab()]]);
    expect(inputs.changed([[dab()]])).toBe(true);
  });

  it("treats NaN as equal to itself, as Object.is does", () => {
    const inputs = new CoverageInputs();
    inputs.changed([Number.NaN]);
    expect(inputs.changed([Number.NaN])).toBe(false);
  });

  it("reports a change when any one input differs", () => {
    const masks: unknown[] = [];
    const bag = {};
    const base = [masks, 64, 48, bag];
    const inputs = new CoverageInputs();
    inputs.changed(base);
    const variants: unknown[][] = [
      [[], 64, 48, bag],
      [masks, 65, 48, bag],
      [masks, 64, 49, bag],
      [masks, 64, 48, {}],
    ];
    for (const variant of variants) {
      expect(inputs.changed(variant)).toBe(true);
      inputs.changed(base);
    }
  });

  it("reports a change when the count of inputs changes", () => {
    const inputs = new CoverageInputs();
    inputs.changed([1, 2]);
    expect(inputs.changed([1, 2, undefined])).toBe(true);
    expect(inputs.changed([1, 2])).toBe(true);
    expect(inputs.changed([])).toBe(true);
    expect(inputs.changed([])).toBe(false);
  });

  it("compares against the latest inputs, not the first", () => {
    const [a, b] = [{}, {}];
    const inputs = new CoverageInputs();
    expect(inputs.changed([a])).toBe(true);
    expect(inputs.changed([b])).toBe(true);
    expect(inputs.changed([b])).toBe(false);
    expect(inputs.changed([a])).toBe(true);
  });

  it("keeps its own copy of the inputs it was given", () => {
    const [a, b] = [{}, {}];
    const given = [a];
    const inputs = new CoverageInputs();
    inputs.changed(given);
    given[0] = b;
    expect(inputs.changed([a])).toBe(false);
  });

  it("reports a change again after a reset", () => {
    const masks: unknown[] = [];
    const inputs = new CoverageInputs();
    inputs.changed([masks]);
    expect(inputs.changed([masks])).toBe(false);
    inputs.reset();
    expect(inputs.changed([masks])).toBe(true);
    expect(inputs.changed([masks])).toBe(false);
  });
});

// The inputs only stand for a bake that finished: one that threw may have left its
// texture half done, so nothing may skip the next call on its account.
describe("CoverageInputs.bakeIfChanged", () => {
  it("bakes on the first call, then only when an input changed", () => {
    const [masks, replaced] = [[], []];
    const bake = vi.fn();
    const inputs = new CoverageInputs();
    inputs.bakeIfChanged([masks, 64], bake);
    inputs.bakeIfChanged([masks, 64], bake);
    expect(bake).toHaveBeenCalledTimes(1);
    inputs.bakeIfChanged([replaced, 64], bake);
    inputs.bakeIfChanged([replaced, 65], bake);
    expect(bake).toHaveBeenCalledTimes(3);
  });

  it("lets the error out as it was thrown", () => {
    const error = new Error("canvas lost");
    expect(() =>
      new CoverageInputs().bakeIfChanged([], () => {
        throw error;
      }),
    ).toThrow(error);
  });

  it("bakes again for the same inputs after a bake threw", () => {
    const masks: unknown[] = [];
    let attempts = 0;
    const bake = () => {
      attempts++;
      if (attempts === 1) throw new Error("canvas lost");
    };
    const inputs = new CoverageInputs();
    expect(() => inputs.bakeIfChanged([masks], bake)).toThrow("canvas lost");
    inputs.bakeIfChanged([masks], bake);
    expect(attempts).toBe(2);
    // The bake that finished is remembered again.
    inputs.bakeIfChanged([masks], bake);
    expect(attempts).toBe(2);
  });

  it("bakes again for the inputs of an earlier bake, after a later one threw", () => {
    const [before, after] = [[], []];
    const bake = vi.fn();
    const inputs = new CoverageInputs();
    inputs.bakeIfChanged([before], bake);
    expect(() =>
      inputs.bakeIfChanged([after], () => {
        throw new Error("canvas lost");
      }),
    ).toThrow("canvas lost");
    inputs.bakeIfChanged([before], bake);
    expect(bake).toHaveBeenCalledTimes(2);
  });
});

describe("bakeCoverage", () => {
  it("returns nothing to bake for an empty item list", () => {
    expect(bakeCoverage([], 1.5)).toBeNull();
  });
});
