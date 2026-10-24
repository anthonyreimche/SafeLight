// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The gamut warning, bit 2 of the clipping overlay. On a version 3 photo it
// paints 50% grey, Photoshop's convention, where the output moves a colour by
// more than OkLab's JND; the shadow and highlight warnings win over it.
// Version 1 and 2 programs never test the bit.

import { describe, expect, it } from "vitest";
import { DEFAULT_MASK_PANELS, defaultMaskAdjustments, type Mask } from "@/catalog/types";
import { OUT_SPACE_CODE, outMatrix } from "../color-space";
import { JND, gamutShift, outputPixel } from "../output-map";
import { REC2020_TO_REC709, apply3, encodePerceptual, type Vec3 } from "../stage-space";
import type { WebGLRenderer } from "./renderer";
import {
  OPEN_PROBE, each, expectColour, floatImage, identityParams, patchPixel, toHalf, withRenderer, worstDifference,
  type Frame,
} from "./webgl.test-support";

const fromRec2020 = (rgb: Vec3): Vec3 => each(apply3(REC2020_TO_REC709, rgb), encodePerceptual);

// slOutput reads the source as perceptual values, so the scene holds them encoded.
const PATCHES = {
  rec2020Green: fromRec2020([0, 0.5, 0]),
  inGamut: [0.6, 0.45, 0.4],
  justOutside: [0.8, 0.3, -0.2],
  // Outside sRGB, but mapped by less than a JND.
  slightlyOutside: [0.8, 0.3, -0.1],
  pastWhite: fromRec2020([0, 1, 0]),
  belowBlack: [-0.1, -0.1, -0.1],
} satisfies Record<string, Vec3>;
type Patch = keyof typeof PATCHES;
const NAMES = Object.keys(PATCHES) as Patch[];
const SCENE = floatImage(NAMES.length * 4, 4, (x) => PATCHES[NAMES[Math.floor(x / 4)]]);

const GREY: Vec3 = [0.5, 0.5, 0.5];
const SHADOW: Vec3 = [0.2, 0.3, 1];
const HIGHLIGHT: Vec3 = [1, 0.2, 0.2];
const ALL_WARNINGS = 7;

/** A mask over the whole frame: inverted, with no components. */
const WHOLE_FRAME: Mask = {
  id: "whole", name: "Whole frame", visible: true, invert: true, opacity: 100,
  adj: defaultMaskAdjustments(), panels: [...DEFAULT_MASK_PANELS], components: [],
};

function onScene(processVersion: number, fn: (r: WebGLRenderer) => void, masks: Mask[] = []): void {
  withRenderer({ stages: [], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
    r.setImage(SCENE);
    r.setParams(identityParams({ processVersion, masks }));
    fn(r);
  });
}

function capture(r: WebGLRenderer, clipping: number): Frame {
  r.setShowClipping(clipping);
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

const pixel = (f: Frame, patch: Patch): Vec3 => patchPixel(f, NAMES.indexOf(patch));
const shift = (patch: Patch): number => gamutShift(each(PATCHES[patch], toHalf), outMatrix("srgb"));
const normal = (patch: Patch): Vec3 => outputPixel(each(PATCHES[patch], toHalf), outMatrix("srgb"), OUT_SPACE_CODE.srgb);
const isGrey = (rgb: Vec3): boolean => rgb.every((v) => Math.abs(v - 0.5) < 0.05);

describe("the gamut warning", () => {
  it("brackets the JND with its patches", () => {
    for (const patch of ["rec2020Green", "justOutside", "pastWhite", "belowBlack"] as const) {
      expect(shift(patch), patch).toBeGreaterThan(JND);
    }
    expect(shift("inGamut")).toBe(0);
    expect(shift("slightlyOutside")).toBeGreaterThan(0);
    expect(shift("slightlyOutside")).toBeLessThan(JND);
  });

  it("paints a version 3 colour the output moves by more than a JND grey", () => {
    onScene(3, (r) => {
      const warned = capture(r, 4);
      const plain = capture(r, 0);
      for (const patch of ["rec2020Green", "justOutside", "pastWhite", "belowBlack"] as const) {
        expectColour(pixel(warned, patch), GREY, patch);
      }
      for (const patch of ["inGamut", "slightlyOutside"] as const) {
        expectColour(pixel(warned, patch), normal(patch), patch);
        expect(pixel(warned, patch), patch).toEqual(pixel(plain, patch));
      }
    });
  });

  it("paints nothing with the bit clear", () => {
    onScene(3, (r) => {
      const plain = capture(r, 0);
      for (const patch of ["rec2020Green", "inGamut"] as const) {
        expect(isGrey(pixel(plain, patch)), patch).toBe(false);
        expectColour(pixel(plain, patch), normal(patch), patch);
      }
    });
  });

  it("gives way to the shadow and highlight warnings", () => {
    onScene(3, (r) => {
      const all = capture(r, ALL_WARNINGS);
      expectColour(pixel(all, "belowBlack"), SHADOW, "belowBlack");
      expectColour(pixel(all, "pastWhite"), HIGHLIGHT, "pastWhite");
      expectColour(pixel(all, "rec2020Green"), GREY, "rec2020Green");
      expectColour(pixel(all, "inGamut"), normal("inGamut"), "inGamut");
    });
  });

  // A hovered mask's tint shows only outside the clipping overlay, so the
  // frames also tell whether bit 2 alone sent an older program into it.
  for (const processVersion of [1, 2]) {
    it(`leaves a version ${processVersion} frame as it was`, () => {
      onScene(processVersion, (r) => {
        const untinted = capture(r, 0);
        r.setMaskViz(0, [1, 0, 1], 1);
        expect(worstDifference(capture(r, 0), untinted), "the tint shows").toBeGreaterThan(0.1);
        expect(worstDifference(capture(r, 4), capture(r, 0))).toBe(0);
        expect(worstDifference(capture(r, ALL_WARNINGS), capture(r, 3))).toBe(0);
      }, [WHOLE_FRAME]);
    });
  }
});
