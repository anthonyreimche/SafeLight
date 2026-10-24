// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 3's output stage in TypeScript, the twin of the shader's
// slOutput, expression for expression, so tests can hold the shader to it. A
// pixel goes from signed perceptual Rec.709 to the output's linear space and
// is gamut-mapped there. OkLab chroma is reduced at constant lightness and hue
// (CSS Color 4's method), with a soft knee: chroma below KNEE x the target's
// boundary is left alone, and everything from there out to the Rec.2020
// boundary is compressed into the rest, so texture past the gamut keeps its
// order instead of piling onto the boundary.

import { REC709_TO_REC2020, apply3, decodePerceptual, encodePerceptual, glslMat3, type Vec3 } from "./stage-space";
import { mat3ColumnMajor, mat3Invert, mat3Mul, type Mat3 } from "./transform";

export const KNEE = 0.95;
/** OkLab's just-noticeable difference. The gamut warning flags a pixel the
 *  output moves further than this. */
export const JND = 0.02;
/** Bisection steps per boundary search: 2^-10 of the range, far under the JND,
 *  at a fixed cost per mapped pixel. */
export const STEPS = 10;
/** How far the Rec.2020 boundary is searched for, in target boundaries. It
 *  reaches about 3.5 for the sRGB target (blue-violet), so 4 leaves margin.
 *  Below OkLab L ≈ 0.03 the INSIDE tolerance, not this cap, decides what counts
 *  as inside. */
export const WIDE_REACH = 4;
const POWER = 1.2; // the ACES gamut-compression curve's
// A channel this far outside [0, 1] still counts as inside: float32 rounding.
const INSIDE = 1e-5;
// How far past the display's cube the proof's may reach and still count as
// held whole: a monitor profile's s15Fixed16 rounding. On the sRGB curve that
// is under half a code value even at black.
const HOLDS = 1e-4;
/** Floor on the boundary's chroma ratio `lo`: keeps 1/lo finite when the
 *  boundary lies within the last bisection step of grey. */
export const LO_FLOOR = 1e-4;
/** Floor on the knee curve's limit: keeps its scale finite when Rec.2020 is no
 *  wider than the target, as for ProPhoto. */
export const LIMIT_FLOOR = 1.0001;

// OkLab (Björn Ottosson), row-major: linear sRGB to LMS, and cube-rooted LMS to Lab.
const M1: Mat3 = [
  0.4122214708, 0.5363325363, 0.0514459929,
  0.2119034982, 0.6806995451, 0.1073969566,
  0.0883024619, 0.2817188376, 0.6299787005,
];
const M2: Mat3 = [
  0.2104542553, 0.793617785, -0.0040720468,
  1.9779984951, -2.428592205, 0.4505937099,
  0.0259040371, 0.7827717662, -0.808675766,
];
const M1_INV = mat3Invert(M1);
const M2_INV = mat3Invert(M2);
const LMS_TO_REC2020 = mat3Mul(REC709_TO_REC2020, M1_INV);

/** OkLab's LMS matrix composed with the output's sRGB-linear to target-linear
 *  `out` (row-major): target-linear to LMS, and back. */
export function lmsMatrices(out: Mat3): { toLms: Mat3; fromLms: Mat3 } {
  return { toLms: mat3Mul(M1, mat3Invert(out)), fromLms: mat3Mul(out, M1_INV) };
}

const rowMajor = (c: Float32Array): Mat3 => [c[0], c[3], c[6], c[1], c[4], c[7], c[2], c[5], c[8]];

/** lmsMatrices for uOutMatrix as the renderer uploads it, column-major. */
export function lmsUniforms(outColumnMajor: Float32Array): { toLms: Float32Array; fromLms: Float32Array } {
  const { toLms, fromLms } = lmsMatrices(rowMajor(outColumnMajor));
  return { toLms: mat3ColumnMajor(toLms), fromLms: mat3ColumnMajor(fromLms) };
}

/** Proof-linear to display-linear, from both spaces' sRGB-linear matrices. */
const proofToOut = (proof: Mat3, out: Mat3): Mat3 => mat3Mul(out, mat3Invert(proof));

/** Whether `toOut` takes the proof's whole [0, 1] cube into the display's. The
 *  display then shows every proofed colour as it is; mapping it again would
 *  compress the proof's edge by the knee where the two boundaries meet, as
 *  sRGB's and Display P3's do along their shared blue primary. */
function holdsProof(toOut: Mat3): boolean {
  return [0, 3, 6].every((row) => {
    const entries = toOut.slice(row, row + 3);
    const low = entries.reduce((sum, x) => sum + Math.min(x, 0), 0);
    const high = entries.reduce((sum, x) => sum + Math.max(x, 0), 0);
    return low >= -HOLDS && high <= 1 + HOLDS;
  });
}

