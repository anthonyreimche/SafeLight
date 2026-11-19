// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How a decoded file's RGB codes become linear Rec.709 (D65): a decode curve
// a channel, then a matrix from the file's primaries. The file describes its
// colour by code points (an NCLX colr box, ITU-T H.273) or by an ICC
// matrix/TRC profile, whose D50 colorants are adapted to D65 by Bradford.
// Codes it doesn't describe, or describes as PQ or HLG, read as sRGB.

import type { Xyz } from "./color-space";
import { readCurve, readTagTable, readXyz } from "./display-profile";

export type DecodeCurve = (encoded: number) => number;

export interface InputColour {
  /** Encoded [0, 1] to linear: red, green, blue. */
  curves: readonly [DecodeCurve, DecodeCurve, DecodeCurve];
  /** Linear source RGB to linear Rec.709 (D65), row-major. */
  toRec709: readonly number[];
  /** PQ or HLG codes, read as sRGB: the photo shows without its HDR. */
  hdr: boolean;
}

export interface NclxCodes {
  primaries: number;
  transfer: number;
}

type Mat3 = number[];
type Xy = readonly [number, number];

const D65: Xy = [0.3127, 0.329];
// The ICC profile connection space's illuminant, as the header states it.
const D50_XYZ: Xyz = [0.9642, 1, 0.8249];

const PRIMARIES: Record<number, readonly [Xy, Xy, Xy]> = {
  1: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]],
  5: [[0.64, 0.33], [0.29, 0.6], [0.15, 0.06]],
  6: [[0.63, 0.34], [0.31, 0.595], [0.155, 0.07]],
  7: [[0.63, 0.34], [0.31, 0.595], [0.155, 0.07]],
  9: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]],
  12: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]],
};

const srgb: DecodeCurve = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const bt709: DecodeCurve = (v) => (v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45));
const gamma = (g: number): DecodeCurve => (v) => Math.pow(v, g);
const linear: DecodeCurve = (v) => v;

const TRANSFERS: Record<number, DecodeCurve> = {
  1: bt709,
  4: gamma(2.2),
  5: gamma(2.8),
  6: bt709,
  8: linear,
  13: srgb,
  14: bt709,
  15: bt709,
};

const PQ = 16;
const HLG = 18;

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out.push(a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col]);
    }
  }
  return out;
}

function invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-9)) return null;
  return [
    A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

const xyz = ([x, y]: Xy): Xyz => [x / y, 1, (1 - x - y) / y];

const columns = (r: Xyz, g: Xyz, b: Xyz): Mat3 => [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];

/** Linear RGB to XYZ for primaries `p` with white D65. */
function rgbToXyz(p: readonly [Xy, Xy, Xy]): Mat3 {
  const m = columns(xyz(p[0]), xyz(p[1]), xyz(p[2]));
  const [X, Y, Z] = xyz(D65);
  const inv = invert(m) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const s = [inv[0] * X + inv[1] * Y + inv[2] * Z, inv[3] * X + inv[4] * Y + inv[5] * Z, inv[6] * X + inv[7] * Y + inv[8] * Z];
  return m.map((v, i) => v * s[i % 3]);
}

const XYZ_TO_REC709 = invert(rgbToXyz(PRIMARIES[1])) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

function bradford(from: Xyz, to: Xyz): Mat3 {
  const cone = (w: Xyz) => [0, 1, 2].map((r) => BRADFORD[r * 3] * w[0] + BRADFORD[r * 3 + 1] * w[1] + BRADFORD[r * 3 + 2] * w[2]);
  const a = cone(from);
  const b = cone(to);
  const scale = [b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]];
  return multiply(invert(BRADFORD) ?? IDENTITY, multiply(scale, BRADFORD));
}

const D50_TO_D65 = bradford(D50_XYZ, xyz(D65));

export const SRGB_INPUT: InputColour = { curves: [srgb, srgb, srgb], toRec709: IDENTITY, hdr: false };

/** The colour an NCLX box describes. */
export function nclxInputColour({ primaries, transfer }: NclxCodes): InputColour {
  const p = PRIMARIES[primaries];
  const toRec709 = !p || primaries === 1 ? IDENTITY : multiply(XYZ_TO_REC709, rgbToXyz(p));
  const curve = TRANSFERS[transfer] ?? srgb;
  return { curves: [curve, curve, curve], toRec709, hdr: transfer === PQ || transfer === HLG };
}

const fourcc = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

/** The colour an ICC matrix/TRC profile describes, or null when `bytes`
 *  isn't one. */
export function iccInputColour(bytes: Uint8Array): InputColour | null {
  try {
    if (bytes.length < 132) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(0);
    if (fourcc(bytes, 36) !== "acsp" || fourcc(bytes, 16) !== "RGB " || size < 132 || size > bytes.length) return null;
    const tags = readTagTable(bytes, view, size);
    if (!tags) return null;
    const colorants: Xyz[] = [];
    const curves: DecodeCurve[] = [];
    for (const channel of ["r", "g", "b"]) {
      const colorantTag = tags.get(`${channel}XYZ`);
      const curveTag = tags.get(`${channel}TRC`);
      if (!colorantTag || !curveTag) return null;
      const colorant = readXyz(bytes, view, colorantTag);
      const curve = readCurve(bytes, view, curveTag);
      if (!colorant || typeof curve === "string") return null;
      colorants.push(colorant);
      curves.push(curve);
    }
    const toXyz = columns(colorants[0], colorants[1], colorants[2]);
    if (!invert(toXyz)) return null;
    const toRec709 = multiply(XYZ_TO_REC709, multiply(D50_TO_D65, toXyz));
    if (!toRec709.every(Number.isFinite)) return null;
    return { curves: [curves[0], curves[1], curves[2]], toRec709, hdr: false };
  } catch {
    return null;
  }
}

/** A HEIF's colour: its ICC profile when readable, else its NCLX codes, else
 *  sRGB. PQ or HLG codes in the NCLX are flagged whichever describes the colour. */
export function heifInputColour(colour: { nclx: NclxCodes | null; icc: Uint8Array | null }): InputColour {
  const fromNclx = colour.nclx ? nclxInputColour(colour.nclx) : SRGB_INPUT;
  const fromIcc = colour.icc ? iccInputColour(colour.icc) : null;
  return fromIcc ? { ...fromIcc, hdr: fromNclx.hdr } : fromNclx;
}
