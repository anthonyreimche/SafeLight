// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The raster of a photo's extension mask components (#287): every frame of the
// photo names the variant of Masking's uMaskRasters made from what the raster
// holds, so exports, thumbnails and headless frames wait for it and the live
// view asks for it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams, type Mask, type MaskComponent } from "@/catalog/types";
import { defaultMaskAdjustments } from "@/catalog/defaults";
import { registerProcessingStage, unregisterExtension } from "@/extensions/registry";
import {
  refreshMaskCoverage,
  registerMaskComponentKind,
  unregisterMaskComponentKindsOf,
} from "./mask-component-kinds";
import { MASK_RASTERS_KEY, frameStageBag, maskRasterVariant } from "./stage-bag";
import { essentialStages, MASKS_EXTENSION_ID } from "./webgl/essential-stages.fixtures";

const PHOTO = "3f2b6c1e-8d4a-4f5b-9c0e-1a2b3c4d5e6f";
const OTHER = "9a8b7c6d-1234-4f5b-9c0e-1a2b3c4d5e6f";

const masking = (line: 1 | 2 | 3) => essentialStages(line).find((s) => s.id === "safelight.masks.coverage")!;

const fuzzy = (id: string, values: Record<string, unknown> = { seeds: [] }, over: Partial<MaskComponent> = {}): MaskComponent => ({
  id,
  kind: "extension",
  mode: "add",
  invert: false,
  extension: { type: "acme.fuzzy.pick", values },
  ...over,
});

const mask = (id: string, components: MaskComponent[]): Mask => ({
  id,
  name: id,
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components,
});

const withMasks = (masks: Mask[]): DevelopParams => ({ ...DEFAULT_DEVELOP_PARAMS, masks });
const named = (params: DevelopParams, photoId: string | null = PHOTO) =>
  frameStageBag(params, {}, photoId ?? undefined)[MASK_RASTERS_KEY] as string | undefined;

beforeEach(() => {
  registerProcessingStage(MASKS_EXTENSION_ID, masking(3));
  registerMaskComponentKind("acme.fuzzy", { name: "pick", label: "Pick", create: () => ({}), coverage: async () => null });
});
afterEach(() => {
  unregisterMaskComponentKindsOf("acme.fuzzy");
  unregisterExtension(MASKS_EXTENSION_ID);
});

describe("the mask raster a frame names", () => {
  it("is a variant name for a photo with extension components", () => {
    const name = named(withMasks([mask("m1", [fuzzy("a")])]));
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("is none without extension components, without a photo, or without Masking's raster", () => {
    expect(named(withMasks([mask("m1", [])]))).toBeUndefined();
    expect(named(withMasks([mask("m1", [fuzzy("a")])]), null)).toBeUndefined();
    unregisterExtension(MASKS_EXTENSION_ID);
    registerProcessingStage(MASKS_EXTENSION_ID, masking(2));
    expect(named(withMasks([mask("m1", [fuzzy("a")])]))).toBeUndefined();
  });

  it("files what the raster holds: the photo and its components in channel order, inversion included", () => {
    const params = withMasks([
      mask("m1", [fuzzy("a", { seeds: [1] })]),
      mask("m2", [fuzzy("b", { seeds: [2] }, { invert: true }), fuzzy("c"), fuzzy("d"), fuzzy("e")]),
    ]);
    expect(maskRasterVariant(named(params)!)).toEqual({
      photoId: PHOTO,
      components: [
        { id: "a", type: "acme.fuzzy.pick", values: { seeds: [1] }, invert: false },
        { id: "b", type: "acme.fuzzy.pick", values: { seeds: [2] }, invert: true },
        { id: "c", type: "acme.fuzzy.pick", values: { seeds: [] }, invert: false },
        { id: "d", type: "acme.fuzzy.pick", values: { seeds: [] }, invert: false },
      ],
    });
  });

  it("changes with the photo, a component's values, its inversion and its kind's generation", () => {
    const base = withMasks([mask("m1", [fuzzy("a")])]);
    const name = named(base);
    expect(named(withMasks([mask("m1", [fuzzy("a")])]))).toBe(name);
    expect(named(base, OTHER)).not.toBe(name);
    expect(named(withMasks([mask("m1", [fuzzy("a", { seeds: [1] })])]))).not.toBe(name);
    expect(named(withMasks([mask("m1", [fuzzy("a", undefined, { invert: true })])]))).not.toBe(name);
    refreshMaskCoverage("acme.fuzzy", "pick");
    expect(named(base)).not.toBe(name);
  });

  it("doesn't change with the rest of the edit", () => {
    const masks = [mask("m1", [fuzzy("a")])];
    const name = named(withMasks(masks));
    expect(named({ ...withMasks(masks), exposure: 1.5 })).toBe(name);
    expect(named(withMasks([{ ...masks[0], opacity: 40 }]))).toBe(name);
  });

  it("changes when a kind registers, as a component of an unregistered kind holds nothing", () => {
    unregisterMaskComponentKindsOf("acme.fuzzy");
    const params = withMasks([mask("m1", [fuzzy("a")])]);
    const without = named(params);
    expect(without).toBeDefined();
    registerMaskComponentKind("acme.fuzzy", { name: "pick", label: "Pick", create: () => ({}), coverage: async () => null });
    expect(named(params)).not.toBe(without);
  });

  it("leaves a name the photo's bag holds as it is", () => {
    const bag = frameStageBag(withMasks([mask("m1", [fuzzy("a")])]), { [MASK_RASTERS_KEY]: "mine" }, PHOTO);
    expect(bag[MASK_RASTERS_KEY]).toBe("mine");
  });
});
