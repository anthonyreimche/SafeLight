// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A float capture leaves the renderer as perceptual Rec.709, the display
// working values, and the worker converts it into the space the extension
// asked for with the stage conversions, signs and values above 1 included.

import { describe, expect, it } from "vitest";
import type { StageSpace } from "@/extensions/types";
import { DEFAULT_CAPTURE_MAX_EDGE, DEFAULT_CAPTURE_SPACE, measureSize, toFloatFrame } from "./float-frame";
import { toStageSpace, type Vec3 } from "./stage-space";

const TRIPLES: Vec3[] = [
  [0.5, 0.5, 0.5],
  [1.4, 0.8, 0.3],
  [-0.2, 0.6, -0.1],
  [0, 0.02, 0.0005],
  [1.9, -0.4, 1.2],
];

/** The triples as an RGBA frame, one per pixel, with `alpha`. */
function frameOf(triples: readonly Vec3[], alpha = 1): Float32Array {
  return Float32Array.from(triples.flatMap((rgb) => [...rgb, alpha]));
}

describe("toFloatFrame", () => {
  const spaces: [string, StageSpace][] = [
    ["linear Rec.709", DEFAULT_CAPTURE_SPACE],
    ["linear Rec.2020", { encoding: "linear", primaries: "rec2020" }],
    ["perceptual Rec.2020", { encoding: "perceptual", primaries: "rec2020" }],
  ];
  for (const [label, space] of spaces) {
    it(`converts each pixel as the stage conversion does, into ${label}`, () => {
      const frame = toFloatFrame(frameOf(TRIPLES), TRIPLES.length, 1, space, "pre-output");
      TRIPLES.forEach((rgb, i) => {
        const want = toStageSpace(rgb, space, "display");
        for (let ch = 0; ch < 3; ch++) {
          expect(Math.abs(frame.data[i * 4 + ch] - want[ch]), `pixel ${i} ch ${ch}`).toBeLessThan(1e-6);
        }
      });
    });
  }

  // A plain-JS extension can leave `encoding` out, which the stage conversions
  // read as perceptual for either primaries.
  it("reads a space without an encoding as the stage conversion does", () => {
    for (const space of [{ primaries: "rec2020" }, { primaries: "rec709" }] as StageSpace[]) {
      const frame = toFloatFrame(frameOf(TRIPLES), TRIPLES.length, 1, space, "pre-output");
      TRIPLES.forEach((rgb, i) => {
        const want = toStageSpace(rgb, space, "display");
        for (let ch = 0; ch < 3; ch++) {
          expect(Math.abs(frame.data[i * 4 + ch] - want[ch]), `${space.primaries} pixel ${i} ch ${ch}`).toBeLessThan(1e-6);
        }
      });
    }
  });

  it("defaults to linear Rec.709", () => {
    expect(DEFAULT_CAPTURE_SPACE).toEqual({ encoding: "linear", primaries: "rec709" });
  });

  it("leaves the identity space as it is", () => {
    const data = frameOf(TRIPLES);
    const before = data.slice();
    for (const space of [{ encoding: "perceptual" }, { encoding: "perceptual", primaries: "rec709" }] as StageSpace[]) {
      expect(toFloatFrame(data, TRIPLES.length, 1, space, "output").data).toEqual(before);
    }
  });

  it("sets alpha to 1", () => {
    for (const space of [DEFAULT_CAPTURE_SPACE, { encoding: "perceptual" } as StageSpace]) {
      const { data } = toFloatFrame(frameOf(TRIPLES, 0.25), TRIPLES.length, 1, space, "pre-output");
      expect(TRIPLES.map((_, i) => data[i * 4 + 3])).toEqual(TRIPLES.map(() => 1));
    }
  });

  it("converts in place, and wraps the frame with its size, space and point", () => {
    const data = frameOf(TRIPLES);
    const space: StageSpace = { encoding: "linear", primaries: "rec2020" };
    const frame = toFloatFrame(data, 5, 1, space, "output");
    expect(frame.data).toBe(data);
    expect(frame).toMatchObject({ width: 5, height: 1, space, point: "output" });
  });
});

// A live frame at fit is the Develop render resolution, 4096 px by default and
// about 180 MB of floats, so a capture is drawn at a measuring edge instead.
describe("measureSize", () => {
  it("caps the long edge and rounds the other side scaled with it", () => {
    // 2731 × 1280 / 4096 = 853.44, and 2732 × 1280 / 4096 = 853.75
    expect(measureSize(4096, 2731, 1280)).toEqual({ width: 1280, height: 853 });
    expect(measureSize(4096, 2732, 1280)).toEqual({ width: 1280, height: 854 });
  });

  it("keeps a portrait frame portrait", () => {
    expect(measureSize(2731, 4096, 1280)).toEqual({ width: 853, height: 1280 });
  });

  it("never scales a frame up", () => {
    expect(measureSize(800, 533, 1280)).toEqual({ width: 800, height: 533 });
    expect(measureSize(1280, 853, 1280)).toEqual({ width: 1280, height: 853 });
  });

  it("keeps the whole frame for Infinity", () => {
    expect(measureSize(8192, 5461, Infinity)).toEqual({ width: 8192, height: 5461 });
  });

  it("caps at 1280 for an edge that isn't a positive number", () => {
    expect(DEFAULT_CAPTURE_MAX_EDGE).toBe(1280);
    for (const maxEdge of [Number.NaN, 0, -640, -Infinity, undefined, "2000"]) {
      expect(measureSize(4096, 2731, maxEdge as number), String(maxEdge)).toEqual({ width: 1280, height: 853 });
    }
  });

  it("floors a fractional edge", () => {
    expect(measureSize(4096, 2731, 1280.9)).toEqual({ width: 1280, height: 853 });
  });

  it("keeps each side at least 1 px", () => {
    expect(measureSize(100000, 10, 1280)).toEqual({ width: 1280, height: 1 });
    expect(measureSize(10, 100000, 1280)).toEqual({ width: 1, height: 1280 });
    expect(measureSize(4096, 2731, 0.5)).toEqual({ width: 1, height: 1 });
  });
});
