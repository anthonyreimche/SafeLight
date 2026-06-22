// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { TransformParams } from "@/catalog/types";

// Row-major 3x3 matrix as a flat length-9 array:
//   [a b c]
//   [d e f]
//   [g h i]  ->  [a,b,c, d,e,f, g,h,i]
export type Mat3 = number[];

export interface Vec2 {
  x: number;
  y: number;
}

function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const m: number[] = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      m[r * 3 + col] =
        a[r * 3 + 0] * b[0 * 3 + col] +
        a[r * 3 + 1] * b[1 * 3 + col] +
        a[r * 3 + 2] * b[2 * 3 + col];
    }
  }
  return m;
}

// Apply a (possibly projective) 3x3 to a 2D point, dividing through by w.
export function mat3Apply(m: Mat3, x: number, y: number): Vec2 {
  const px = m[0] * x + m[1] * y + m[2];
  const py = m[3] * x + m[4] * y + m[5];
  const pw = m[6] * x + m[7] * y + m[8];
  const w = pw !== 0 ? pw : 1e-6;
  return { x: px / w, y: py / w };
}

// WebGL expects column-major; transpose our row-major into a Float32Array.
export function mat3ColumnMajor(m: Mat3): Float32Array {
  return new Float32Array([
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ]);
}

function rot(theta: number): Mat3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function diag(sx: number, sy: number): Mat3 {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

function translate(tx: number, ty: number): Mat3 {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

// Normalized image coords (0..1) -> centered "square" coords where rotation is
// circular: X = (x-0.5)*aspect, Y = (y-0.5). Returns [A, Ainv].
function squareBasis(aspect: number): [Mat3, Mat3] {
  const A: Mat3 = [aspect, 0, -0.5 * aspect, 0, 1, -0.5, 0, 0, 1];
  const Ainv: Mat3 = [1 / aspect, 0, 0.5, 0, 1, 0.5, 0, 0, 1];
  return [A, Ainv];
}

// Map the transform sliders to the geometric coefficients used in square space.
function coeffs(straighten: number, t: TransformParams, aspect: number) {
  return {
    theta: (straighten * Math.PI) / 180,
    gh: (t.perspectiveH / 100) * 0.6, // horizontal keystone
    gv: (t.perspectiveV / 100) * 0.6, // vertical keystone
    as: Math.pow(1.5, t.aspect / 100), // horizontal stretch factor
    s: Math.pow(2, (t.scale - 100) / 200), // zoom factor (100 = 1x)
    tx: (t.offsetX / 100) * 0.5 * aspect,
    ty: (t.offsetY / 100) * 0.5,
    fh: t.flipH ? -1 : 1,
    fv: t.flipV ? -1 : 1,
  };
}

// Inverse transform: a point in the (cropped) transformed image -> source UV.
// Used by the shader and by all crop-constraint geometry. Reduces exactly to
// the legacy straighten-only mapping when only `straighten` is set.
export function buildInverseTransform(
  straighten: number,
  transform: TransformParams,
  aspect: number,
): Mat3 {
  const { theta, gh, gv, as, s, tx, ty, fh, fv } = coeffs(straighten, transform, aspect);
  const [A, Ainv] = squareBasis(aspect);
  // Msq_inv = Rot(θ) · Flip · Persp⁻¹ · Aspect⁻¹ · Scale⁻¹ · Offset⁻¹  (square space)
  const flipM = diag(fh, fv);
  const perspInv: Mat3 = [1, 0, 0, 0, 1, 0, -gh, -gv, 1];
  const aspectInv = diag(1 / as, as);
  const scaleInv = diag(1 / s, 1 / s);
  const offsetInv = translate(-tx, -ty);
  let msq = mat3Mul(rot(theta), flipM);
  msq = mat3Mul(msq, perspInv);
  msq = mat3Mul(msq, aspectInv);
  msq = mat3Mul(msq, scaleInv);
  msq = mat3Mul(msq, offsetInv);
  return mat3Mul(Ainv, mat3Mul(msq, A));
}

// Forward transform: source UV -> transformed image coords. Used to enclose the
// warped image for the crop-mode view.
export function buildForwardTransform(
  straighten: number,
  transform: TransformParams,
  aspect: number,
): Mat3 {
  const { theta, gh, gv, as, s, tx, ty, fh, fv } = coeffs(straighten, transform, aspect);
  const [A, Ainv] = squareBasis(aspect);
  // Msq = Offset · Scale · Aspect · Persp · Flip · Rot(−θ)
  const persp: Mat3 = [1, 0, 0, 0, 1, 0, gh, gv, 1];
  const flipM = diag(fh, fv);
  let msq = mat3Mul(translate(tx, ty), diag(s, s));
  msq = mat3Mul(msq, diag(as, 1 / as));
  msq = mat3Mul(msq, persp);
  msq = mat3Mul(msq, flipM);
  msq = mat3Mul(msq, rot(-theta));
  return mat3Mul(Ainv, mat3Mul(msq, A));
}