/** The proof uniforms, from the proof's and the display's uOutMatrix as the
 *  renderer uploads them, column-major: the proof's LMS pair (lmsUniforms),
 *  proof-linear to display-linear, and whether the display holds the proof
 *  space whole. */
export function proofUniforms(
  proofColumnMajor: Float32Array,
  outColumnMajor: Float32Array,
): { toLms: Float32Array; fromLms: Float32Array; toOut: Float32Array; fits: boolean } {
  const toOut = proofToOut(rowMajor(proofColumnMajor), rowMajor(outColumnMajor));
  return { ...lmsUniforms(proofColumnMajor), toOut: mat3ColumnMajor(toOut), fits: holdsProof(toOut) };
}

const okLab = (lms: Vec3): Vec3 => apply3(M2, [Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2])]);
const cube = (v: Vec3): Vec3 => [v[0] ** 3, v[1] ** 3, v[2] ** 3];
const inside = (rgb: Vec3): boolean => rgb.every((x) => x >= -INSIDE && x <= 1 + INSIDE);
const clamp01 = (v: Vec3): Vec3 => [
  Math.min(Math.max(v[0], 0), 1), Math.min(Math.max(v[1], 0), 1), Math.min(Math.max(v[2], 0), 1),
];

/** The ACES gamut-compression curve from KNEE: `d` = `lim` maps to 1. The early
 *  return below KNEE keeps `nd` non-negative, as pow of a negative base is
 *  undefined. */
function kneeCurve(d: number, lim: number): number {
  if (d < KNEE) return d;
  const scale = (lim - KNEE) / Math.pow(Math.pow((1 - KNEE) / (lim - KNEE), -POWER) - 1, 1 / POWER);
  const nd = (d - KNEE) / scale;
  return KNEE + (scale * nd) / Math.pow(1 + Math.pow(nd, POWER), 1 / POWER);
}

/** Signed target-linear RGB into [0, 1]^3, at the pixel's OkLab lightness and hue. */
export function gamutMap(lin: Vec3, m: { toLms: Mat3; fromLms: Mat3 }): Vec3 {
  const ok = okLab(apply3(m.toLms, lin));
  if (ok[0] >= 1) return [1, 1, 1];
  if (ok[0] <= 0) return [0, 0, 0];
  // The colour at `s` times its chroma, in `toRgb`'s space.
  const at = (s: number, toRgb: Mat3): Vec3 => apply3(toRgb, cube(apply3(M2_INV, [ok[0], ok[1] * s, ok[2] * s])));
  if (inside(at(1 / KNEE, m.fromLms))) return clamp01(lin);
  let lo = 0;
  let hi = 1 / KNEE;
  for (let i = 0; i < STEPS; i++) {
    const mid = 0.5 * (lo + hi);
    if (inside(at(mid, m.fromLms))) lo = mid;
    else hi = mid;
  }
  let wide = 1;
  let far = WIDE_REACH;
  for (let i = 0; i < STEPS; i++) {
    const mid = 0.5 * (wide + far);
    if (inside(at(lo * mid, LMS_TO_REC2020))) wide = mid;
    else far = mid;
  }
  const s = lo * Math.min(kneeCurve(1 / Math.max(lo, LO_FLOOR), Math.max(wide, LIMIT_FLOOR)), 1);
  return clamp01(at(s, m.fromLms));
}

/** Signed perceptual Rec.709 `c` in the target's linear space, before mapping. */
const targetLinear = (c: Vec3, out: Mat3): Vec3 =>
  apply3(out, [decodePerceptual(c[0]), decodePerceptual(c[1]), decodePerceptual(c[2])]);

/** slOutputLinear: `c` mapped into the target, through the proof space first
 *  when there is one. */
function outputLinear(c: Vec3, out: Mat3, proof?: Mat3): Vec3 {
  let lin = targetLinear(c, out);
  if (proof) {
    const toOut = proofToOut(proof, out);
    lin = apply3(toOut, gamutMap(targetLinear(c, proof), lmsMatrices(proof)));
    if (holdsProof(toOut)) return clamp01(lin);
  }
  return gamutMap(lin, lmsMatrices(out));
}

/** slOutput: signed perceptual Rec.709 `c` to the target's encoding. */
export function outputPixel(c: Vec3, out: Mat3, code: number, proof?: Mat3): Vec3 {
  const lin = outputLinear(c, out, proof);
  const encode = (x: number): number =>
    code === 2 ? Math.pow(x, 1 / 2.19921875)
    : code === 3 ? (x < 0.001953125 ? x * 16 : Math.pow(x, 1 / 1.8))
    : encodePerceptual(x);
  return [encode(lin[0]), encode(lin[1]), encode(lin[2])];
}

