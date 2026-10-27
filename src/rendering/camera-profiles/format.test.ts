// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The camera profile table format: what the build tool writes, the renderer
// reads back. Matrices, exposure and the tone curve are f32; the hue/sat and
// look tables are f16, so they come back to half-float precision.

import { describe, expect, it } from "vitest";
import {
  CAMERA_PROFILE_FORMAT,
  packCameraProfiles,
  parseCameraProfiles,
  type CameraProfile,
  type PackableProfile,
} from "./format";

const ramp = (n: number, scale: number): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => (i % 97) * scale - 3);

function profile(over: Partial<PackableProfile> = {}): PackableProfile {
  return {
    name: "Camera Standard",
    copyright: "Copyright 2018 Adobe Systems, Inc.",
    embedPolicy: 0,
    illuminant1: 17,
    illuminant2: 21,
    colorMatrix1: Float32Array.from([1.1395, -0.5115, 0.0263, -0.4486, 1.2207, 0.2568, -0.045, 0.1207, 0.8802]),
    colorMatrix2: Float32Array.from([0.9943, -0.3269, -0.0839, -0.5323, 1.3269, 0.2259, -0.1198, 0.2083, 0.7557]),
    forwardMatrix1: Float32Array.from([0.7978, 0.1352, 0.0313, 0.288, 0.7119, 0.0001, 0, 0, 0.8251]),
    forwardMatrix2: Float32Array.from([0.7978, 0.1352, 0.0313, 0.288, 0.7119, 0.0001, 0, 0, 0.8251]),
    exposureOffset: -0.35,
    defaultBlackRender: 1,
    hueSatEncoding: 0,
    lookEncoding: 1,
    hueSatDims: [6, 3, 1],
    hueSat1: ramp(6 * 3 * 1 * 3, 0.5),
    hueSat2: ramp(6 * 3 * 1 * 3, 0.25),
    lookDims: [4, 2, 2],
    look: ramp(4 * 2 * 2 * 3, 0.1),
    toneCurve: Float32Array.from([0, 0, 0.0006, 0.0004, 0.18, 0.514, 1, 1]),
    ...over,
  };
}

/** No profile: no maps, no look table, no tone curve. */
const bare = (): PackableProfile =>
  profile({
    name: "Adobe Standard",
    hueSatDims: [0, 0, 0],
    hueSat1: new Float32Array(0),
    hueSat2: new Float32Array(0),
    lookDims: [0, 0, 0],
    look: new Float32Array(0),
    toneCurve: new Float32Array(0),
  });

/** Tables the writer keeps as f32 must come back bit-for-bit: a value rounded
 *  through half floats would still pass a loose tolerance. */
function expectExact(got: Float32Array, want: Float32Array) {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) expect(got[i]).toBe(Math.fround(want[i]));
}

/** The f16 tables come back to half-float precision. */
function expectClose(got: Float32Array, want: Float32Array, relative: number) {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(Math.abs(want[i]) * relative + 1e-3);
  }
}

function expectSame(got: CameraProfile, want: PackableProfile) {
  expect(got.name).toBe(want.name);
  expect(got.copyright).toBe(want.copyright);
  expect([got.illuminant1, got.illuminant2]).toEqual([want.illuminant1, want.illuminant2]);
  for (const key of ["colorMatrix1", "colorMatrix2", "forwardMatrix1", "forwardMatrix2", "toneCurve"] as const) {
    expectExact(got[key], want[key]);
  }
  expect(got.exposureOffset).toBeCloseTo(want.exposureOffset, 6);
  expect([got.defaultBlackRender, got.hueSatEncoding, got.lookEncoding]).toEqual([
    want.defaultBlackRender,
    want.hueSatEncoding,
    want.lookEncoding,
  ]);
  expect(got.hueSatDims).toEqual(want.hueSatDims);
  expect(got.lookDims).toEqual(want.lookDims);
  for (const key of ["hueSat1", "hueSat2", "look"] as const) expectClose(got[key], want[key], 1e-3);
}

describe("packCameraProfiles and parseCameraProfiles", () => {
  it("read back what was written, the tables to half-float precision", () => {
    const written = [profile(), bare()];
    const read = parseCameraProfiles(packCameraProfiles(written));
    expect(read).toHaveLength(2);
    read.forEach((p, i) => expectSame(p, written[i]));
  });

  it("keep a profile with one hue/sat map apart from one with two", () => {
    const [one] = parseCameraProfiles(packCameraProfiles([profile({ hueSat2: new Float32Array(0) })]));
    expect(one.hueSat1.length).toBe(54);
    expect(one.hueSat2.length).toBe(0);
  });

  it("start with the magic, the format and the profile count", () => {
    const bytes = packCameraProfiles([profile(), bare()]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("SLCP");
    expect(view.getUint16(4, true)).toBe(CAMERA_PROFILE_FORMAT);
    expect(view.getUint16(6, true)).toBe(2);
  });

  it("lay the tables out at their exact f32 and f16 sizes", () => {
    const p = profile();
    const text = (s: string): number => 2 + new TextEncoder().encode(s).length;
    const size =
      8 + // "SLCP", format, profile count
      text(p.name) +
      text(p.copyright) +
      2 * 2 + // illuminants
      4 * 9 * 4 + // four matrices, f32
      4 + // exposure offset, f32
      3 * 2 + // default black render and the two encodings
      3 * 2 + // hue/sat dims
      2 + // hue/sat map count
      2 * (6 * 3 * 1 * 3) * 2 + // two hue/sat maps, f16
      3 * 2 + // look dims
      4 * 2 * 2 * 3 * 2 + // look table, f16
      2 + // tone curve point count
      8 * 4; // tone curve, f32
    expect(packCameraProfiles([p]).length).toBe(size);
  });
});

describe("packCameraProfiles", () => {
  it("refuses a profile its maker didn't allow copying", () => {
    expect(() => packCameraProfiles([profile({ embedPolicy: 1 })])).toThrow(/allow copying/);
    expect(() => packCameraProfiles([profile({ embedPolicy: null })])).toThrow(/allow copying/);
  });

  it("refuses a table that doesn't fit its dimensions", () => {
    expect(() => packCameraProfiles([profile({ look: new Float32Array(5) })])).toThrow(/look/);
    expect(() => packCameraProfiles([profile({ hueSat1: new Float32Array(5) })])).toThrow(/hue\/sat/);
    expect(() => packCameraProfiles([profile({ colorMatrix1: new Float32Array(3) })])).toThrow(/matrix/);
  });

  it("refuses a second hue/sat map without a first", () => {
    expect(() => packCameraProfiles([profile({ hueSat1: new Float32Array(0) })])).toThrow(/second hue\/sat map/);
  });
});

describe("parseCameraProfiles", () => {
  it("refuses bytes that aren't a camera profile table", () => {
    expect(() => parseCameraProfiles(new TextEncoder().encode("II*\0rest of a tiff"))).toThrow(/not a camera profile table/);
  });

  it("refuses a format it doesn't know", () => {
    const bytes = packCameraProfiles([profile()]);
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(4, CAMERA_PROFILE_FORMAT + 1, true);
    expect(() => parseCameraProfiles(bytes)).toThrow(/format/);
  });
});
