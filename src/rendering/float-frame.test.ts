// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A float capture's options: the space it defaults to and the size it is read
// at. The conversion into the space runs on the GPU (float-capture.webgl.test.ts).

import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE_MAX_EDGE, DEFAULT_CAPTURE_SPACE, measureSize } from "./float-frame";

describe("DEFAULT_CAPTURE_SPACE", () => {
  it("is linear Rec.709", () => {
    expect(DEFAULT_CAPTURE_SPACE).toEqual({ encoding: "linear", primaries: "rec709" });
  });
});

// A live frame at fit is the Develop render resolution, 4096 px by default and
// about 180 MB of floats, so a capture is read at a measuring edge instead.
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
