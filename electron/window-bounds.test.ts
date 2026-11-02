// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The window's minimum size may never exceed the screen it is on: on a small
// display (an 800x600 VM) a larger frame pushes the min/max/close buttons off
// screen (window-bounds.cjs).

import { describe, expect, it } from "vitest";
import { effectiveMinimum, fitToWorkArea } from "./window-bounds.cjs";

const MIN = { width: 900, height: 600 };

describe("effectiveMinimum", () => {
  it("keeps the nominal minimum on a roomy display", () => {
    expect(effectiveMinimum(MIN, { width: 1920, height: 1040 })).toEqual(MIN);
  });

  it("shrinks to the work area on a small display", () => {
    expect(effectiveMinimum(MIN, { width: 800, height: 560 })).toEqual({
      width: 800,
      height: 560,
    });
  });

  it("shrinks one axis independently", () => {
    expect(effectiveMinimum(MIN, { width: 1366, height: 540 })).toEqual({
      width: 900,
      height: 540,
    });
  });
});

describe("fitToWorkArea", () => {
  it("fits a saved size inside an 800x560 work area", () => {
    const r = fitToWorkArea({ width: 1500, height: 950 }, MIN, { width: 800, height: 560 });
    expect(r).toEqual({ width: 800, height: 560 });
  });

  it("raises a too-small size to the minimum when the screen allows", () => {
    const r = fitToWorkArea({ width: 300, height: 200 }, MIN, { width: 1920, height: 1040 });
    expect(r).toEqual(MIN);
  });

  it("caps a large size to the work area", () => {
    const r = fitToWorkArea({ width: 5000, height: 5000 }, MIN, { width: 1920, height: 1040 });
    expect(r).toEqual({ width: 1920, height: 1040 });
  });
});
