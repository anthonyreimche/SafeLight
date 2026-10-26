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
  buildPartialBag,
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

  const GAIN = { bagKeys: ["t.x.gain"], bagDefaults: { "t.x.gain": 1 } };

  it("carries the transform's bag keys, changed when they moved", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS };
    const field = presetFields(params, [], { ...GAIN, changed: true }).find(
      (f) => f.id === "displayTransform",
    );
    expect(field).toMatchObject({ bagKeys: ["t.x.gain"], changed: true });
    const bag = { "t.x.gain": 2, "other.stage.y": 1 };
    expect(buildPartialBag(bag, presetFields(params, [], { ...GAIN, changed: true }), new Set(["displayTransform"]))).toEqual({
      "t.x.gain": 2,
    });
  });

  it("carries a transform setting the photo never stored as its default, so a tuned target is reset", () => {
    const fields = presetFields({ ...DEFAULT_DEVELOP_PARAMS, displayTransform: "t.x" }, [], { ...GAIN, changed: false });
    const partial = buildPartialBag({ "other.stage.y": 1 }, fields, new Set(["displayTransform"]));
    expect(partial).toEqual({ "t.x.gain": 1 });
    expect(JSON.parse(JSON.stringify(partial))).toEqual(partial);
    expect({ "t.x.gain": 3, ...partial }).toEqual({ "t.x.gain": 1 });
  });

  it("carries a transform setting the photo holds as undefined as its default", () => {
    const fields = presetFields({ ...DEFAULT_DEVELOP_PARAMS }, [], { ...GAIN, changed: false });
    expect(buildPartialBag({ "t.x.gain": undefined }, fields, new Set(["displayTransform"]))).toEqual({ "t.x.gain": 1 });
  });

  it("leaves an extension stage's field to the keys the bag holds", () => {
    const stage = { stageId: "s.y", label: "Y", scope: "global" as const, paramKeys: ["s.y.amount"], changed: false };
    const fields = presetFields({ ...DEFAULT_DEVELOP_PARAMS }, [stage], { ...GAIN, changed: false });
    expect(buildPartialBag({}, fields, new Set(["ext:s.y"]))).toEqual({});
  });

  it("carries no bag keys for a transform without params", () => {
    const field = presetFields({ ...DEFAULT_DEVELOP_PARAMS }).find((f) => f.id === "displayTransform");
    expect(field?.bagKeys).toBeUndefined();
  });
});
