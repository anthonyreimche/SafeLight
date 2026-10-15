// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A monitor's ICC profile, reduced to what the shader's output-space stage can
// apply without new GLSL: a matrix from sRGB to the monitor's primaries, and
// whichever of the stage's three encodes is closest to the monitor's tone
// curve. Under Wayland nothing converts Safelight's window to the monitor, so
// on Linux the live Develop view converts itself (Preferences ▸ Rendering).
//
// Only matrix/TRC profiles qualify. A LUT-based profile is used through the
// matrix and curves it carries alongside its LUTs, when those are plausible.

import {
  OUT_SPACE_CODE,
  outputColorants,
  outputDecode,
  type ColorSpaceId,
  type Xyz,
} from "./color-space";

export type DisplayCurve = "srgb" | "gamma22" | "gamma18";

export interface MonitorTransform {
  /** sRGB-linear → display-linear, column-major for uniformMatrix3fv. */
  matrix: Float32Array;
  /** The output stage's encode closest to the profile's tone curve. */
  curve: DisplayCurve;
}

export interface DisplayProfile {
  /** The profile's own name; empty when it carries none. */
  description: string;
  transform: MonitorTransform;
}

export type ParsedDisplayProfile =
  | { ok: true; profile: DisplayProfile }
  | { ok: false; error: string };

export const PROFILE_ERROR = {
  notIcc: "This file isn't an ICC profile, or it's damaged.",
  notRgb: "This isn't an RGB display profile.",
  noMatrix:
    'This profile has no matrix and tone curves. Profiles made as "curves + matrix" or "single curve + matrix" work.',
  curveType: "This profile uses a tone curve type Safelight can't read.",
  primaries:
    "This profile's primaries don't describe a red, green and blue display. Profiles built with a swapped matrix aren't supported.",
} as const;

// Each curve is the encode of an export space that already uses it.
const CURVE_SPACE: Record<DisplayCurve, ColorSpaceId> = {
  srgb: "display-p3",
  gamma22: "adobe-rgb",
  gamma18: "prophoto-rgb",
};

/** The uOutSpace code that encodes with each curve. */
export const DISPLAY_CURVE_CODE: Record<DisplayCurve, number> = {
  srgb: OUT_SPACE_CODE[CURVE_SPACE.srgb],
  gamma22: OUT_SPACE_CODE[CURVE_SPACE.gamma22],
  gamma18: OUT_SPACE_CODE[CURVE_SPACE.gamma18],
};

export const DISPLAY_CURVE_LABEL: Record<DisplayCurve, string> = {
  srgb: "sRGB",
  gamma22: "gamma 2.2",
  gamma18: "gamma 1.8",
};

// ─── 3×3 matrices, row-major ────────────────────────────────────────────────

type Mat3 = number[];

const columns = (r: Xyz, g: Xyz, b: Xyz): Mat3 => [
  r[0], g[0], b[0],
  r[1], g[1], b[1],
  r[2], g[2], b[2],
];

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[row * 3 + k] * b[k * 3 + col];
      out.push(sum);
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
  if (!(Math.abs(det) > 1e-6)) return null;
  return [
    A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
}

const toColumnMajor = (m: Mat3) =>
  new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);

const fromColumnMajor = (m: Float32Array): Mat3 => [
  m[0], m[3], m[6],
  m[1], m[4], m[7],
  m[2], m[5], m[8],
];

// ─── Tags ───────────────────────────────────────────────────────────────────

interface Tag {
  offset: number;
  size: number;
}

type Curve = (x: number) => number;

const fourcc = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function readTagTable(bytes: Uint8Array, view: DataView, size: number): Map<string, Tag> | null {
  const count = view.getUint32(128);
  if (132 + count * 12 > size) return null;
  const tags = new Map<string, Tag>();
  for (let i = 0; i < count; i++) {
    const entry = 132 + i * 12;
    const tag = { offset: view.getUint32(entry + 4), size: view.getUint32(entry + 8) };
    if (tag.offset + tag.size > size) return null;
    tags.set(fourcc(bytes, entry), tag);
  }
  return tags;
}

