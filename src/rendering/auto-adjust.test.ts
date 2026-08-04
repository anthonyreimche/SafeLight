// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { autoToneStep, autoWhiteBalanceStep, whiteBalanceStepFromLinear } from "./auto-adjust";
import type { HistogramData } from "./histogram";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import type { DevelopParams } from "@/catalog/types";

const params = (patch: Partial<DevelopParams> = {}): DevelopParams => ({
  ...DEFAULT_DEVELOP_PARAMS,
  ...patch,
});

const emptyHistogram = (): HistogramData => ({
  r: new Uint32Array(256),
  g: new Uint32Array(256),
  b: new Uint32Array(256),
  luma: new Uint32Array(256),
});

// Bins 0 and 255 are the two sRGB values that map to linear 0 and 1 exactly, so a
// channel built only from those two bins has a mean linear value equal to the
// fraction of its pixels in bin 255 — no transfer function to replicate here.
function channelWithLinearMean(mean: number, pixels: number): Uint32Array {
  const bins = new Uint32Array(256);
  bins[255] = Math.round(pixels * mean);
  bins[0] = pixels - bins[255];
  return bins;
}

function histogramWithLinearMeans(r: number, g: number, b: number, pixels = 1000): HistogramData {
  return {
    r: channelWithLinearMean(r, pixels),
    g: channelWithLinearMean(g, pixels),
    b: channelWithLinearMean(b, pixels),
    luma: new Uint32Array(256),
  };
}

function lumaHistogram(bins: Record<number, number>): HistogramData {
  const hist = emptyHistogram();
  for (const [bin, count] of Object.entries(bins)) hist.luma[Number(bin)] = count;
  return hist;
}

describe("whiteBalanceStepFromLinear", () => {
  it("reports convergence without moving the sliders on a neutral measurement", () => {
    const p = params({ temperature: 5200, tint: -14 });
    expect(whiteBalanceStepFromLinear(0.4, 0.4, 0.4, p)).toEqual({
      temperature: 5200,
      tint: -14,
      done: true,
    });
  });

  it("treats a sub-1% channel spread as converged", () => {
    const p = params();
    expect(whiteBalanceStepFromLinear(0.4, 0.4015, 0.4008, p).done).toBe(true);
    // Just over the 1% band: 0.4 vs 0.4045 against a mean of ~0.4015.
    expect(whiteBalanceStepFromLinear(0.4, 0.4045, 0.4015, p).done).toBe(false);
  });

  it("gives up on a channel with no signal rather than dividing by zero", () => {
    const p = params({ temperature: 4800, tint: 20 });
    for (const triple of [
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
      [0.5, 0.5, 0],
    ] as const) {
      expect(whiteBalanceStepFromLinear(triple[0], triple[1], triple[2], p)).toEqual({
        temperature: 4800,
        tint: 20,
        done: true,
      });
    }
  });

  it("warms a blue cast and cools a warm cast", () => {
    const p = params({ temperature: 6500, tint: 0 });
    expect(whiteBalanceStepFromLinear(0.2, 0.5, 0.9, p).temperature).toBeGreaterThan(6500);
    expect(whiteBalanceStepFromLinear(0.9, 0.5, 0.2, p).temperature).toBeLessThan(6500);
  });

  it("pushes tint toward magenta for a green cast and toward green for a magenta one", () => {
    const p = params({ temperature: 6500, tint: 0 });
    expect(whiteBalanceStepFromLinear(0.5, 0.7, 0.5, p).tint).toBeGreaterThan(0);
    expect(whiteBalanceStepFromLinear(0.5, 0.35, 0.5, p).tint).toBeLessThan(0);
  });

  it("damps toward the solution instead of jumping to it", () => {
    const p = params({ temperature: 6500, tint: 0 });
    const first = whiteBalanceStepFromLinear(0.2, 0.5, 0.9, p);
    const second = whiteBalanceStepFromLinear(
      0.2,
      0.5,
      0.9,
      params({ temperature: first.temperature, tint: first.tint }),
    );
    // Same measurement, warmer starting point: the second step lands past the first.
    expect(second.temperature).toBeGreaterThan(first.temperature);
    expect(first.done).toBe(false);
  });

  it("keeps every step inside the slider ranges and on the UI quantisation", () => {
    const extremes: Array<[number, number, number]> = [
      [0.001, 0.5, 1],
      [1, 0.5, 0.001],
      [0.001, 1, 0.001],
      [1, 0.001, 1],
      [1e-6, 1e-6, 1],
    ];
    for (const [r, g, b] of extremes) {
      for (const start of [2000, 6500, 50000]) {
        const step = whiteBalanceStepFromLinear(r, g, b, params({ temperature: start }));
        expect(step.temperature).toBeGreaterThanOrEqual(2000);
        expect(step.temperature).toBeLessThanOrEqual(50000);
        expect(step.temperature % 10).toBe(0);
        expect(step.tint).toBeGreaterThanOrEqual(-150);
        expect(step.tint).toBeLessThanOrEqual(150);
        expect(Number.isInteger(step.tint)).toBe(true);
      }
    }
  });

  it("ignores the as-shot reference: it cancels out of the solve", () => {
    // Characterises current behaviour, not desired behaviour — see the report.
    // Every gain is a ratio against the as-shot blackbody, and the current
    // temperature is expressed against the same reference, so it divides out of
    // both the Kelvin search and the tint solve.
    const p = params({ temperature: 6500, tint: 0 });
    const reference = whiteBalanceStepFromLinear(0.2, 0.5, 0.9, p);
    for (const asShot of [1500, 2000, 3200, 5500, 12000, 40000]) {
      expect(whiteBalanceStepFromLinear(0.2, 0.5, 0.9, p, asShot)).toEqual(reference);
    }
  });
});

