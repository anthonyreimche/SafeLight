// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The bag side of coverage-kind stage textures: which values are a paintable
// dab list, how they become atlas items, and what engages a prepass.

import { describe, expect, it } from "vitest";
import type { BrushDab } from "@/catalog/types";
import { coverageItemsFromBag, isBrushDabList, paramIsActive } from "./stage-coverage";

const dab = (patch: Partial<BrushDab> = {}): BrushDab => ({
  x: 0.5,
  y: 0.5,
  radius: 0.1,
  erase: false,
  feather: 0.5,
  ...patch,
});

describe("isBrushDabList", () => {
  it("accepts dabs with and without the optional opacity/flow", () => {
    expect(isBrushDabList([dab(), dab({ opacity: 0.5, flow: 0.2 })])).toBe(true);
    expect(isBrushDabList([])).toBe(true);
  });

  it("rejects anything that is not a list of complete, finite dabs", () => {
    expect(isBrushDabList(undefined)).toBe(false);
    expect(isBrushDabList(1)).toBe(false);
    expect(isBrushDabList([1])).toBe(false);
    expect(isBrushDabList([{ x: 0.5, y: 0.5 }])).toBe(false);
    expect(isBrushDabList([dab({ x: Number.NaN })])).toBe(false);
    expect(isBrushDabList([dab({ erase: 1 as unknown as boolean })])).toBe(false);
    expect(isBrushDabList([dab({ flow: "1" as unknown as number })])).toBe(false);
  });
});

describe("coverageItemsFromBag", () => {
  it("returns one item per painted key, in key order, keyed by the qualified key", () => {
    const bag = {
      "b.stage.mask": [dab({ x: 0.2 })],
      "a.stage.mask": [dab()],
      "a.stage.amount": 40,
    };
    expect(coverageItemsFromBag(["a.stage.mask", "b.stage.mask"], bag)).toEqual([
      { id: "a.stage.mask", dabs: [dab()] },
      { id: "b.stage.mask", dabs: [dab({ x: 0.2 })] },
    ]);
  });

  it("skips absent, empty and malformed values", () => {
    const bag = { "a.stage.mask": [], "c.stage.mask": [{ x: 1 }] };
    expect(
      coverageItemsFromBag(["a.stage.mask", "b.stage.mask", "c.stage.mask"], bag),
    ).toEqual([]);
  });
});

describe("paramIsActive", () => {
  it("treats non-zero numbers, true, and non-zero numeric vectors as active", () => {
    expect(paramIsActive(5)).toBe(true);
    expect(paramIsActive(true)).toBe(true);
    expect(paramIsActive([0, 2])).toBe(true);
  });

  it("treats zero, false, empty vectors and non-numeric values as inactive", () => {
    expect(paramIsActive(0)).toBe(false);
    expect(paramIsActive(false)).toBe(false);
    expect(paramIsActive([0, 0])).toBe(false);
    expect(paramIsActive(undefined)).toBe(false);
    expect(paramIsActive("40")).toBe(false);
  });

  it("never lets a dab list engage a prepass", () => {
    expect(paramIsActive([dab(), dab()])).toBe(false);
  });
});
