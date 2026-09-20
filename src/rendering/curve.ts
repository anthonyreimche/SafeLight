// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CurvePoint, ToneCurves } from "@/catalog/types";

// Monotone cubic Hermite interpolation (Fritsch–Carlson). Produces smooth,
// overshoot-free tone curves through the control points — the standard choice
// for photo tone curves.
export function makeCurveEvaluator(
  points: CurvePoint[],
): (x: number) => number {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const n = sorted.length;

  if (n === 0) return (x) => x;
  if (n === 1) return () => clamp01(sorted[0].y);

  const xs = sorted.map((p) => p.x);
  const ys = sorted.map((p) => p.y);

  // Secant slopes between consecutive points.
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    delta.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx);
  }

  // Tangents.
  const m: number[] = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }

  // Enforce monotonicity.
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i];
      m[i + 1] = t * b * delta[i];
    }
  }

  return (x: number): number => {
    if (x <= xs[0]) return clamp01(ys[0]);
    if (x >= xs[n - 1]) return clamp01(ys[n - 1]);

    let i = 0;
    while (i < n - 1 && x > xs[i + 1]) i++;

    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const y =
      h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
    return clamp01(y);
  };
}

// Build a 256-entry LUT (input index -> output value 0..255) for the GPU.
export function buildCurveLUT(points: CurvePoint[]): Uint8Array {
  const evaluate = makeCurveEvaluator(points);
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const y = evaluate(i / 255);
    lut[i] = Math.round(clamp01(y) * 255);
  }
  return lut;
}

// Compose the master (RGB) curve with each per-channel curve into one 256×1
// RGBA LUT. Order matches LR: the user's master curve, then the channel's own
// curve, so finalChannel[i] = channelCurve(rgbCurve(i)). The shader samples
// .r/.g/.b. The default baseline look is not in here — it is baselineTone in
// the shader, applied in linear light and gated to RAW sources. Float
// evaluators compose continuously and quantize ONCE at the end — chaining 8-bit
// LUT lookups compounds rounding into visible posterization.
export function buildRGBCurveLUT(curves: ToneCurves): Uint8Array {
  const rgbEval = makeCurveEvaluator(curves.rgb);
  const redEval = makeCurveEvaluator(curves.red);
  const greenEval = makeCurveEvaluator(curves.green);
  const blueEval = makeCurveEvaluator(curves.blue);

  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const base = rgbEval(i / 255);
    out[i * 4] = Math.round(redEval(base) * 255);
    out[i * 4 + 1] = Math.round(greenEval(base) * 255);
    out[i * 4 + 2] = Math.round(blueEval(base) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Per-mask curve LUT: master + per-channel curves composed, starting from the
// already-developed display colour. Layout matches buildRGBCurveLUT (256 RGBA).
export function buildMaskCurveLUT(curves: ToneCurves, out?: Uint8Array, offset = 0): Uint8Array {
  const rgbEval = makeCurveEvaluator(curves.rgb);
  const redEval = makeCurveEvaluator(curves.red);
  const greenEval = makeCurveEvaluator(curves.green);
  const blueEval = makeCurveEvaluator(curves.blue);
  const buf = out ?? new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const base = rgbEval(i / 255);
    const o = offset + i * 4;
    buf[o] = Math.round(redEval(base) * 255);
    buf[o + 1] = Math.round(greenEval(base) * 255);
    buf[o + 2] = Math.round(blueEval(base) * 255);
    buf[o + 3] = 255;
  }
  return buf;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
