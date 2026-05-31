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
// RGBA LUT: the master curve is applied first, then the channel's own curve, so
// finalChannel[i] = channelCurve(rgbCurve(i)). The shader samples .r/.g/.b.
export function buildRGBCurveLUT(curves: ToneCurves): Uint8Array {
  const rgb = buildCurveLUT(curves.rgb);
  const red = buildCurveLUT(curves.red);
  const green = buildCurveLUT(curves.green);
  const blue = buildCurveLUT(curves.blue);

  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const base = rgb[i];
    out[i * 4] = red[base];
    out[i * 4 + 1] = green[base];
    out[i * 4 + 2] = blue[base];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
