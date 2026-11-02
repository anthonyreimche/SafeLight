// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photo's geometry as core reads it from the geometry stage's derived
// values: the region of the transformed image a frame shows, and the matrix
// from the transformed image to the source, which core finishes for the
// image's aspect (only known where the image is decoded).

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import {
  WHOLE_IMAGE,
  geometryKeys,
  imageGeometry,
  imageSpaceMatrix,
  isImageSpaceMatrix,
  regionOutputSize,
  squareBasis,
} from "./geometry";
import { mat3Apply, mat3Mul, type Mat3 } from "./transform";

const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const rot = (deg: number): Mat3 => {
  const t = (deg * Math.PI) / 180;
  return [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];
};
const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 12));

describe("imageSpaceMatrix", () => {
  it("is the identity for identity parts, whatever the aspect", () => {
    close(imageSpaceMatrix({ square: I, normalized: I }, 1.5), I);
  });

  it("acts in the square basis: a rotation turns about the centre in true proportions", () => {
    const aspect = 2;
    const m = imageSpaceMatrix({ square: rot(90), normalized: I }, aspect);
    const [A, Ainv] = squareBasis(aspect);
    close(m, mat3Mul(Ainv, mat3Mul(rot(90), A)));
    const centre = mat3Apply(m, 0.5, 0.5);
    expect(centre.x).toBeCloseTo(0.5, 12);
    expect(centre.y).toBeCloseTo(0.5, 12);
    // A quarter turn takes the right edge's middle, half a width from the
    // centre, to half a width below it: in height units, the aspect times more.
    const edge = mat3Apply(m, 1, 0.5);
    expect(edge.x).toBeCloseTo(0.5, 12);
    expect(edge.y).toBeCloseTo(0.5 + 0.5 * aspect, 12);
  });

  it("applies the normalized part first", () => {
    const shift: Mat3 = [1, 0, 0.1, 0, 1, -0.2, 0, 0, 1];
    const m = imageSpaceMatrix({ square: I, normalized: shift }, 1.25);
    const p = mat3Apply(m, 0.3, 0.6);
    expect(p.x).toBeCloseTo(0.4, 12);
    expect(p.y).toBeCloseTo(0.4, 12);
  });

  it("knows a value it can finish", () => {
    expect(isImageSpaceMatrix({ square: I, normalized: I })).toBe(true);
    expect(isImageSpaceMatrix({ square: I })).toBe(false);
    expect(isImageSpaceMatrix(I)).toBe(false);
    expect(isImageSpaceMatrix({ square: [1, 2], normalized: I })).toBe(false);
  });
});

describe("regionOutputSize", () => {
  it("is the region's own pixels, the long edge capped", () => {
    expect(regionOutputSize(6000, 4000, WHOLE_IMAGE, 10000)).toEqual({ width: 6000, height: 4000 });
    expect(regionOutputSize(6000, 4000, { x: 0, y: 0, width: 0.5, height: 0.5 }, 10000)).toEqual({ width: 3000, height: 2000 });
    expect(regionOutputSize(6000, 4000, WHOLE_IMAGE, 1500)).toEqual({ width: 1500, height: 1000 });
    expect(regionOutputSize(10, 10, { x: 0, y: 0, width: 0.001, height: 0.001 }, 100)).toEqual({ width: 1, height: 1 });
  });
});

const geometryStage = (over: Partial<ProcessingStageContribution> = {}): ProcessingStageContribution => ({
  id: "safelight.crop.geometry",
  name: "Crop & Straighten",
  phase: "geometry",
  glsl: "",
  uniforms: [
    { key: "uCrop", glslType: "vec4", default: [0, 0, 1, 1] },
    { key: "uInvTransform", glslType: "mat3", space: "image", default: I },
  ],
  geometry: { region: "uCrop", inverse: "uInvTransform" },
  ...over,
});

describe("the geometry stage", () => {
  it("is the stage that names its region and matrix, keyed as the bag holds them", () => {
    const other: ProcessingStageContribution = { id: "acme.look", name: "Look", phase: "effects", glsl: "", uniforms: [] };
    expect(geometryKeys([other, geometryStage()])).toEqual({
      region: "safelight.crop.geometry.uCrop",
      inverse: "safelight.crop.geometry.uInvTransform",
    });
    expect(geometryKeys([other])).toBeNull();
  });

  it("gives the region and both matrices for the image's aspect", () => {
    const keys = geometryKeys([geometryStage()])!;
    const bag = {
      [keys.region]: [0.1, 0.2, 0.5, 0.6],
      [keys.inverse]: { square: rot(10), normalized: I },
    };
    const g = imageGeometry(bag, keys, 1.5);
    expect(g.region).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 });
    close(g.inverse, imageSpaceMatrix({ square: rot(10), normalized: I }, 1.5));
    close(mat3Mul(g.forward, g.inverse), I);
  });

  it("shows the whole image unchanged without a geometry stage or its values", () => {
    for (const g of [imageGeometry({}, null, 1.5), imageGeometry({}, geometryKeys([geometryStage()]), 1.5)]) {
      expect(g.region).toEqual(WHOLE_IMAGE);
      close(g.inverse, I);
      close(g.forward, I);
    }
  });
});
