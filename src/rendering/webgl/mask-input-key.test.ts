// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The key of what the mask components compare (#287): an extension that fills
// a mask region from a "mask" capture keeps its result while the key holds.
// It follows what reaches the masks (the scene edits, the stages ahead of the
// masks anchor, the source) and nothing after them, nor the crop or geometry.

import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";
import { defaultMaskAdjustments } from "@/catalog/defaults";
import type { ProcessingStageContribution } from "@/extensions/types";
import { maskInputKey, type MaskInputs } from "./split-signature";

const stage = (id: string, phase: ProcessingStageContribution["phase"], anchor?: string): ProcessingStageContribution =>
  ({ id, name: id, phase, glsl: "", uniforms: [], ...(anchor ? { anchor } : {}) }) as ProcessingStageContribution;

const STAGES = [
  stage("acme.lens", "geometry"),
  stage("acme.denoise", "decode"),
  stage("acme.look", "scene-linear"),
  stage("acme.grade", "display-adjust"),
  { ...stage("safelight.masks.coverage", "scene-linear", "masks"), extensionId: "safelight.masks" },
];

const inputs = (over: Partial<MaskInputs> = {}): MaskInputs => ({
  params: DEFAULT_DEVELOP_PARAMS,
  bag: { "acme.denoise.amount": 1, "acme.lens.k": 0, "acme.look.amount": 0, "acme.grade.amount": 0 },
  stages: STAGES,
  asShotTemperature: 5200,
  source: "photo-a|1234",
  ...over,
});
const withParams = (p: Partial<DevelopParams>) => inputs({ params: { ...DEFAULT_DEVELOP_PARAMS, ...p } });
const withBag = (entries: Record<string, unknown>) => inputs({ bag: { ...inputs().bag, ...entries } });

describe("maskInputKey", () => {
  const key = maskInputKey(inputs());

  it("is a stable string for the same inputs", () => {
    expect(typeof key).toBe("string");
    expect(maskInputKey(inputs())).toBe(key);
    expect(maskInputKey(withParams({}))).toBe(key);
  });

  it("changes with the scene edits that reach the masks", () => {
    expect(maskInputKey(withParams({ exposure: 1 }))).not.toBe(key);
    expect(maskInputKey(withParams({ temperature: 4000 }))).not.toBe(key);
    expect(maskInputKey(withParams({ tint: 10 }))).not.toBe(key);
  });

  it("changes with a stage ahead of the masks, the source and the as-shot white balance", () => {
    expect(maskInputKey(withBag({ "acme.denoise.amount": 2 }))).not.toBe(key);
    expect(maskInputKey(inputs({ source: "photo-b|1234" }))).not.toBe(key);
    expect(maskInputKey(inputs({ asShotTemperature: 6500 }))).not.toBe(key);
  });

  it("holds through masks, the crop and geometry, display edits and anything after the masks", () => {
    const masks = [
      { id: "m1", name: "M", visible: true, invert: false, opacity: 100, adj: defaultMaskAdjustments(), panels: [], components: [] },
    ];
    expect(maskInputKey(withParams({ masks }))).toBe(key);
    expect(maskInputKey(withParams({ crop: { ...DEFAULT_DEVELOP_PARAMS.crop, x: 0.1 } }))).toBe(key);
    expect(maskInputKey(withParams({ straighten: 3 }))).toBe(key);
    expect(maskInputKey(withParams({ contrast: 30, saturation: 20 }))).toBe(key);
    expect(maskInputKey(withBag({ "acme.lens.k": 1 }))).toBe(key);
    expect(maskInputKey(withBag({ "acme.look.amount": 1 }))).toBe(key);
    expect(maskInputKey(withBag({ "acme.grade.amount": 1 }))).toBe(key);
    expect(maskInputKey(withBag({ "safelight.masks.coverage.uMaskRasters": "x" }))).toBe(key);
  });
});
