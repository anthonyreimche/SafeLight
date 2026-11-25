// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// #287. A float capture at "mask" is the colour the mask components compare
// over the whole uncropped source, in source texels: row 0 is source row 0
// (source v 0, a brush dab's y), whatever the crop. And Masking's line 3 reads
// an extension component from its channel of the raster core packs, nothing
// at all while no raster is held, not even through the stand-in's alpha.

import { describe, expect, it } from "vitest";
import type { Mask, MaskComponent } from "@/catalog/types";
import { defaultMaskAdjustments } from "@/catalog/defaults";
import type { StageTextureData } from "@/extensions/types";
import {
  LINEAR_PROBE_PIPELINE,
  basicStagesFor,
  cropStages,
  floatImage,
  identityParams,
  masksStagesFor,
  pixelAt,
  withRenderer,
  type Frame,
} from "./webgl.test-support";

const V3 = { processVersionCap: 3, pipeline: LINEAR_PROBE_PIPELINE } as const;
const RED = [0.6, 0.05, 0.05] as const;
const BLUE = [0.05, 0.05, 0.6] as const;
const GREEN = [0.05, 0.6, 0.05] as const;

// 16×8: the top half red but for a green top-left corner, the bottom half blue.
const SOURCE = floatImage(16, 8, (x, y) => (y < 4 ? (x < 4 ? GREEN : RED) : BLUE));

const dominant = (rgb: readonly number[]): number => rgb.indexOf(Math.max(...rgb));

function maskFrame(maxEdge?: number): Frame {
  return withRenderer({ stages: [...cropStages(), ...basicStagesFor(3)], ...V3 }, (r) => {
    r.setImage(SOURCE);
    r.setParams(identityParams({ processVersion: 3, crop: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, straighten: 4 }));
    const frame = r.readFloatFrame("mask", maxEdge);
    if (!frame) throw new Error("readFloatFrame returned null");
    return frame;
  });
}

describe('capture point "mask"', () => {
  it("is the whole source, its rows the source's, whatever the crop", () => {
    const frame = maskFrame();
    expect([frame.width, frame.height]).toEqual([16, 8]);
    expect(dominant(pixelAt(frame, 1, 1))).toBe(1);
    expect(dominant(pixelAt(frame, 10, 1))).toBe(0);
    expect(dominant(pixelAt(frame, 10, 6))).toBe(2);
    expect(dominant(pixelAt(frame, 1, 6))).toBe(2);
  });

  it("is read at most maxEdge on its long edge", () => {
    const frame = maskFrame(8);
    expect([frame.width, frame.height]).toEqual([8, 4]);
    expect(dominant(pixelAt(frame, 6, 0))).toBe(0);
    expect(dominant(pixelAt(frame, 6, 3))).toBe(2);
  });
});

const RASTERS = "safelight.masks.coverage.uMaskRasters";

const extension = (id: string): MaskComponent => ({
  id,
  kind: "extension",
  mode: "add",
  invert: false,
  extension: { type: "acme.fuzzy.pick", values: {} },
});

const brightened = (components: MaskComponent[]): Mask => ({
  id: "m1",
  name: "Mask 1",
  visible: true,
  invert: false,
  opacity: 100,
  adj: { ...defaultMaskAdjustments(), exposure: 80 },
  panels: [],
  components,
});

const GREY = floatImage(16, 8, () => [0.1, 0.1, 0.1]);

function developed(masks: Mask[], bag: Record<string, unknown>, textures: Record<string, StageTextureData>): Frame {
  return withRenderer({ stages: [...basicStagesFor(3), ...masksStagesFor(3)], ...V3 }, (r) => {
    r.setImage(GREY);
    r.setStageTextures(textures);
    r.setContributedParams(bag);
    r.setParams(identityParams({ processVersion: 3, masks }));
    const frame = r.readFloatFrame("pre-output");
    if (!frame) throw new Error("readFloatFrame returned null");
    return frame;
  });
}

// The left half covered in channel `channel` of a 16×8 rgba8 raster.
function leftHalf(channel: number): StageTextureData {
  const data = new Uint8Array(16 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) data[(y * 16 + x) * 4 + channel] = 255;
  return { data, width: 16, height: 8, format: "rgba8", version: 1 };
}

describe("an extension mask component on line 3", () => {
  const plain = developed([], {}, {});
  const level = pixelAt(plain, 4, 4)[1];

  it("covers where its channel of the raster does", () => {
    const four = ["a", "b", "c", "d"].map(extension);
    const frame = developed([brightened(four)], { [RASTERS]: "v1" }, { [`${RASTERS}#v1`]: leftHalf(3) });
    expect(pixelAt(frame, 4, 4)[1]).toBeGreaterThan(level * 2);
    expect(pixelAt(frame, 12, 4)[1]).toBeCloseTo(level, 3);
  });

  it("covers nothing while no raster is held, the fourth channel included", () => {
    const four = ["a", "b", "c", "d"].map(extension);
    const frame = developed([brightened(four)], { [RASTERS]: "missing" }, {});
    expect(pixelAt(frame, 4, 4)[1]).toBeCloseTo(level, 3);
    expect(pixelAt(frame, 12, 4)[1]).toBeCloseTo(level, 3);
  });
});