/** slGamutShift: how far, in OkLab, the output moves `c`. */
export function gamutShift(c: Vec3, out: Mat3, proof?: Mat3): number {
  const { toLms } = lmsMatrices(out);
  const from = okLab(apply3(toLms, targetLinear(c, out)));
  const to = okLab(apply3(toLms, outputLinear(c, out, proof)));
  return Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
}

// The shader prints the constants above, so the twins can't drift. GLSL ES has
// no int-to-float conversion: a whole number must print as 4.0, not 4.
const glslFloat = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const knee = glslFloat(KNEE);
const power = glslFloat(POWER);

/** The version 3 output stage: gamutMap, outputPixel and gamutShift in GLSL.
 *  Needs slDecodePerceptual (STAGE_SPACE_GLSL), linearToSrgb, and the uniforms
 *  uOutSpace, uOutMatrix, uOutToLms and uLmsToOut (lmsUniforms), with uProof,
 *  uProofMatrix (the proof's uOutMatrix), uProofToLms, uLmsToProof, uProofToOut
 *  and uProofFits (proofUniforms). */
export const OUTPUT_MAP_GLSL = `const mat3 SL_OK_M2 = ${glslMat3(M2)};
const mat3 SL_OK_M2_INV = ${glslMat3(M2_INV)};
const mat3 SL_LMS_TO_REC2020 = ${glslMat3(LMS_TO_REC2020)};
const float SL_OK_JND = ${glslFloat(JND)};
vec3 slOkLab(vec3 lms) {
  return SL_OK_M2 * (sign(lms) * pow(abs(lms), vec3(1.0 / 3.0)));
}
bool slInside(vec3 rgb) {
  return all(greaterThanEqual(rgb, vec3(${glslFloat(-INSIDE)}))) && all(lessThanEqual(rgb, vec3(${glslFloat(1 + INSIDE)})));
}
vec3 slOkAt(vec3 ok, float s, mat3 toRgb) {
  vec3 l = SL_OK_M2_INV * vec3(ok.x, ok.yz * s);
  return toRgb * (l * l * l);
}
float slKneeCurve(float d, float lim) {
  if (d < ${knee}) return d;
  float scale = (lim - ${knee}) / pow(pow((1.0 - ${knee}) / (lim - ${knee}), -${power}) - 1.0, 1.0 / ${power});
  float nd = (d - ${knee}) / scale;
  return ${knee} + scale * nd / pow(1.0 + pow(nd, ${power}), 1.0 / ${power});
}
vec3 slGamutMap(vec3 lin, mat3 toLms, mat3 fromLms) {
  vec3 ok = slOkLab(toLms * lin);
  if (ok.x >= 1.0) return vec3(1.0);
  if (ok.x <= 0.0) return vec3(0.0);
  if (slInside(slOkAt(ok, 1.0 / ${knee}, fromLms))) return clamp(lin, 0.0, 1.0);
  float lo = 0.0;
  float hi = 1.0 / ${knee};
  for (int i = 0; i < ${STEPS}; i++) {
    float mid = 0.5 * (lo + hi);
    if (slInside(slOkAt(ok, mid, fromLms))) lo = mid; else hi = mid;
  }
  float wide = 1.0;
  float far = ${glslFloat(WIDE_REACH)};
  for (int i = 0; i < ${STEPS}; i++) {
    float mid = 0.5 * (wide + far);
    if (slInside(slOkAt(ok, lo * mid, SL_LMS_TO_REC2020))) wide = mid; else far = mid;
  }
  float s = lo * min(slKneeCurve(1.0 / max(lo, ${glslFloat(LO_FLOOR)}), max(wide, ${glslFloat(LIMIT_FLOOR)})), 1.0);
  return clamp(slOkAt(ok, s, fromLms), 0.0, 1.0);
}
vec3 slOutputLinear(vec3 c) {
  vec3 dec = slDecodePerceptual(c);
  vec3 lin = uOutMatrix * dec;
  if (uProof) {
    lin = uProofToOut * slGamutMap(uProofMatrix * dec, uProofToLms, uLmsToProof);
    if (uProofFits) return clamp(lin, 0.0, 1.0);
  }
  return slGamutMap(lin, uOutToLms, uLmsToOut);
}
vec3 slEncodeOutput(vec3 lin) {
  if (uOutSpace == 2) return pow(lin, vec3(1.0 / 2.19921875));
  if (uOutSpace == 3) return mix(lin * 16.0, pow(lin, vec3(1.0 / 1.8)), step(0.001953125, lin));
  return linearToSrgb(lin);
}
vec3 slOutput(vec3 c) {
  return slEncodeOutput(slOutputLinear(c));
}
float slGamutShift(vec3 c, vec3 mapped) {
  return distance(slOkLab(uOutToLms * (uOutMatrix * slDecodePerceptual(c))), slOkLab(uOutToLms * mapped));
}
`;
