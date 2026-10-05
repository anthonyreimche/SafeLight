// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The values a processing stage can ask for (StageSpace) and the conversions
// the core wraps around it. The core's working values are linear Rec.709
// before the display transform ("scene") and the transform's sRGB-encoded
// output after it ("display"); a stage that declares another space is handed
// its variable converted and hands it back converted. Everything here inverts
// to float precision, so a stage that changes nothing changes nothing.

import type { StageSpace } from "@/extensions/types";
import { mat3Invert, type Mat3 } from "./transform";

export type StageDomain = "scene" | "display";
export type Vec3 = readonly [number, number, number];

/** Linear Rec.709 → linear Rec.2020 (ITU-R BT.2087), row-major. */
export const REC709_TO_REC2020: Mat3 = [
  0.627403895934699, 0.329283038377884, 0.043313065687417,
  0.069097289358232, 0.919540395075459, 0.011362315566309,
  0.016391438875150, 0.088013307877226, 0.895595253247624,
];
export const REC2020_TO_REC709: Mat3 = mat3Invert(REC709_TO_REC2020);

/** The sRGB curve applied to |x| with the sign put back and no ceiling. */
export function encodePerceptual(x: number): number {
  const a = Math.abs(x);
  const e = a < 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return Math.sign(x) * e;
}

export function decodePerceptual(y: number): number {
  const a = Math.abs(y);
  const d = a < 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
  return Math.sign(y) * d;
}

const encodingOf = (space: StageSpace | undefined, domain: StageDomain) =>
  space?.encoding ?? (domain === "scene" ? "linear" : "perceptual");
const isWide = (space: StageSpace | undefined) => space?.primaries === "rec2020";

export function spaceKey(space: StageSpace | undefined, domain: StageDomain): string {
  return `${encodingOf(space, domain)}/${isWide(space) ? "rec2020" : "rec709"}`;
}

/** True when the stage's space is the domain's working space. */
export function isIdentitySpace(space: StageSpace | undefined, domain: StageDomain): boolean {
  return spaceKey(space, domain) === spaceKey(undefined, domain);
}

function apply3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
const each = (v: Vec3, f: (x: number) => number): Vec3 => [f(v[0]), f(v[1]), f(v[2])];

// Both directions go through linear light: decode the working encoding,
// rotate primaries, encode the target. The working encoding is linear in the
// scene domain and perceptual in the display domain.
export function toStageSpace(rgb: Vec3, space: StageSpace, domain: StageDomain): Vec3 {
  let lin = domain === "scene" ? rgb : each(rgb, decodePerceptual);
  if (isWide(space)) lin = apply3(REC709_TO_REC2020, lin);
  return space.encoding === "linear" ? lin : each(lin, encodePerceptual);
}

export function fromStageSpace(rgb: Vec3, space: StageSpace, domain: StageDomain): Vec3 {
  let lin = space.encoding === "linear" ? rgb : each(rgb, decodePerceptual);
  if (isWide(space)) lin = apply3(REC2020_TO_REC709, lin);
  return domain === "scene" ? lin : each(lin, encodePerceptual);
}

// GLSL mat3 is column-major: emit the transpose of the row-major array.
function glslMat3(m: Mat3): string {
  const columnMajor = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  return `mat3(${columnMajor.map((x) => x.toFixed(12)).join(", ")})`;
}

/** The helpers every conversion expression uses. `sl` names can't collide
 *  with stage helpers, which the injector namespaces with `_xxxx_`. Computed
 *  on |x| because GLSL pow is undefined for a negative base, and mix
 *  propagates that even from the branch it doesn't select. */
export const STAGE_SPACE_GLSL = `const mat3 SL_REC709_TO_REC2020 = ${glslMat3(REC709_TO_REC2020)};
const mat3 SL_REC2020_TO_REC709 = ${glslMat3(REC2020_TO_REC709)};
vec3 slEncodePerceptual(vec3 x) {
  vec3 a = abs(x);
  vec3 e = mix(a * 12.92, 1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, a));
  return sign(x) * e;
}
vec3 slDecodePerceptual(vec3 y) {
  vec3 a = abs(y);
  vec3 d = mix(a / 12.92, pow((a + 0.055) / 1.055, vec3(2.4)), step(0.04045, a));
  return sign(y) * d;
}
`;

/** GLSL for working value `v` in the stage's space; `v` itself when identity.
 *  `v` must be a variable or call expression (spliced without parentheses). */
export function toSpaceExpr(space: StageSpace | undefined, domain: StageDomain, v: string): string {
  if (!space || isIdentitySpace(space, domain)) return v;
  let lin = domain === "scene" ? v : `slDecodePerceptual(${v})`;
  if (isWide(space)) lin = `SL_REC709_TO_REC2020 * ${lin}`;
  return space.encoding === "linear"
    ? isWide(space)
      ? `(${lin})`
      : lin
    : `slEncodePerceptual(${lin})`;
}

/** GLSL for the stage's value `v` back in working values; `v` when identity.
 *  `v` must be a variable or call expression (spliced without parentheses). */
export function fromSpaceExpr(
  space: StageSpace | undefined,
  domain: StageDomain,
  v: string,
): string {
  if (!space || isIdentitySpace(space, domain)) return v;
  let lin = space.encoding === "linear" ? v : `slDecodePerceptual(${v})`;
  if (isWide(space)) lin = `SL_REC2020_TO_REC709 * ${lin}`;
  return domain === "scene"
    ? isWide(space)
      ? `(${lin})`
      : lin
    : `slEncodePerceptual(${lin})`;
}
