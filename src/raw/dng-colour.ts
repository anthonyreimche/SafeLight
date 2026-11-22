// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A DNG's colour tags as libraw reads them (dcraw's cam_xyz_coeff), so a linear
// DNG made from a RAW comes out as that RAW's libraw decode does: one colour
// matrix (the D65 calibration's, as libraw picks it), white balance as
// multipliers in camera space, and a fixed camera-to-Rec.709 matrix whose rows
// carry a balanced camera white to (1, 1, 1). The as-shot white lands at
// (1, 1, 1), and white is reached where the camera channel with the largest
// neutral value saturates at 1.0, libraw's white point once the adapter undoes
// its highlight scaling. Pure maths, no imports, so it runs in the frame worker.

type Vec3 = readonly [number, number, number];
/** Row-major 3×3. */
type Matrix3 = readonly number[];
type Xy = readonly [number, number];

/** One colour calibration of the file: its matrices under one illuminant. */
export interface DngCalibration {
  /** CalibrationIlluminant, an EXIF LightSource code. */
  illuminant: number;
  /** ColorMatrix: XYZ to camera, under the illuminant. */
  colorMatrix: Matrix3;
  /** CameraCalibration, when it applies to the file's profile. */
  cameraCalibration?: Matrix3;
}

export interface DngColourTags {
  /** Up to two, in the file's order; none for a file without ColorMatrix1. */
  calibrations: readonly DngCalibration[];
  analogBalance?: Vec3;
  asShotNeutral?: Vec3;
  asShotWhiteXY?: Xy;
}

export interface DngColour {
  /** Camera samples (0 black, 1 white) to linear Rec.709, white-balanced for
   *  the as-shot white. */
  cameraToSrgb: Matrix3;
  /** The as-shot white in Kelvin, rounded to 10 K, when the file gives one. */
  colorTemperature?: number;
  /** The as-shot white balance as camera-space gains, green at 1, when the
   *  file gives one. */
  asShotMultipliers?: [number, number, number];
}

// EXIF LightSource codes -> Kelvin, after dng_sdk's IlluminantToTemperature.
const ILLUMINANT_KELVIN: Readonly<Record<number, number>> = {
  1: 5500, 2: 4200, 3: 2850, 4: 5500, 9: 5500, 10: 6500, 11: 7500, 12: 6400,
  13: 5000, 14: 4200, 15: 3450, 17: 2850, 18: 5500, 19: 6500, 20: 5500,
  21: 6500, 22: 7500, 23: 5000, 24: 3200,
};
const D65_LIGHT = 21;
const D65_KELVIN = 6500;

// dcraw's xyz_rgb (linear sRGB to XYZ, D65) and d65_white, as libraw has them.
const XYZ_FROM_RGB: Matrix3 = [
  0.412453, 0.35758, 0.180423,
  0.212671, 0.71516, 0.072169,
  0.019334, 0.119193, 0.950227,
];
const D65_WHITE: Vec3 = [0.95047, 1, 1.08883];
const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push(a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c]);
    }
  }
  return out;
}

