// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the preset adjustment summary helpers.

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  DEFAULT_DEVELOP_PARAMS,
  defaultMaskAdjustments,
  type Mask,
} from "@/catalog/types";
import { registerPipeline, useRegistry } from "@/extensions/registry";
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

describe("display transform", () => {
  beforeEach(() => {
    useRegistry.setState({ pipelines: {} });
    registerPipeline("test", { id: "test.agx", name: "AgX" });
  });

  afterEach(() => useRegistry.setState({ pipelines: {} }));

  it("names the transform a preset carries", () => {
    expect(summarizePreset({ displayTransform: "test.agx" })).toContainEqual({
      label: "Display transform",
      value: "AgX",
    });
  });

  it("shows the id when the transform isn't installed", () => {
    expect(summarizePreset({ displayTransform: "gone.film" })).toContainEqual({
      label: "Display transform",
      value: "gone.film",
    });
  });

  it("says nothing for a preset that follows the default", () => {
    expect(summarizePreset({ displayTransform: null })).toEqual([]);
  });

  it("offers the group, changed only when the photo has its own pick", () => {
    const own = presetFields({ ...DEFAULT_DEVELOP_PARAMS, displayTransform: "test.agx" });
    expect(own.find((f) => f.id === "displayTransform")).toMatchObject({
      label: "Display transform",
      keys: ["displayTransform"],
      changed: true,
    });
    const onDefault = presetFields({ ...DEFAULT_DEVELOP_PARAMS });
    expect(onDefault.find((f) => f.id === "displayTransform")?.changed).toBe(false);
  });

  it("copies the pick into a preset when ticked", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS, displayTransform: "test.agx" };
    const fields = presetFields(params);
    expect(buildPartialParams(params, fields, new Set(["displayTransform"]))).toEqual({
      displayTransform: "test.agx",
    });
  });
});
