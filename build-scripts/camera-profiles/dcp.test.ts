// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reading an Adobe DNG camera profile (DCP): the tags rendering needs, the
// embed policy that decides whether it may ship, and the camera it belongs to.

import { describe, expect, it } from "vitest";
import { parseDcp } from "./dcp.ts";
import { COLOR_MATRIX_1, FORWARD_MATRIX_1, buildDcp, buildTiff } from "./fixtures.test-support.ts";

const LOOK = { dims: [2, 2, 1] as [number, number, number], data: [0, 1, 1, 5, 0.9, 1, -5, 1.1, 1, 0, 1, 0.95] };
const HUE_SAT = {
  dims: [2, 1, 1] as [number, number, number],
  data1: [2, 1, 1, -2, 1.5, 1],
  data2: [1, 1, 1, -1, 1.25, 1],
};

const full = (littleEndian = true) =>
  buildDcp({
    model: "Nikon Z 6 2",
    name: "Camera Standard",
    toneCurve: [0, 0, 0.18, 0.514, 1, 1],
    look: LOOK,
    hueSat: HUE_SAT,
    exposureOffset: -0.35,
    littleEndian,
  });

describe("parseDcp", () => {
  for (const littleEndian of [true, false]) {
    it(`reads every tag rendering needs (${littleEndian ? "little" : "big"}-endian)`, () => {
      const p = parseDcp(full(littleEndian));
      expect(p.uniqueCameraModel).toBe("Nikon Z 6 2");
      expect(p.name).toBe("Camera Standard");
      expect(p.copyright).toBe("Copyright 2018 Adobe Systems, Inc.");
      expect(p.embedPolicy).toBe(0);
      expect([p.illuminant1, p.illuminant2]).toEqual([21, 0]);
      expect([...p.colorMatrix1].map((v) => +v.toFixed(4))).toEqual(COLOR_MATRIX_1);
      expect([...p.forwardMatrix1].map((v) => +v.toFixed(4))).toEqual(FORWARD_MATRIX_1);
      expect([...p.colorMatrix2]).toEqual(new Array(9).fill(0));
      expect(p.exposureOffset).toBeCloseTo(-0.35, 6);
      expect(p.defaultBlackRender).toBe(1);
      expect(p.lookEncoding).toBe(1);
      expect(p.hueSatEncoding).toBe(0);
      expect(p.lookDims).toEqual([2, 2, 1]);
      expect([...p.look].map((v) => +v.toFixed(4))).toEqual(LOOK.data);
      expect(p.hueSatDims).toEqual([2, 1, 1]);
      expect([...p.hueSat1]).toEqual(HUE_SAT.data1);
      expect([...p.hueSat2]).toEqual(HUE_SAT.data2);
      expect([...p.toneCurve].map((v) => +v.toFixed(4))).toEqual([0, 0, 0.18, 0.514, 1, 1]);
    });
  }

  it("leaves out what a profile doesn't carry", () => {
    const p = parseDcp(buildDcp({ model: "Nikon D3400", name: "Adobe Standard" }));
    expect(p.toneCurve.length).toBe(0);
    expect(p.look.length).toBe(0);
    expect(p.lookDims).toEqual([0, 0, 0]);
    expect(p.hueSat1.length).toBe(0);
    expect(p.hueSatDims).toEqual([0, 0, 0]);
    expect(p.exposureOffset).toBe(0);
  });

  it("reports a missing embed policy as null, not as allowed", () => {
    expect(parseDcp(buildDcp({ model: "X", name: "Adobe Standard", policy: null })).embedPolicy).toBeNull();
    expect(parseDcp(buildDcp({ model: "X", name: "Camera Standard", policy: 1 })).embedPolicy).toBe(1);
  });

  it("refuses a file that isn't a DCP", () => {
    expect(() => parseDcp(buildTiff([{ tag: 0x0110, type: 2, values: "NIKON Z 6_2" }]))).toThrow(/camera profile/);
  });

  it("refuses a ColorMatrix1 that isn't nine values", () => {
    const twelve = [...COLOR_MATRIX_1, 0, 0, 0];
    expect(() => parseDcp(buildDcp({ model: "X", name: "Camera Standard", colorMatrix1: twelve }))).toThrow(
      "ColorMatrix1 has 12 values, not 9",
    );
  });

  it("refuses a ForwardMatrix1 that isn't nine values", () => {
    const six = FORWARD_MATRIX_1.slice(0, 6);
    expect(() => parseDcp(buildDcp({ model: "X", name: "Camera Standard", forwardMatrix1: six }))).toThrow(
      "ForwardMatrix1 has 6 values, not 9",
    );
  });

  it("refuses a profile without a ColorMatrix1", () => {
    expect(() => parseDcp(buildDcp({ model: "X", name: "Camera Standard", colorMatrix1: null }))).toThrow(
      "no ColorMatrix1",
    );
  });
});
