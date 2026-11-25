// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Core's provider of Masking's raster of extension mask components (#287):
// packing, asking the kinds, letting older variants of a photo go, and the
// live view drawing the last variant while the next is made. In the dom
// project, as the other stage texture provider tests are.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams, type Mask, type MaskComponent } from "@/catalog/types";
import { defaultMaskAdjustments } from "@/catalog/defaults";
import { registerProcessingStage, unregisterExtension } from "@/extensions/registry";
import {
  registerMaskComponentKind,
  unregisterMaskComponentKindsOf,
  type MaskCoverageBitmap,
  type MaskCoverageRequest,
} from "../mask-component-kinds";
import { MASK_RASTERS_KEY, frameStageBag } from "../stage-bag";
import { essentialStages, MASKS_EXTENSION_ID } from "../webgl/essential-stages.fixtures";
import { variantTextureKey } from "../webgl/stage-texture-variant";
import { getStageTextures, setStageTexture } from "./wiring";
import { needStageVariants, noteLiveStageBag, stageTextureProviderOwner } from "./stage-texture-providers";
import {
  MASK_RASTER_MAX_EDGE,
  liveMaskRasterBag,
  maskRastersRevision,
  packMaskRasters,
  startMaskRasters,
  subscribeMaskRasters,
  withoutMaskRasters,
} from "./mask-rasters";

const PHOTO = "3f2b6c1e-8d4a-4f5b-9c0e-1a2b3c4d5e6f";
const bitmap = (width: number, height: number, fill: (x: number, y: number) => number): MaskCoverageBitmap => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return { width, height, data };
};

describe("packing a raster", () => {
  it("holds one component in r8, as it came", () => {
    const tex = packMaskRasters([bitmap(4, 2, (x, y) => x + 10 * y)], [false]);
    expect(tex).toMatchObject({ width: 4, height: 2, format: "r8" });
    expect([...tex.data]).toEqual([0, 1, 2, 3, 10, 11, 12, 13]);
  });

  it("holds two to four in rgba8, a channel each in order, the rest zero", () => {
    const tex = packMaskRasters([bitmap(2, 2, () => 7), bitmap(2, 2, () => 9)], [false, false]);
    expect(tex).toMatchObject({ width: 2, height: 2, format: "rgba8" });
    expect([...tex.data.slice(0, 4)]).toEqual([7, 9, 0, 0]);
  });

  it("inverts a component in its channel, and leaves a missing one at zero, inverted or not", () => {
    const tex = packMaskRasters([bitmap(2, 2, () => 200), null, { width: 2, height: 2, data: new Uint8Array(3) }], [true, true, true]);
    expect([...tex.data.slice(0, 4)]).toEqual([55, 0, 0, 0]);
  });

  it("resamples each to the largest one's size, never past the cap, keeping its aspect", () => {
    const big = bitmap(4096, 2048, () => 255);
    const tex = packMaskRasters([bitmap(8, 4, () => 100), big], [false, false]);
    expect(tex).toMatchObject({ width: MASK_RASTER_MAX_EDGE, height: MASK_RASTER_MAX_EDGE / 2 });
    expect([...tex.data.slice(0, 4)]).toEqual([100, 255, 0, 0]);
  });

  it("keeps row 0 at source v 0", () => {
    const tex = packMaskRasters([bitmap(4, 4, (_x, y) => (y === 0 ? 255 : 0)), bitmap(2, 2, (_x, y) => (y === 0 ? 255 : 0))], [false, false]);
    expect(tex.data[0]).toBe(255);
    expect(tex.data[1]).toBeGreaterThan(100);
    expect(tex.data[(3 * 4) * 4]).toBe(0);
    expect(tex.data[(3 * 4) * 4 + 1]).toBeLessThan(100);
  });

  it("is at least 2 px a side, so the program tells it from the 1×1 stand-in", () => {
    expect(packMaskRasters([bitmap(1, 1, () => 255)], [false])).toMatchObject({ width: 2, height: 2 });
    expect(packMaskRasters([null], [false])).toMatchObject({ width: 2, height: 2 });
  });
});

const masking = essentialStages(3).find((s) => s.id === "safelight.masks.coverage")!;

const fuzzy = (id: string, values: Record<string, unknown>, invert = false): MaskComponent => ({
  id,
  kind: "extension",
  mode: "add",
  invert,
  extension: { type: "acme.fuzzy.pick", values },
});
const mask = (components: MaskComponent[]): Mask => ({
  id: "m1",
  name: "Mask 1",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components,
});
const params = (components: MaskComponent[]): DevelopParams => ({ ...DEFAULT_DEVELOP_PARAMS, masks: [mask(components)] });
const bagOf = (components: MaskComponent[]) => frameStageBag(params(components), {}, PHOTO);
const nameOf = (bag: Record<string, unknown>) => bag[MASK_RASTERS_KEY] as string;
const heldData = (name: string) => getStageTextures()[variantTextureKey(MASK_RASTERS_KEY, name)!];
const tick = () => new Promise((r) => setTimeout(r, 0));

async function frame(bag: Record<string, unknown>): Promise<string | null> {
  const lease = await needStageVariants(bag);
  lease?.release();
  return lease?.failure ?? null;
}

