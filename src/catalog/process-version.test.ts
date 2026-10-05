// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process versions: an edit made before they existed renders exactly as it
// always has (version 1); a photo starting fresh gets the current version.
// Presets and pasted settings never move a photo between versions.

import { describe, expect, it } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_DEVELOP_PARAMS,
  LEGACY_PROCESS_VERSION,
  defaultColorGrading,
  defaultMaskAdjustments,
  freshParams,
  isNeutralColorGrading,
  maskHasDisplayAdjustments,
  normalizeParams,
  usesOlderProcessing,
  withoutProcessVersion,
  type DevelopParams,
} from "./types";

describe("normalizeParams: processVersion", () => {
  it("reads an edit saved before process versions existed as version 1", () => {
    expect(normalizeParams({ exposure: 1 }).processVersion).toBe(LEGACY_PROCESS_VERSION);
    expect(normalizeParams(undefined).processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  it.each([1, 2, 3])("keeps a stored version of %d, including one from a newer build", (v) => {
    expect(normalizeParams({ processVersion: v }).processVersion).toBe(v);
  });

  it.each([0, -2, 1.5, Number.NaN, "2", null])("reads a corrupt version of %o as version 1", (v) => {
    const corrupt = { processVersion: v } as unknown as Partial<DevelopParams>;
    expect(normalizeParams(corrupt).processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  it("survives normalizing twice", () => {
    expect(normalizeParams(normalizeParams({ processVersion: 2 })).processVersion).toBe(2);
  });
});

describe("freshParams", () => {
  it("is today's defaults at the current version", () => {
    expect(DEFAULT_DEVELOP_PARAMS.processVersion).toBe(CURRENT_PROCESS_VERSION);
    expect(freshParams()).toEqual(DEFAULT_DEVELOP_PARAMS);
  });

  it("seeds the as-shot white balance", () => {
    const p = freshParams(3200);
    expect(p.temperature).toBe(3200);
    expect(p.processVersion).toBe(CURRENT_PROCESS_VERSION);
  });
});

describe("withoutProcessVersion", () => {
  it("drops the version from a partial edit and keeps the rest", () => {
    expect(withoutProcessVersion({ exposure: 1, processVersion: 2 })).toEqual({ exposure: 1 });
  });
});

describe("usesOlderProcessing", () => {
  const olderVersions = Array.from(
    { length: CURRENT_PROCESS_VERSION - LEGACY_PROCESS_VERSION },
    (_, i) => LEGACY_PROCESS_VERSION + i,
  );

  it.each(olderVersions)("is true for version %i, which is below the current one", (version) => {
    expect(usesOlderProcessing({ processVersion: version })).toBe(true);
  });

  it("is true for an edit that stores no version, which reads as version 1", () => {
    expect(usesOlderProcessing(normalizeParams({ exposure: 1 }))).toBe(true);
  });

  it("is false at the current version", () => {
    expect(usesOlderProcessing(freshParams())).toBe(false);
  });

  it("is false for a version from a newer build, which is never offered an update", () => {
    expect(usesOlderProcessing({ processVersion: CURRENT_PROCESS_VERSION + 1 })).toBe(false);
  });
});

describe("activity predicates the version 2 shader skips on", () => {
  it("sees neutral grading only when every wheel offset and luma lift is zero", () => {
    const cg = defaultColorGrading();
    expect(isNeutralColorGrading(cg)).toBe(true);
    expect(
      isNeutralColorGrading({ ...cg, shadowRange: 10, highlights: { hue: 40, sat: 0, luma: 0 } }),
    ).toBe(true);
    expect(isNeutralColorGrading({ ...cg, midtones: { hue: 40, sat: 5, luma: 0 } })).toBe(false);
    expect(isNeutralColorGrading({ ...cg, global: { hue: 0, sat: 0, luma: -3 } })).toBe(false);
  });

  it("sees a mask's display adjustments, not its linear ones", () => {
    const adj = defaultMaskAdjustments();
    expect(
      maskHasDisplayAdjustments({ ...adj, exposure: 1, highlights: -20, temperature: 10 }),
    ).toBe(false);
    const display = [
      "contrast", "saturation", "vibrance", "whites", "blacks",
      "clarity", "sharpness", "texture", "dehaze",
    ] as const;
    for (const key of display) expect(maskHasDisplayAdjustments({ ...adj, [key]: 5 })).toBe(true);
  });
});
