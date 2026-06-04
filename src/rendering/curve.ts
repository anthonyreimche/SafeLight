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

// Adobe Color baseline tone response (approximation).
//
// Lightroom's "Adobe Color" profile bakes a base tone curve into the render
// *before* any slider or point-curve edit. SafeLight had no profile (flat
// identity), which is why its render didn't match LR. The Adobe Color baseline
// is a contrast curve that sits BELOW the diagonal: it anchors/crushes the
// blacks and gently darkens the lower midtones, then rejoins at white — giving
// the deep blacks and contrast LR shows (its histogram touches the left edge).
//
// These points match the hand-tuned curve verified against Lightroom for the
// reference shot. Points are display-space (x = input 0..1 -> y = output 0..1).
// Tune to taste: lower the 0.13/0.5 y-values for deeper blacks / more contrast,
// raise them toward the diagonal for a flatter look.
// NOTE: applied to every image, RAW or not — a future profile system should gate
// this to RAW / make it selectable.
const ADOBE_COLOR_BASE: CurvePoint[] = [
  { x: 0.0, y: 0.0 },
  { x: 0.13, y: 0.04 },
  { x: 0.5, y: 0.42 },
  { x: 0.75, y: 0.7 },
  { x: 1.0, y: 1.0 },
];

// Compose the profile base curve with the master (RGB) curve and each per-channel
// curve into one 256×1 RGBA LUT. Order matches LR: profile baseline first, then
// the user's master curve, then the channel's own curve, so
// finalChannel[i] = channelCurve(rgbCurve(baseCurve(i))). The shader samples .r/.g/.b.
export function buildRGBCurveLUT(curves: ToneCurves): Uint8Array {
  const baseProfile = buildCurveLUT(ADOBE_COLOR_BASE);
  const rgb = buildCurveLUT(curves.rgb);
  const red = buildCurveLUT(curves.red);
  const green = buildCurveLUT(curves.green);
  const blue = buildCurveLUT(curves.blue);

  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const base = rgb[baseProfile[i]];
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
