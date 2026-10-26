// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The native-resolution centre sample an extension reads through
// api.develop.readSourceSample: cut from the decoded frame before the upload
// cap, kept as half floats, handed back as floats.

import { describe, expect, it } from "vitest";
import { SOURCE_SAMPLE_EDGE, cutSourceSample, sampleRect, unpackSourceSample } from "./source-sample";

/** A frame whose every texel encodes its own position: r = x, g = y, b = 0.5, a = 1. */
function frame(width: number, height: number): Float32Array {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = x;
      data[o + 1] = y;
      data[o + 2] = 0.5;
      data[o + 3] = 1;
    }
  }
  return data;
}

describe("sampleRect", () => {
  it("is the centred square of SOURCE_SAMPLE_EDGE on a larger frame", () => {
    expect(SOURCE_SAMPLE_EDGE).toBe(1024);
    expect(sampleRect(3000, 2000)).toEqual({ x: 988, y: 488, w: 1024, h: 1024 });
  });

  it("rounds the odd pixel down", () => {
    expect(sampleRect(1025, 1023)).toEqual({ x: 0, y: 0, w: 1024, h: 1023 });
  });

  it("is the whole frame when it is smaller", () => {
    expect(sampleRect(600, 400)).toEqual({ x: 0, y: 0, w: 600, h: 400 });
  });
});

describe("cutSourceSample / unpackSourceSample", () => {
  it("cuts the centre and places it in the decoded frame", () => {
    const stored = cutSourceSample(frame(1100, 740), 1100, 740);
    expect(stored).toMatchObject({ width: 1024, height: 740, x: 38, y: 0, sourceWidth: 1100, sourceHeight: 740 });
    expect(stored.data).toBeInstanceOf(Uint16Array);
    expect(stored.data.length).toBe(1024 * 740 * 4);
    const sample = unpackSourceSample(stored);
    expect(sample.data).toBeInstanceOf(Float32Array);
    for (const [i, j] of [[0, 0], [1023, 739], [500, 300]]) {
      const o = (j * sample.width + i) * 4;
      // Half floats hold integers up to 2048 exactly, so the positions round-trip.
      expect(sample.data[o]).toBe(38 + i);
      expect(sample.data[o + 1]).toBe(j);
      expect(sample.data[o + 2]).toBe(0.5);
      expect(sample.data[o + 3]).toBe(1);
    }
  });

  it("offsets the cut vertically on a frame taller than the edge", () => {
    const stored = cutSourceSample(frame(1100, 1300), 1100, 1300);
    expect(stored).toMatchObject({ width: 1024, height: 1024, x: 38, y: 138, sourceWidth: 1100, sourceHeight: 1300 });
    const sample = unpackSourceSample(stored);
    for (const [i, j] of [[0, 0], [500, 300], [7, 1023], [1023, 1023]]) {
      const o = (j * sample.width + i) * 4;
      // Positions up to 2048 are exact in half floats, so the offsets round-trip.
      expect(sample.data[o]).toBe(38 + i);
      expect(sample.data[o + 1]).toBe(138 + j);
    }
  });

  it("keeps values to half precision, zero and the headroom above 1 included", () => {
    const data = new Float32Array([0, 0.1234567, 1, 1, 15.9, 0.00123, 2.5, 1]);
    const sample = unpackSourceSample(cutSourceSample(data, 2, 1));
    expect(sample.width).toBe(2);
    expect(sample.data[0]).toBe(0);
    expect(Math.abs(sample.data[1] - 0.1234567) / 0.1234567).toBeLessThan(1e-3);
    expect(sample.data[2]).toBe(1);
    expect(Math.abs(sample.data[4] - 15.9) / 15.9).toBeLessThan(1e-3);
    expect(Math.abs(sample.data[5] - 0.00123) / 0.00123).toBeLessThan(1e-3);
    expect(sample.data[6]).toBe(2.5);
  });
});
