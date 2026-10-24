// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Soft proofing on the real renderer. With a proof space set, a version 3
// screen frame is gamut-mapped into it (the export's space) and then shown on
// the display: the colours the export will hold, as this screen shows them.
// Frames with no proof, version 1 and 2 frames and export frames stay as they
// were.

import { describe, expect, it } from "vitest";
import { mat3Invert } from "../transform";
import { OUT_SPACE_CODE, outMatrix, type ColorSpaceId } from "../color-space";
import { outputPixel } from "../output-map";
import { apply3, decodePerceptual, encodePerceptual, type Vec3 } from "../stage-space";
import type { WebGLRenderer } from "./renderer";
import {
  OPEN_PROBE, adobeDisplay, each, expectColour, floatImage, identityParams, patchPixel, toHalf, withRenderer,
  worstDifference, type Frame,
} from "./webgl.test-support";

const P3 = outMatrix("display-p3");

// slOutput reads the source as perceptual values, so the scene holds them encoded.
const PATCHES = {
  // Inside Display P3 and outside sRGB, by more than a JND.
  p3Green: each(apply3(mat3Invert(P3), [0.05, 0.75, 0.1]), encodePerceptual),
  // Past sRGB's boundary by the blue primary sRGB and Display P3 share, where
  // mapping the proofed colour again would compress it a second time.
  sharedBlue: [0.05, -0.1, 1],
  inGamut: [0.6, 0.45, 0.4],
  wideGreen: [-0.8, 1, 0],
  // Outside ProPhoto as well.
  pastProPhoto: [-1, 1, -1],
  overRange: [2.5, 1.2, 0.6],
} satisfies Record<string, Vec3>;
type Patch = keyof typeof PATCHES;
const NAMES = Object.keys(PATCHES) as Patch[];
const SCENE = floatImage(NAMES.length * 4, 4, (x) => PATCHES[NAMES[Math.floor(x / 4)]]);

const GREY: Vec3 = [0.5, 0.5, 0.5];
const GAMUT_WARNING = 4;

function onScene(processVersion: number, fn: (r: WebGLRenderer) => void): void {
  withRenderer({ stages: [], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
    r.setImage(SCENE);
    r.setParams(identityParams({ processVersion }));
    r.setDisplaySpace("display-p3");
    fn(r);
  });
}

function show(r: WebGLRenderer, proof: ColorSpaceId | null, clipping = 0): Frame {
  r.setProofSpace(proof);
  r.setShowClipping(clipping);
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

const pixel = (f: Frame, patch: Patch): Vec3 => patchPixel(f, NAMES.indexOf(patch));

describe("soft proofing", () => {
  // Held to the sRGB frame converted into Display P3, so a proofed frame
  // encoded for any other target fails it.
  it("shows an sRGB proof on a Display P3 screen as the sRGB frame, converted", () => {
    onScene(3, (r) => {
      r.setDisplaySpace("srgb");
      const srgb = show(r, null);
      r.setDisplaySpace("display-p3");
      const proofed = show(r, "srgb");
      expect(worstDifference(proofed, show(r, null)), "the proof shows").toBeGreaterThan(0.02);
      for (const patch of NAMES) {
        const converted = each(apply3(P3, each(pixel(srgb, patch), decodePerceptual)), encodePerceptual);
        expectColour(pixel(proofed, patch), converted, patch, 1 / 255);
      }
    });
  });

  it("leaves a frame with the proof off as one never proofed", () => {
    onScene(3, (r) => {
      const never = show(r, null);
      show(r, "srgb");
      expect(worstDifference(show(r, null), never)).toBe(0);
    });
  });

  // Most colours past ProPhoto lie past Rec.2020 too, where the display's map
  // puts them on its boundary with or without the proof's, so this mostly
  // holds the proof's matrices to the twin's.
  it("matches the TypeScript twin for a ProPhoto proof on a Display P3 screen", () => {
    onScene(3, (r) => {
      const proofed = show(r, "prophoto-rgb");
      for (const patch of NAMES) {
        const scene = each(PATCHES[patch], toHalf);
        const want = outputPixel(scene, P3, OUT_SPACE_CODE["display-p3"], outMatrix("prophoto-rgb"));
        expectColour(pixel(proofed, patch), want, patch, 2e-3);
      }
    });
  });

  it("leaves a version 2 frame as it was", () => {
    onScene(2, (r) => expect(worstDifference(show(r, "srgb"), show(r, null))).toBe(0));
  });

  // Spec D7: the warning shows what the proof and the display's map moved together.
  it("warns of a colour the proof moves, though the display holds it", () => {
    onScene(3, (r) => {
      const unproofed = show(r, null, GAMUT_WARNING);
      expect(pixel(unproofed, "p3Green")).toEqual(pixel(show(r, null), "p3Green"));
      const proofed = show(r, "srgb", GAMUT_WARNING);
      expectColour(pixel(proofed, "p3Green"), GREY, "p3Green", 2e-3);
      expect(pixel(proofed, "inGamut")).toEqual(pixel(show(r, "srgb"), "inGamut"));
    });
  });

  it("gives way to an export space", () => {
    onScene(3, (r) => {
      r.setOutputColorSpace("adobe-rgb");
      expect(worstDifference(show(r, "srgb"), show(r, null))).toBe(0);
    });
  });

  // A Linux monitor profile is the display then, so the proof is shown in it.
  it("shows the proof through a monitor profile", () => {
    onScene(3, (r) => {
      r.setMonitorTransform(adobeDisplay());
      const plain = show(r, null);
      const proofed = show(r, "srgb");
      const moved = pixel(proofed, "p3Green").map((v, ch) => Math.abs(v - pixel(plain, "p3Green")[ch]));
      expect(Math.max(...moved)).toBeGreaterThan(0.02);
      expectColour(pixel(proofed, "inGamut"), pixel(plain, "inGamut"), "inGamut", 1e-3);
    });
  });
});
