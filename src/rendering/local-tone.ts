// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Highlights and Shadows for process version 2. The curves are the ones
// version 1 applies to each pixel (with Highlights > 0 rising into a white
// that climbs with its knee, where version 1 bends back down). Version 2 also
// runs them on the pixel's region and keeps the pixel's ratio to it, blended
// in with the slider, so recovered highlights and lifted shadows keep the
// texture inside them. The functions below are the TypeScript twins of the
// curves and the blend in LOCAL_TONE_GLSL and the version 2 tone block; the
// GPU suite checks the per-pixel curves against them on flat fields, where a
// pixel is its own region. The region base has no CPU twin.

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Exposure-scaled luminance `x` through the Highlights curve: the core
 *  shoulder, whose knee and white follow `h` (Highlights / 100), then the lift
 *  for h > 0. `e` is Exposure in stops. `skipShoulder`: the display transform
 *  owns its roll-off, so the shoulder only returns as h goes below 0. */
export function toneHighlights(x: number, e: number, h: number, skipShoulder: boolean): number {
  let knee = 0.85;
  let rolloff = 0.5;
  let white = 1;
  if (h < 0) {
    knee = mix(0.85, 0.15, -h);
    rolloff = mix(0.5, 0.2, -h);
  } else if (h > 0) {
    knee = mix(0.85, 2.0, h);
    rolloff = mix(0.5, 1.5, h);
    white = knee + 0.3 * rolloff;
  }
  rolloff = Math.max(rolloff, white - knee);
  rolloff *= Math.max(2 ** (Math.max(e, 0) * 0.5), 1);
  let y = x;
  if (x > knee) {
    const excess = x - knee;
    y = knee + ((white - knee) * excess) / (excess + rolloff);
  }
  if (skipShoulder) y = mix(x, y, Math.max(-h, 0));
  if (h > 0.001) {
    const y0 = Math.max(y, 1e-4);
    let z = mix(y0, y0 ** mix(1, 0.5, h), smoothstep(0.3, 0.9, y0) * h);
    if (skipShoulder) z = Math.max(z, y0);
    y = z;
  }
  return y;
}

/** Luminance `x` through the Shadows curve, `s` = Shadows / 100. */
export function toneShadows(x: number, s: number): number {
  if (Math.abs(s) <= 0.001) return x;
  const x0 = Math.max(x, 1e-4);
  const g = s > 0 ? mix(1, 0.65, s) : mix(1, 1.8, -s);
  return mix(x0, x0 ** g, Math.exp(-3 * x0) * Math.abs(s));
}

// Where a colour's strongest channel starts rolling off into white.
const PATH_START = 0.9;

/** A bright colour on its way to white. The core shoulder bounds luminance,
 *  not channels, so a saturated colour's strongest channel can pass white and
 *  clip on its own. Past PATH_START the colour is drawn straight toward the
 *  grey of its own luminance, just far enough that that channel rolls off into
 *  white: hue and luminance stay, and the colour whitens as it brightens. */
export function pathToWhite(c: readonly [number, number, number]): [number, number, number] {
  const peak = Math.max(c[0], c[1], c[2]);
  if (peak <= PATH_START) return [c[0], c[1], c[2]];
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (peak - L <= 1e-6) return [c[0], c[1], c[2]];
  const target =
    PATH_START + (1 - PATH_START) * (1 - Math.exp(-(peak - PATH_START) / (1 - PATH_START)));
  const s = Math.min(Math.max((target - L) / (peak - L), 0), 1);
  return [L + s * (c[0] - L), L + s * (c[1] - L), L + s * (c[2] - L)];
}

/** GLSL twins of pathToWhite, toneHighlights and toneShadows, and the region
 *  base the version 2 tone block runs them on. Spliced after applyWhiteBalance
 *  and baselineTone; reads uImage, uLinear, uIsFallbackPreview,
 *  uApplyBaseCurve, uApplyToneShoulder and the white-balance uniforms. */
