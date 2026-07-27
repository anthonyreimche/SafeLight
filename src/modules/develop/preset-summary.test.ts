// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the preset adjustment summary helpers.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_DEVELOP_PARAMS,
  defaultMaskAdjustments,
  type Mask,
} from "@/catalog/types";
import {
  summarizePreset,
  presetFields,
  buildPartialParams,
} from "./preset-summary.ts";

const mask = (id: string): Mask => ({
  id,
  name: "Mask",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [],
});

describe("summarizePreset", () => {
  it("reports nothing for untouched params", () => {
    expect(summarizePreset({ ...DEFAULT_DEVELOP_PARAMS })).toEqual([]);
  });

  it("lists changed scalars with signed values", () => {
    const diffs = summarizePreset({ contrast: 25, saturation: -100 });
    expect(diffs).toContainEqual({ label: "Contrast", value: "+25" });
    expect(diffs).toContainEqual({ label: "Saturation", value: "-100" });
  });

  it("does not throw on a partial preset missing the complex keys", () => {
    expect(() => summarizePreset({ exposure: 1 })).not.toThrow();
  });

  it("formats exposure in stops and lists only the keys carried", () => {
    expect(summarizePreset({ exposure: 1 })).toEqual([
      { label: "Exposure", value: "+1.00" },
    ]);
  });

  it("collapses a non-default complex field to one line", () => {
    expect(summarizePreset({ masks: [mask("m")] })).toContainEqual({
      label: "Masks",
      value: "1",
    });
  });
});

describe("presetFields", () => {
  it("flags only the adjustments that differ from the defaults", () => {
    const fields = presetFields({ ...DEFAULT_DEVELOP_PARAMS, clarity: 15 });
    expect(fields.find((f) => f.id === "clarity")?.changed).toBe(true);
    expect(fields.find((f) => f.id === "exposure")?.changed).toBe(false);
  });

  it("flags the bundled geometry field when straighten alone moved", () => {
    const fields = presetFields({ ...DEFAULT_DEVELOP_PARAMS, straighten: 5 });
    expect(fields.find((f) => f.id === "geometry")?.changed).toBe(true);
  });
});

describe("buildPartialParams", () => {
  it("copies only the selected fields' keys", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS, clarity: 15, contrast: 30 };
    const fields = presetFields(params);
    expect(buildPartialParams(params, fields, new Set(["clarity"]))).toEqual({
      clarity: 15,
    });
  });

  it("copies the whole crop/straighten/transform bundle for geometry", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS, straighten: 5 };
    const fields = presetFields(params);
    const partial = buildPartialParams(params, fields, new Set(["geometry"]));
    expect(partial.straighten).toBe(5);
    expect(partial.crop).toEqual(params.crop);
    expect(partial.transform).toEqual(params.transform);
  });
});
