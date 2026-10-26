// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The exposure that brings a RAW's default render to its camera's brightness.
// The camera here is our own default chain at a known exposure, built from the
// TypeScript mirrors of the shader, so the answer is known in advance.

import { describe, expect, it } from "vitest";
import { baselineRefit, baselineTone } from "@/rendering/baseline-tone";
import { toneHighlights } from "@/rendering/local-tone";
import { encodeHalf } from "./half-float";
import { cameraMatchExposure, halfLumaSamples, lumaSamples } from "./camera-match";

/** The default render's luminance for scene-linear x at a camera exposure of `ev`. */
const rendered = (x: number, ev: number): number =>
  toneHighlights(2 ** ev * baselineRefit(baselineTone(x)), 0, 0, false);

/** 4096 scene levels spread evenly in stops from deep shadow to near white. */
const SCENE = Float32Array.from({ length: 4096 }, (_, i) => 0.004 * (0.9 / 0.004) ** (i / 4095));
const cameraAt = (ev: number): Float32Array => SCENE.map((x) => rendered(x, ev));

describe("cameraMatchExposure", () => {
  for (const ev of [-0.5, 0, 0.8, 1.5]) {
    it(`finds the ${ev} EV that lands the decode's tones on a camera's`, () => {
      expect(Math.abs((cameraMatchExposure(SCENE, cameraAt(ev)) ?? NaN) - ev)).toBeLessThan(0.011);
    });
  }

  // The decode and the preview are sampled at different points of the frame.
  it("compares the two images' tones, not their pixels one by one", () => {
    expect(Math.abs((cameraMatchExposure(SCENE, cameraAt(0.8).reverse()) ?? NaN) - 0.8)).toBeLessThan(0.011);
  });

  it("shrugs off the brightest tones the camera clipped where the render rolls them off", () => {
    const camera = cameraAt(0.8).map((y) => (y > 0.9 ? 1 : y));
    expect(Math.abs((cameraMatchExposure(SCENE, camera) ?? NaN) - 0.8)).toBeLessThan(0.05);
  });

  it("gives no answer for a frame with too few tones to compare", () => {
    expect(cameraMatchExposure(new Float32Array(4096).fill(0.18), new Float32Array(4096).fill(0.4))).toBeUndefined();
    expect(cameraMatchExposure(new Float32Array(4096), new Float32Array(4096))).toBeUndefined();
  });

  it("gives no answer when the camera is further off than any camera sits", () => {
    expect(cameraMatchExposure(SCENE, SCENE.map((x) => Math.min(x * 32, 1)))).toBeUndefined();
    expect(cameraMatchExposure(SCENE, cameraAt(-4))).toBeUndefined();
  });

  it("answers in hundredths of a stop", () => {
    const ev = cameraMatchExposure(SCENE, cameraAt(0.8));
    expect(ev).toBeDefined();
    expect(Math.round((ev ?? 0) * 100)).toBeCloseTo((ev ?? 0) * 100, 9);
  });
});

describe("lumaSamples", () => {
  const rgba = (pixels: [number, number, number][]): Float32Array =>
    Float32Array.from(pixels.flatMap(([r, g, b]) => [r, g, b, 1]));

  it("reads Rec.709 luminance", () => {
    expect([...lumaSamples(rgba([[1, 0, 0], [0, 1, 0], [0, 0, 1]]))].map((v) => +v.toFixed(4))).toEqual([
      0.2126, 0.7152, 0.0722,
    ]);
  });

  it("reads at most the count it is asked for, from across the frame", () => {
    const frame = rgba(Array.from({ length: 10_000 }, (_, i) => [i, i, i]));
    const samples = lumaSamples(frame, 100);
    expect(samples.length).toBeLessThanOrEqual(100);
    expect(samples.length).toBeGreaterThan(90);
    expect(samples[0]).toBeCloseTo(0, 3);
    expect(samples[samples.length - 1]).toBeGreaterThan(9_800);
  });

  it("reads a RAW cache entry's half floats the same way", () => {
    const frame = rgba(Array.from({ length: 5_000 }, (_, i) => [i / 5_000, (i % 7) / 7, 0.25]));
    const fromHalf = halfLumaSamples(encodeHalf(frame), 500);
    const fromFloat = lumaSamples(frame, 500);
    expect(fromHalf.length).toBe(fromFloat.length);
    for (let i = 0; i < fromHalf.length; i++) expect(fromHalf[i]).toBeCloseTo(fromFloat[i], 2);
  });
});