function readXyz(bytes: Uint8Array, view: DataView, tag: Tag): Xyz | null {
  if (tag.size < 20 || fourcc(bytes, tag.offset) !== "XYZ ") return null;
  const at = tag.offset + 8;
  return [view.getInt32(at) / 65536, view.getInt32(at + 4) / 65536, view.getInt32(at + 8) / 65536];
}

// Parameters per parametricCurveType function (ICC.1 10.18).
const PARA_PARAMS = [1, 3, 4, 5, 7];

/** The tag's TRC as encoded → linear, or the reason it can't be read. */
function readCurve(bytes: Uint8Array, view: DataView, tag: Tag): Curve | string {
  const at = tag.offset;
  if (tag.size < 12) return PROFILE_ERROR.notIcc;
  const type = fourcc(bytes, at);
  if (type === "curv") {
    const n = view.getUint32(at + 8);
    if (tag.size < 12 + n * 2) return PROFILE_ERROR.notIcc;
    if (n === 0) return (x) => x;
    if (n === 1) {
      const gamma = view.getUint16(at + 12) / 256;
      return (x) => Math.pow(x, gamma);
    }
    const table = Array.from({ length: n }, (_, i) => view.getUint16(at + 12 + i * 2) / 65535);
    return (x) => {
      const p = clamp01(x) * (n - 1);
      const i = Math.min(n - 2, Math.floor(p));
      return table[i] + (table[i + 1] - table[i]) * (p - i);
    };
  }
  if (type !== "para") return PROFILE_ERROR.curveType;
  const fn = view.getUint16(at + 8);
  const count = PARA_PARAMS[fn];
  if (count === undefined) return PROFILE_ERROR.curveType;
  if (tag.size < 12 + count * 4) return PROFILE_ERROR.notIcc;
  const [g, a, b, c, d, e, f] = Array.from(
    { length: count },
    (_, i) => view.getInt32(at + 12 + i * 4) / 65536,
  );
  switch (fn) {
    case 0:
      return (x) => Math.pow(x, g);
    case 1:
      return (x) => (x >= -b / a ? Math.pow(a * x + b, g) : 0);
    case 2:
      return (x) => (x >= -b / a ? Math.pow(a * x + b, g) + c : c);
    case 3:
      return (x) => (x >= d ? Math.pow(a * x + b, g) : c * x);
    default:
      return (x) => (x >= d ? Math.pow(a * x + b, g) + e : c * x + f);
  }
}

// A name for the status line; a profile's text can be any length.
const MAX_DESCRIPTION = 256;

function readDescription(bytes: Uint8Array, view: DataView, tag: Tag | undefined): string {
  if (!tag || tag.size < 12) return "";
  const at = tag.offset;
  let text = "";
  const type = fourcc(bytes, at);
  if (type === "desc") {
    const n = view.getUint32(at + 8);
    if (12 + n > tag.size) return "";
    for (let i = 0; i < Math.min(n, MAX_DESCRIPTION); i++) {
      text += String.fromCharCode(bytes[at + 12 + i]);
    }
  } else if (type === "mluc") {
    if (tag.size < 28 || view.getUint32(at + 8) < 1) return "";
    const length = Math.min(view.getUint32(at + 20), MAX_DESCRIPTION * 2);
    const start = view.getUint32(at + 24);
    if (start + length > tag.size) return "";
    for (let i = 0; i + 1 < length; i += 2) text += String.fromCharCode(view.getUint16(at + start + i));
  }
  return text.split("\0")[0].trim();
}

// ─── Fitting ────────────────────────────────────────────────────────────────

function chromaticity([x, y, z]: Xyz): [number, number] {
  const sum = x + y + z;
  return sum > 0 ? [x / sum, y / sum] : [NaN, NaN];
}