let asked: MaskCoverageRequest[];
let coverage: (req: MaskCoverageRequest) => Promise<MaskCoverageBitmap | null>;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  asked = [];
  coverage = async () => bitmap(4, 2, () => 128);
  startMaskRasters();
  registerProcessingStage(MASKS_EXTENSION_ID, masking);
  registerMaskComponentKind("acme.fuzzy", {
    name: "pick",
    label: "Pick",
    create: () => ({}),
    coverage: (req) => {
      asked.push(req);
      return coverage(req);
    },
  });
});

afterEach(() => {
  noteLiveStageBag({});
  for (const key of Object.keys(getStageTextures())) setStageTexture(key, null);
  unregisterMaskComponentKindsOf("acme.fuzzy");
  unregisterExtension(MASKS_EXTENSION_ID);
  vi.restoreAllMocks();
});

describe("core's raster provider", () => {
  it("provides Masking's raster under Masking's name while Masking declares it", () => {
    expect(stageTextureProviderOwner(MASK_RASTERS_KEY)).toBe(MASKS_EXTENSION_ID);
    unregisterExtension(MASKS_EXTENSION_ID);
    expect(stageTextureProviderOwner(MASK_RASTERS_KEY)).toBeUndefined();
    registerProcessingStage(MASKS_EXTENSION_ID, masking);
    expect(stageTextureProviderOwner(MASK_RASTERS_KEY)).toBe(MASKS_EXTENSION_ID);
  });

  it("packs each component's coverage, asked of its kind for the photo, into a frame's variant", async () => {
    const bag = bagOf([fuzzy("a", { seeds: [1] }, true)]);
    expect(await frame(bag)).toBeNull();
    expect(asked).toMatchObject([{ photoId: PHOTO, componentId: "a", values: { seeds: [1] } }]);
    expect(heldData(nameOf(bag))).toMatchObject({ width: 4, height: 2, format: "r8" });
    expect(heldData(nameOf(bag)).data[0]).toBe(127);
  });

  it("holds a component of a kind no one registered as nothing", async () => {
    const bag = frameStageBag(
      { ...DEFAULT_DEVELOP_PARAMS, masks: [mask([fuzzy("a", {}), { ...fuzzy("b", {}), extension: { type: "gone.kind", values: {} } }])] },
      {},
      PHOTO,
    );
    expect(await frame(bag)).toBeNull();
    expect([...heldData(nameOf(bag)).data.slice(0, 4)]).toEqual([128, 0, 0, 0]);
  });

  it("lets a photo's older variants go once a newer one is held, bar one a frame still draws with", async () => {
    const first = bagOf([fuzzy("a", { seeds: [1] })]);
    const second = bagOf([fuzzy("a", { seeds: [2] })]);
    const third = bagOf([fuzzy("a", { seeds: [3] })]);
    await frame(first);
    const pinned = await needStageVariants(second);
    await frame(third);
    await tick();
    expect(heldData(nameOf(first))).toBeUndefined();
    expect(heldData(nameOf(second))).toBeDefined();
    expect(heldData(nameOf(third))).toBeDefined();
    pinned?.release();
  });

  it("isn't waited for by a mask capture's bag", () => {
    const bag = bagOf([fuzzy("a", {})]);
    expect(withoutMaskRasters(bag)).not.toHaveProperty(MASK_RASTERS_KEY);
    expect(needStageVariants(withoutMaskRasters(bag))).toBeNull();
  });
});

describe("the live view's raster", () => {
  it("stays the photo's last one while the next is made, then moves on", async () => {
    const first = bagOf([fuzzy("a", { seeds: [1] })]);
    await frame(first);
    expect(liveMaskRasterBag(first)).toBe(first);
    let land!: (b: MaskCoverageBitmap) => void;
    coverage = () => new Promise((r) => (land = r));
    const second = bagOf([fuzzy("a", { seeds: [2] })]);
    const bumped = vi.fn();
    const stop = subscribeMaskRasters(bumped);
    const before = maskRastersRevision();
    expect(nameOf(liveMaskRasterBag(second))).toBe(nameOf(first));
    land(bitmap(4, 2, () => 1));
    await vi.waitFor(() => expect(bumped).toHaveBeenCalled());
    stop();
    expect(maskRastersRevision()).toBeGreaterThan(before);
    expect(nameOf(liveMaskRasterBag(second))).toBe(nameOf(second));
  });

  it("names the new one at once when its components changed channels", async () => {
    const first = bagOf([fuzzy("a", { seeds: [1] })]);
    await frame(first);
    liveMaskRasterBag(first);
    coverage = () => new Promise(() => {});
    const added = bagOf([fuzzy("a", { seeds: [1] }), fuzzy("b", {})]);
    expect(nameOf(liveMaskRasterBag(added))).toBe(nameOf(added));
  });

  it("is named again when a kind comes or goes", () => {
    const bumped = vi.fn();
    const stop = subscribeMaskRasters(bumped);
    unregisterMaskComponentKindsOf("acme.fuzzy");
    stop();
    expect(bumped).toHaveBeenCalled();
  });
});
