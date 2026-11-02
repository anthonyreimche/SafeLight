// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Row-major 3x3 matrix as a flat length-9 array:
//   [a b c]
//   [d e f]
//   [g h i]  ->  [a,b,c, d,e,f, g,h,i]
export type Mat3 = number[];

export interface Vec2 {
  x: number;
  y: number;
}

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
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

// Inverse of a row-major 3x3 (adjugate over determinant). Callers pass
// well-conditioned matrices (colour primaries), so no singular check.
export function mat3Invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c0 = e * i - f * h;
  const c1 = f * g - d * i;
  const c2 = d * h - e * g;
  const s = 1 / (a * c0 + b * c1 + c * c2);
  return [
    c0 * s, (c * h - b * i) * s, (b * f - c * e) * s,
    c1 * s, (a * i - c * g) * s, (c * d - a * f) * s,
    c2 * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
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