// A red, green and blue display: red sits furthest along x, green highest in
// y, blue lowest in y. A swapped matrix fails this on purpose.
function plausiblePrimaries(r: Xyz, g: Xyz, b: Xyz): boolean {
  const [rx, ry] = chromaticity(r);
  const [gx, gy] = chromaticity(g);
  const [bx, by] = chromaticity(b);
  return rx > gx && rx > bx && gy > ry && gy > by && by < ry;
}

const CURVES = Object.keys(CURVE_SPACE) as DisplayCurve[];

// Compared through a cube root, roughly how lightness is perceived, so the
// shadows (where sRGB and gamma 2.2 part) count as much as the highlights.
function nearestCurve(trcs: Curve[]): DisplayCurve {
  let best = CURVES[0];
  let bestError = Infinity;
  for (const curve of CURVES) {
    const decode = outputDecode(CURVE_SPACE[curve]);
    let error = 0;
    for (const trc of trcs) {
      for (let i = 0; i <= 255; i++) {
        const x = i / 255;
        error += (Math.cbrt(clamp01(trc(x))) - Math.cbrt(decode(x))) ** 2;
      }
    }
    if (error < bestError) {
      bestError = error;
      best = curve;
    }
  }
  return best;
}

// ─── Entry points ───────────────────────────────────────────────────────────

export function parseDisplayProfile(bytes: Uint8Array): ParsedDisplayProfile {
  const fail = (error: string): ParsedDisplayProfile => ({ ok: false, error });
  if (bytes.length < 132) return fail(PROFILE_ERROR.notIcc);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(0);
  if (fourcc(bytes, 36) !== "acsp" || size < 132 || size > bytes.length) {
    return fail(PROFILE_ERROR.notIcc);
  }
  if (fourcc(bytes, 16) !== "RGB ") return fail(PROFILE_ERROR.notRgb);
  const tags = readTagTable(bytes, view, size);
  if (!tags) return fail(PROFILE_ERROR.notIcc);

  const colorantTags = ["rXYZ", "gXYZ", "bXYZ"].map((sig) => tags.get(sig));
  const curveTags = ["rTRC", "gTRC", "bTRC"].map((sig) => tags.get(sig));
  if (colorantTags.some((t) => !t) || curveTags.some((t) => !t)) {
    return fail(PROFILE_ERROR.noMatrix);
  }
  const colorants: Xyz[] = [];
  for (const tag of colorantTags) {
    const xyz = readXyz(bytes, view, tag!);
    if (!xyz) return fail(PROFILE_ERROR.notIcc);
    colorants.push(xyz);
  }
  const curves: Curve[] = [];
  for (const tag of curveTags) {
    const curve = readCurve(bytes, view, tag!);
    if (typeof curve === "string") return fail(curve);
    curves.push(curve);
  }

  const [r, g, b] = colorants;
  const toDisplay = plausiblePrimaries(r, g, b) ? invert(columns(r, g, b)) : null;
  if (!toDisplay) return fail(PROFILE_ERROR.primaries);
  const matrix = multiply(toDisplay, columns(...outputColorants("srgb")));
  return {
    ok: true,
    profile: {
      description: readDescription(bytes, view, tags.get("desc")),
      transform: { matrix: toColumnMajor(matrix), curve: nearestCurve(curves) },
    },
  };
}

/** Undo a monitor transform on a pixel read off the screen: monitor-encoded
 *  0..1 in, sRGB-linear 0..1 out, so the eyedroppers measure what they did
 *  before. Colours one of the two spaces can't hold are clipped. */
export function monitorToSrgbLinear(
  t: MonitorTransform,
): (r: number, g: number, b: number) => [number, number, number] {
  const decode = outputDecode(CURVE_SPACE[t.curve]);
  const back = invert(fromColumnMajor(t.matrix));
  if (!back) throw new Error("display transform is not invertible");
  return (r, g, b) => {
    const d = [decode(r), decode(g), decode(b)];
    return [
      clamp01(back[0] * d[0] + back[1] * d[1] + back[2] * d[2]),
      clamp01(back[3] * d[0] + back[4] * d[1] + back[5] * d[2]),
      clamp01(back[6] * d[0] + back[7] * d[1] + back[8] * d[2]),
    ];
  };
}
