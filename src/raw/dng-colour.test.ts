// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { dngColour, type DngColourTags } from "./dng-colour";

type Vec3 = readonly [number, number, number];

const apply = (m: readonly number[], v: Vec3): number[] => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

function expectClose(actual: readonly number[], expected: readonly number[], digits = 4): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
}

// XYZ (D65) -> linear sRGB: the ColorMatrix of a camera whose raw space is linear sRGB.
const SRGB_CM = [
  3.2404542, -1.5371385, -0.4985314,
  -0.969266, 1.8760108, 0.041556,
  0.0556434, -0.2040259, 1.0572252,
];
const D65 = 21;
const STANDARD_A = 17;

// Canon EOS 5D Mark II, as Adobe DNG Converter writes it.
const CANON_A = [
  0.5309, -0.0231, -0.0629, -0.4919, 1.2564, 0.2667, -0.1072, 0.1928, 0.7128,
];
const CANON_D65 = [
  0.4716, 0.0603, -0.083, -0.7798, 1.5474, 0.248, -0.1496, 0.1937, 0.6651,
];

const srgbCamera = (extra: Partial<DngColourTags> = {}): DngColourTags => ({
  calibrations: [{ illuminant: D65, colorMatrix: SRGB_CM }],
  ...extra,
});

// What LibRaw makes of a Canon CR2 from the test photos: its D65 matrix
// (cam_xyz), as-shot multipliers (cam_mul), and the camera-to-sRGB matrix
// dcraw's cam_xyz_coeff builds from them. A linear DNG of the same frame
// decoded through it matched darktable 5.6.1's render to 0.00 ΔE2000.
const LIBRAW_CR2 = {
  camXyz: [0.6719, -0.0994, -0.0925, -0.4408, 1.2426, 0.2211, -0.0887, 0.2129, 0.6051],
  camMul: [2068, 1024, 1694] as const,
  rgbCam: [1.857855, -0.985492, 0.127637, -0.214488, 1.670976, -0.456488, 0.005987, -0.52554, 1.519553],
};

describe("dngColour", () => {
  it("renders as libraw does: camera-space multipliers, then its camera-to-sRGB matrix", () => {
    const { camXyz, camMul, rgbCam } = LIBRAW_CR2;
    const least = Math.min(...camMul);
    const { cameraToSrgb } = dngColour({
      calibrations: [{ illuminant: STANDARD_A, colorMatrix: CANON_A }, { illuminant: D65, colorMatrix: camXyz }],
      asShotNeutral: [camMul[1] / camMul[0], 1, camMul[1] / camMul[2]],
    });
    const expected = rgbCam.map((v, i) => (v * camMul[i % 3]) / least);
    expectClose(cameraToSrgb, expected, 4);
  });

  it("takes the D65 calibration whatever the as-shot white, as libraw does", () => {
    for (const neutral of [[0.9, 1, 0.3], [0.55, 1, 0.62]] as const) {
      const both = dngColour({
        calibrations: [{ illuminant: D65, colorMatrix: CANON_D65 }, { illuminant: STANDARD_A, colorMatrix: CANON_A }],
        asShotNeutral: neutral,
      });
      const daylight = dngColour({ calibrations: [{ illuminant: D65, colorMatrix: CANON_D65 }], asShotNeutral: neutral });
      expectClose(both.cameraToSrgb, daylight.cameraToSrgb, 9);
    }
  });

  it("takes the calibration nearest D65 when neither is D65", () => {
    const pick = dngColour({
      calibrations: [{ illuminant: STANDARD_A, colorMatrix: CANON_A }, { illuminant: 10, colorMatrix: CANON_D65 }],
      asShotNeutral: [0.5, 1, 0.7],
    });
    const cloudy = dngColour({ calibrations: [{ illuminant: 10, colorMatrix: CANON_D65 }], asShotNeutral: [0.5, 1, 0.7] });
    expectClose(pick.cameraToSrgb, cloudy.cameraToSrgb, 9);
  });

  it("leaves a linear sRGB camera balanced for D65 as it is", () => {
    const { cameraToSrgb } = dngColour(srgbCamera({ asShotNeutral: [1, 1, 1] }));
    expectClose(cameraToSrgb, [1, 0, 0, 0, 1, 0, 0, 0, 1], 3);
  });

  it("brings the as-shot neutral to white, at 1.0 where its largest channel saturates", () => {
    const neutral: Vec3 = [0.4955, 1, 0.6912];
    const { cameraToSrgb } = dngColour({
      calibrations: [
        { illuminant: STANDARD_A, colorMatrix: CANON_A },
        { illuminant: D65, colorMatrix: CANON_D65 },
      ],
      asShotNeutral: neutral,
    });
    expectClose(apply(cameraToSrgb, neutral), [1, 1, 1]);
    expectClose(apply(cameraToSrgb, [neutral[0] / 4, 0.25, neutral[2] / 4]), [0.25, 0.25, 0.25]);
  });

  it("finds the neutral from AsShotWhiteXY when the file gives no AsShotNeutral", () => {
    const d50 = [0.3457, 0.3585] as const;
    const colour = dngColour(srgbCamera({ asShotWhiteXY: d50 }));
    const xyz: Vec3 = [d50[0] / d50[1], 1, (1 - d50[0] - d50[1]) / d50[1]];
    const camera = apply(SRGB_CM, xyz);
    const top = Math.max(...camera);
    expectClose(apply(colour.cameraToSrgb, [camera[0] / top, camera[1] / top, camera[2] / top]), [1, 1, 1], 3);
    expect(colour.colorTemperature).toBe(5000);
  });

  it("reports the as-shot white's temperature and multipliers", () => {
    const colour = dngColour(srgbCamera({ asShotNeutral: [0.5, 1, 0.8] }));
    expect(colour.asShotMultipliers?.[0]).toBeCloseTo(2, 6);
    expect(colour.asShotMultipliers?.[1]).toBe(1);
    expect(colour.asShotMultipliers?.[2]).toBeCloseTo(1.25, 6);
    expect(dngColour(srgbCamera({ asShotNeutral: [1, 1, 1] })).colorTemperature).toBe(6500);
  });

  it("reports no as-shot white for a file that gives none", () => {
    const colour = dngColour(srgbCamera());
    expect(colour.colorTemperature).toBeUndefined();
    expect(colour.asShotMultipliers).toBeUndefined();
  });

  it("applies the analog balance and camera calibration on top of the colour matrix", () => {
    const neutral: Vec3 = [0.6, 1, 0.7];
    const plain = dngColour(srgbCamera({ asShotNeutral: neutral })).cameraToSrgb;
    const calibrated = dngColour({
      calibrations: [{ illuminant: D65, colorMatrix: SRGB_CM, cameraCalibration: [1.1, 0, 0, 0, 1, 0, 0, 0, 0.9] }],
      analogBalance: [1, 1, 1],
      asShotNeutral: neutral,
    }).cameraToSrgb;
    expectClose(apply(calibrated, neutral), [1, 1, 1]);
    expect(calibrated).not.toEqual(plain);
  });

  it("takes a file with no colour matrix as linear sRGB, balanced by its neutral", () => {
    const { cameraToSrgb } = dngColour({ calibrations: [], asShotNeutral: [0.5, 1, 0.8] });
    expectClose(cameraToSrgb, [2, 0, 0, 0, 1, 0, 0, 0, 1.25], 9);
  });
});
