import { describe, it, expect } from "vitest";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import {
  summarizePreset,
  presetFields,
  buildPartialParams,
} from "./preset-summary";

describe("summarizePreset", () => {
  it("returns nothing for default params", () => {
    expect(summarizePreset({ ...DEFAULT_DEVELOP_PARAMS })).toEqual([]);
  });

  it("lists changed scalars with signed values", () => {
    const diffs = summarizePreset({ contrast: 25, saturation: -100 });
    expect(diffs).toContainEqual({ label: "Contrast", value: "+25" });
    expect(diffs).toContainEqual({ label: "Saturation", value: "-100" });
  });

  it("is partial-safe (missing complex keys do not throw)", () => {
    expect(() => summarizePreset({ exposure: 1 })).not.toThrow();
    expect(summarizePreset({ exposure: 1 })).toEqual([
      { label: "Exposure", value: "+1.00" },
    ]);
  });

  it("collapses a non-default complex field to one line", () => {
    const diffs = summarizePreset({ masks: [{ id: "m" }] as never });
    expect(diffs).toContainEqual({ label: "Masks", value: "1" });
  });
});

describe("presetFields + buildPartialParams", () => {
  it("flags only changed adjustments", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS, clarity: 15 };
    const fields = presetFields(params);
    expect(fields.find((f) => f.id === "clarity")?.changed).toBe(true);
    expect(fields.find((f) => f.id === "exposure")?.changed).toBe(false);
  });

  it("copies only the selected fields' keys", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS, clarity: 15, contrast: 30 };
    const fields = presetFields(params);
    const partial = buildPartialParams(params, fields, new Set(["clarity"]));
    expect(partial).toEqual({ clarity: 15 });
  });

  it("geometry field bundles crop/straighten/transform", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS, straighten: 5 };
    const fields = presetFields(params);
    const geom = fields.find((f) => f.id === "geometry");
    expect(geom?.changed).toBe(true);
    const partial = buildPartialParams(params, fields, new Set(["geometry"]));
    expect(partial.straighten).toBe(5);
    expect(partial.crop).toBeDefined();
    expect(partial.transform).toBeDefined();
  });
});