describe("autoWhiteBalanceStep", () => {
  it("reduces to the linear solver using the histogram's mean linear values", () => {
    const p = params({ temperature: 5000, tint: 12 });
    expect(autoWhiteBalanceStep(histogramWithLinearMeans(0.25, 0.5, 1), p)).toEqual(
      whiteBalanceStepFromLinear(0.25, 0.5, 1, p),
    );
  });

  it("depends on the bin distribution, not the pixel count", () => {
    const p = params();
    expect(autoWhiteBalanceStep(histogramWithLinearMeans(0.25, 0.5, 1, 40), p)).toEqual(
      autoWhiteBalanceStep(histogramWithLinearMeans(0.25, 0.5, 1, 400000), p),
    );
  });

  it("is a no-op on an empty histogram", () => {
    const p = params({ temperature: 4200, tint: -8 });
    expect(autoWhiteBalanceStep(emptyHistogram(), p)).toEqual({
      temperature: 4200,
      tint: -8,
      done: true,
    });
  });
});

describe("autoToneStep", () => {
  it("is a no-op on an empty histogram", () => {
    const p = params({ exposure: 1.25, whites: 30 });
    expect(autoToneStep(emptyHistogram(), p)).toEqual({
      exposure: 1.25,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 30,
      blacks: 0,
      done: true,
    });
  });

  it("lifts an all-black frame: max exposure, opened whites, shadow recovery", () => {
    // median clamps to 1, so 2.2*log2(115/1) saturates the ±1.5 EV step cap;
    // every pixel is in the bottom clip bins, so shadow recovery saturates too.
    expect(autoToneStep(lumaHistogram({ 0: 1000 }), params())).toEqual({
      exposure: 1.5,
      contrast: 0,
      highlights: 0,
      shadows: 25,
      whites: 25,
      blacks: 3,
      done: false,
    });
  });

  it("pulls an all-white frame down and recovers the clipped highlights", () => {
    expect(autoToneStep(lumaHistogram({ 255: 1000 }), params())).toEqual({
      exposure: -1.5,
      contrast: 0,
      highlights: -25,
      shadows: 0,
      whites: -2, // (250 - 255) * 0.5, rounded half-up
      blacks: -25,
      done: false,
    });
  });

  it("reports done once the median, black point and white point are all on target", () => {
    // 0.25th percentile lands on bin 6, the median on 115 and the 99.75th on 250,
    // with nothing in the clipping bins.
    const hist = lumaHistogram({ 6: 100, 115: 800, 250: 100 });
    expect(autoToneStep(hist, params({ exposure: 0.4, contrast: 15 }))).toEqual({
      exposure: 0.4,
      contrast: 15,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      done: true,
    });
  });

  it("holds a uniform mid-grey frame at its white/black targets", () => {
    // Every percentile collapses onto one bin, so the white point is far below
    // target and the black point far above: not converged, and both ends open up.
    const step = autoToneStep(lumaHistogram({ 115: 1000 }), params());
    expect(step.done).toBe(false);
    expect(step.exposure).toBe(0);
    expect(step.whites).toBe(25);
    expect(step.blacks).toBe(-25);
  });

  it("clamps the accumulated result to the slider ranges", () => {
    const p = params({ exposure: 4.8, whites: 90, blacks: 90, shadows: 95 });
    const step = autoToneStep(lumaHistogram({ 0: 1000 }), p);
    expect(step.exposure).toBe(5);
    expect(step.whites).toBe(100);
    expect(step.blacks).toBe(93);
    expect(step.shadows).toBe(100);
  });

  it("never returns a parameter outside its slider range", () => {
    const cases: HistogramData[] = [
      lumaHistogram({ 0: 1000 }),
      lumaHistogram({ 255: 1000 }),
      lumaHistogram({ 0: 500, 255: 500 }),
      lumaHistogram({ 128: 1 }),
    ];
    for (const hist of cases) {
      for (const start of [-5, 0, 5]) {
        const step = autoToneStep(
          hist,
          params({
            exposure: start,
            highlights: start * 20,
            shadows: start * 20,
            whites: start * 20,
            blacks: start * 20,
          }),
        );
        expect(step.exposure).toBeGreaterThanOrEqual(-5);
        expect(step.exposure).toBeLessThanOrEqual(5);
        for (const v of [step.highlights, step.shadows, step.whites, step.blacks]) {
          expect(v).toBeGreaterThanOrEqual(-100);
          expect(v).toBeLessThanOrEqual(100);
          expect(Number.isInteger(v)).toBe(true);
        }
      }
    }
  });

  it("leaves contrast alone", () => {
    for (const hist of [lumaHistogram({ 0: 1000 }), lumaHistogram({ 255: 1000 })]) {
      expect(autoToneStep(hist, params({ contrast: 37 })).contrast).toBe(37);
    }
  });
});
