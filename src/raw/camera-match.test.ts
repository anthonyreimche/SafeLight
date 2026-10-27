// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The exposure and shadows lift that bring a RAW's default render to its
// camera's tones. The camera here is our own default chain at a known exposure
// and Shadows, built from the TypeScript mirrors of the shader, so the answer is
// known in advance.

import { describe, expect, it } from "vitest";
import { baselineRefit, baselineTone } from "@/rendering/baseline-tone";
import { toneHighlights, toneShadows } from "@/rendering/local-tone";
import { encodeHalf } from "./half-float";
import { cameraMatch, halfLumaSamples, lumaSamples } from "./camera-match";

/** The default render's luminance for scene-linear x at a camera exposure of
 *  `ev` and Shadows of `shadows` (slider units). */
const rendered = (x: number, ev: number, shadows = 0): number =>
  toneShadows(toneHighlights(2 ** ev * baselineRefit(baselineTone(x)), 0, 0, false), shadows / 100);

/** 4096 scene levels spread evenly in stops from deep shadow to near white. */
const SCENE = Float32Array.from({ length: 4096 }, (_, i) => 0.004 * (0.9 / 0.004) ** (i / 4095));
const cameraAt = (ev: number, shadows = 0): Float32Array => SCENE.map((x) => rendered(x, ev, shadows));
const exposureOf = (scene: Float32Array, camera: Float32Array): number => cameraMatch(scene, camera)?.exposure ?? NaN;

describe("cameraMatch", () => {
  for (const ev of [-0.5, 0, 0.8, 1.5]) {
    it(`finds the ${ev} EV that lands the decode's tones on a camera's`, () => {
      expect(Math.abs(exposureOf(SCENE, cameraAt(ev)) - ev)).toBeLessThan(0.011);
    });
  }

  // Active D-Lighting and its kin expose less and lift the shadows back up. One
  // exposure can only meet such a camera in the middle, with its highlights a
  // quarter stop too bright, as a Nikon Z 6II's were.
  for (const [ev, shadows] of [[1.1, 55], [0.6, 100], [1.5, 30]]) {
    it(`finds a camera's ${ev} EV and its shadows lifted ${shadows}`, () => {
      const match = cameraMatch(SCENE, cameraAt(ev, shadows));
      expect(Math.abs((match?.exposure ?? NaN) - ev)).toBeLessThan(0.03);
      expect(Math.abs((match?.shadows ?? NaN) - shadows)).toBeLessThanOrEqual(3);
    });
  }

  it("lifts no shadows for a camera that doesn't", () => {
    expect(cameraMatch(SCENE, cameraAt(0.8))?.shadows).toBe(0);
  });

  // The decode and the preview are sampled at different points of the frame.
  it("compares the two images' tones, not their pixels one by one", () => {
    expect(Math.abs(exposureOf(SCENE, cameraAt(0.8).reverse()) - 0.8)).toBeLessThan(0.011);
  });

  it("shrugs off the brightest tones the camera clipped where the render rolls them off", () => {
    const camera = cameraAt(0.8).map((y) => (y > 0.9 ? 1 : y));
    expect(Math.abs(exposureOf(SCENE, camera) - 0.8)).toBeLessThan(0.05);
  });

  it("gives no answer for a frame with too few tones to compare", () => {
    expect(cameraMatch(new Float32Array(4096).fill(0.18), new Float32Array(4096).fill(0.4))).toBeUndefined();
    expect(cameraMatch(new Float32Array(4096), new Float32Array(4096))).toBeUndefined();
  });

  it("gives no answer when the camera is further off than any camera sits", () => {
    expect(cameraMatch(SCENE, SCENE.map((x) => Math.min(x * 32, 1)))).toBeUndefined();
    expect(cameraMatch(SCENE, cameraAt(-4))).toBeUndefined();
  });

  it("answers in hundredths of a stop and whole Shadows steps", () => {
    const match = cameraMatch(SCENE, cameraAt(1.1, 55));
    expect(match).toBeDefined();
    expect(Math.round((match?.exposure ?? 0) * 100)).toBeCloseTo((match?.exposure ?? 0) * 100, 9);
    expect(Number.isInteger(match?.shadows)).toBe(true);
  });
});

describe("lumaSamples", () => {
  /** A frame of width × height whose pixel at (x, y) is grey `level(x, y)`. */
  const frame = (width: number, height: number, level: (x: number, y: number) => number) => {
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) data.set([level(x, y), level(x, y), level(x, y), 1], (y * width + x) * 4);
    }
    return { data, width, height };
  };

  it("reads Rec.709 luminance", () => {
    const data = Float32Array.from([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    expect([...lumaSamples({ data, width: 3, height: 1 }, 3)].map((v) => +v.toFixed(4))).toEqual([0.2126, 0.7152, 0.0722]);
  });

  it("reads a grid of the side it is asked for, from across the frame", () => {
    const samples = lumaSamples(frame(100, 50, (x, y) => x + 100 * y), 10);
    expect(samples.length).toBe(100);
    expect(samples[0]).toBe(5 + 100 * 2);
    expect(samples[99]).toBe(95 + 100 * 47);
  });

  // A frame read at a flat stride close to half its width is read down two
  // columns: a 3072-wide RAW cache entry gave a Nikon Z 6II's sunlit rocks a
  // camera match of +2.46 EV and no lift, against +1.21 EV and +74 from the
  // whole frame.
  it("reads every column, whatever the frame's width", () => {
    const samples = lumaSamples(frame(4, 2048, (x) => (x % 2 ? 0.4 : 0.1)));
    expect(samples.filter((v) => v > 0.3).length / samples.length).toBeCloseTo(0.5, 2);
  });

  it("reads a RAW cache entry's half floats the same way", () => {
    const f = frame(300, 200, (x, y) => (x * y) / 60_000);
    const fromHalf = halfLumaSamples({ data: encodeHalf(f.data), width: f.width, height: f.height });
    const fromFloat = lumaSamples(f);
    expect(fromHalf.length).toBe(fromFloat.length);
    for (let i = 0; i < fromHalf.length; i++) expect(fromHalf[i]).toBeCloseTo(fromFloat[i], 2);
  });
});