export const LOCAL_TONE_GLSL = `
vec3 slPathToWhite(vec3 c) {
  float peak = max(max(c.r, c.g), c.b);
  if (peak <= 0.9) return c;
  float L = luma(c);
  if (peak - L <= 1e-6) return c;
  float target = 0.9 + 0.1 * (1.0 - exp(-(peak - 0.9) / 0.1));
  float s = clamp((target - L) / (peak - L), 0.0, 1.0);
  return vec3(L) + s * (c - vec3(L));
}

float slToneHighlights(float x, float E, float H) {
  float knee = 0.85;
  float rolloff = 0.5;
  float white = 1.0;
  if (H < 0.0) {
    knee = mix(0.85, 0.15, -H);
    rolloff = mix(0.5, 0.2, -H);
  } else if (H > 0.0) {
    knee = mix(0.85, 2.0, H);
    rolloff = mix(0.5, 1.5, H);
    white = knee + 0.3 * rolloff;
  }
  rolloff = max(rolloff, white - knee);
  rolloff *= max(exp2(max(E, 0.0) * 0.5), 1.0);
  float y = x;
  if (x > knee) {
    float excess = x - knee;
    y = knee + (white - knee) * excess / (excess + rolloff);
  }
  if (!uApplyToneShoulder) y = mix(x, y, max(-H, 0.0));
  if (H > 0.001) {
    float y0 = max(y, 1e-4);
    float z = mix(y0, pow(y0, mix(1.0, 0.5, H)), smoothstep(0.3, 0.9, y0) * H);
    if (!uApplyToneShoulder) z = max(z, y0);
    y = z;
  }
  return y;
}

float slToneShadows(float x, float S) {
  if (abs(S) <= 0.001) return x;
  float x0 = max(x, 1e-4);
  float g = S > 0.0 ? mix(1.0, 0.65, S) : mix(1.0, 1.8, -S);
  return mix(x0, pow(x0, g), exp(-3.0 * x0) * abs(S));
}

// The source at uv taken through the steps lin took before the tone block
// (decode, baseline tone, white balance), as log2 luminance.
float slLocalToneTap(vec2 uv, float lod, vec3 wb) {
  vec3 s = textureLod(uImage, uv, lod).rgb;
  if (!uLinear && !uIsFallbackPreview) s = srgbToLinear(s);
  if (uApplyBaseCurve) s = baselineTone(s);
  return log2(max(luma(s * wb), 1e-4));
}

// Luminance of the region around uv, in the pixel's units. First a guide: a
// small bilateral filter of the pixel (L, floored by the caller) with four
// diagonal taps 0.5% of the long edge away, each weighed by its distance
// from the pixel (sigma 1 EV). Noise averages into it; a tap across an edge
// drops out, so the guide stays on the pixel's side; a point more than about
// 2 EV off its surroundings is its own guide, so it follows the curve itself
// instead of taking its region's gain. Then 16 taps on two rings (2% and
// 4.5% of the long edge), each read at the mip level whose texels span the
// gap between taps, are weighed against the guide: a tap more than about
// 1.5 EV from it counts as the guide, so a region ends at a strong edge. The
// base is the geometric mean of the guide and the ring taps.
float slLocalToneBase(vec2 uv, float L) {
  vec2 size = vec2(textureSize(uImage, 0));
  float longEdge = max(size.x, size.y);
  vec3 wb = applyWhiteBalance(vec3(1.0), uTemperature, uTint, uAsShotTemperature);
  float p = log2(L);
  float guideLod = log2(max(0.785 * 0.005 * longEdge, 1.0));
  vec2 guideAxis = 0.005 * longEdge / size;
  float sum = p;
  float weight = 1.0;
  for (int i = 0; i < 4; i++) {
    float a = float(i) * 1.5707963268 + 0.7853981634;
    float s = slLocalToneTap(uv + vec2(cos(a), sin(a)) * guideAxis, guideLod, wb);
    float w = exp(-0.5 * (s - p) * (s - p));
    sum += w * s;
    weight += w;
  }
  float c = sum / weight;
  float acc = c;
  for (int ring = 0; ring < 2; ring++) {
    float r = ring == 0 ? 0.02 : 0.045;
    float lod = log2(max(0.785 * r * longEdge, 1.0));
    vec2 axis = r * longEdge / size;
    float turn = ring == 0 ? 0.0 : 0.3926990817;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981634 + turn;
      float s = slLocalToneTap(uv + vec2(cos(a), sin(a)) * axis, lod, wb);
      acc += mix(c, s, exp(-0.8888889 * (s - c) * (s - c)));
    }
  }
  return exp2(acc / 17.0);
}
`;

/** A pixel's luminance after Highlights (`l1`, which also sets the recovery's
 *  colourfulness boost) and after Shadows (`l2`). `L` is the pixel's linear
 *  luminance and `B` its region's, both before Exposure. Both luminances are
 *  floored at 1e-4, as the shader floors the pixel's and as its region base
 *  never goes lower. */
export function localToneBlend(
  L: number,
  B: number,
  e: number,
  h: number,
  s: number,
  skipShoulder: boolean,
): { l1: number; l2: number } {
  const gain = 2 ** e;
  const lx = Math.max(L, 1e-4) * gain;
  let l1 = toneHighlights(lx, e, h, skipShoulder);
  let l2 = toneShadows(l1, s);
  if (Math.abs(h) > 0.001 || Math.abs(s) > 0.001) {
    // Floored after Exposure too: below the curves' own 1e-4 floor a region's
    // Shadows gain would grow as Exposure goes down and cancel it.
    const bx = Math.max(Math.max(B, 1e-4) * gain, 1e-4);
    const b1 = toneHighlights(bx, e, h, skipShoulder);
    l1 = mix(l1, (lx * b1) / bx, Math.abs(h));
    l2 = mix(toneShadows(l1, s), (l1 * toneShadows(b1, s)) / b1, Math.abs(s));
  }
  return { l1, l2 };
}