function apply(m: Matrix3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function invert(m: Matrix3): Matrix3 | undefined {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c0 = e * i - f * h;
  const c1 = f * g - d * i;
  const c2 = d * h - e * g;
  const det = a * c0 + b * c1 + c * c2;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const s = 1 / det;
  return [
    c0 * s, (c * h - b * i) * s, (b * f - c * e) * s,
    c1 * s, (a * i - c * g) * s, (c * d - a * f) * s,
    c2 * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

const diagonal = (v: Vec3): Matrix3 => [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]];

// McCamy's cubic: within a few Kelvin over the range cameras calibrate across.
function kelvinOf([x, y]: Xy): number {
  const n = (x - 0.332) / (0.1858 - y);
  return ((449 * n + 3525) * n + 6823.3) * n + 5520.33;
}

/** The calibration libraw takes: the D65 one, else the one nearest 6500 K,
 *  else (illuminants it can't place) the last, as dcraw reads them. */
function calibrationOf(calibrations: readonly DngCalibration[]): DngCalibration | undefined {
  const d65 = calibrations.find((c) => c.illuminant === D65_LIGHT);
  if (d65) return d65;
  const placed = calibrations.filter((c) => ILLUMINANT_KELVIN[c.illuminant]);
  if (placed.length === 0) return calibrations[calibrations.length - 1];
  const distance = (c: DngCalibration): number => Math.abs(ILLUMINANT_KELVIN[c.illuminant] - D65_KELVIN);
  return placed.reduce((best, c) => (distance(c) < distance(best) ? c : best));
}

/** The file's colour, as libraw renders it: balanced by AsShotNeutral, else by
 *  the white AsShotWhiteXY names, else by the camera's response to D65 (its
 *  daylight multipliers). A file with no colour matrix is taken as linear
 *  sRGB already. */
export function dngColour(tags: DngColourTags): DngColour {
  const given = tags.asShotNeutral && tags.asShotNeutral.every((v) => v > 0) ? tags.asShotNeutral : undefined;
  const calibration = calibrationOf(tags.calibrations);
  if (!calibration) {
    return { cameraToSrgb: balanced(IDENTITY, given ?? [1, 1, 1]), ...asShot(given) };
  }
  // dcraw scales the matrix's columns by the named white over D65, which makes
  // the camera's response to it the neutral its daylight multipliers balance.
  const white = tags.asShotWhiteXY;
  const scale: Vec3 = white
    ? [white[0] / D65_WHITE[0], white[1] / D65_WHITE[1], (1 - white[0] - white[1]) / D65_WHITE[2]]
    : [1, 1, 1];
  const balance = multiply(diagonal(tags.analogBalance ?? [1, 1, 1]), calibration.cameraCalibration ?? IDENTITY);
  const cameraFromXyz = multiply(multiply(balance, calibration.colorMatrix), diagonal(scale));
  const cameraFromRgb = multiply(cameraFromXyz, XYZ_FROM_RGB);
  // Each row sums to the camera's response to the white: normalized, a
  // balanced camera white maps to (1, 1, 1).
  const response = apply(cameraFromRgb, [1, 1, 1]);
  if (!response.every((v) => v > 0)) return { cameraToSrgb: IDENTITY };
  const normalized = cameraFromRgb.map((v, i) => v / response[Math.floor(i / 3)]);
  const rgbFromCamera = invert(normalized);
  if (!rgbFromCamera) return { cameraToSrgb: IDENTITY };
  const neutral = given ?? response;
  const xyz = invert(cameraFromXyz);
  const asShotXy = white ?? (given && xyz ? xyOf(apply(xyz, given)) : undefined);
  return {
    cameraToSrgb: balanced(rgbFromCamera, neutral),
    ...(given || white ? asShot(neutral, asShotXy) : {}),
  };
}

/** `toRgb` after multipliers that bring `neutral` to equal channels, the
 *  channel with the largest neutral value at 1. */
function balanced(toRgb: Matrix3, neutral: Vec3): Matrix3 {
  const top = Math.max(...neutral);
  return multiply(toRgb, diagonal([top / neutral[0], top / neutral[1], top / neutral[2]]));
}

function xyOf([X, Y, Z]: Vec3): Xy | undefined {
  const sum = X + Y + Z;
  return sum > 0 && Number.isFinite(sum) ? [X / sum, Y / sum] : undefined;
}

function asShot(neutral: Vec3 | undefined, xy?: Xy): Pick<DngColour, "colorTemperature" | "asShotMultipliers"> {
  if (!neutral) return {};
  const kelvin = xy ? kelvinOf(xy) : undefined;
  return {
    asShotMultipliers: [neutral[1] / neutral[0], 1, neutral[1] / neutral[2]],
    ...(kelvin !== undefined && Number.isFinite(kelvin) ? { colorTemperature: Math.round(kelvin / 10) * 10 } : {}),
  };
}
