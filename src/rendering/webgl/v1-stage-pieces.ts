// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 1's stage GLSL as the injector builds it for the fixtures in
// v1-identity.fixtures.ts, one piece per injection group and anchor. These were
// b1f5ec5's pieces (v1-reference-shader.ts, never edited) until the core tools
// began moving onto the stage path (#178); since then they are re-baselined
// with each move, always with the whole program in program-reference.ts
// unchanged. Generated; regenerate rather than edit by hand.
// - 2026-10-30, Color Grading: its uniforms, helpers and block move into the
//   builtin and legacyExtensions pieces and its anchor.
// - 2026-10-30, HSL: applyHSL and the band arrays move into the pieces and the
//   hsl anchor.
// - 2026-10-30, Tone Curve: applyToneCurve and its table's sampler move into
//   the pieces and the tone-curve anchor.
// - 2026-10-30, White Balance: its two sliders' uniforms and its line move into
//   the pieces and the white-balance anchor.
// - 2026-10-30, Basic and Sharpening: their blocks and uniforms move into the
//   pieces and the tone, display-basic, presence, band-detail, vibrance and
//   sharpen anchors.
// - 2026-10-31, HSL left core: uHslRange and uHslSmooth, Preferences ▸ HSL's
//   band shaping, are its stage's uniforms now, declared with its others.
// - 2026-11-01, Crop & Straighten left core: its geometry uniforms and
//   cropTransformUV move into the pieces, and the geometry anchor (empty).
// - 2026-11-01, Heal left core: its spot uniforms, constants, brush atlas and
//   helpers (membraneCorrection, applyRetouch) move into the pieces, and the
//   retouch anchor (empty).
// - 2026-11-01, Masking left core: its mask and component uniforms, curve
//   atlas and compCoverage move into the pieces, and the masks anchor
//   (empty).

export interface V1StagePieces {
  uniforms: string;
  helpers: string;
  srcUv: string;
  noiseReduction: string;
  sceneLinear: string;
  effects: string;
  anchors: Record<string, string>;
}

export const V1_STAGE_PIECES: Record<string, V1StagePieces> = {
  builtin: {
    uniforms: `uniform vec4 uCrop;
uniform mat3 uInvTransform;
#define MAX_SPOTS 32
#define MAX_RBRUSH 4
uniform int uSpotCount;
uniform vec4 uSpotA[MAX_SPOTS];
uniform vec4 uSpotB[MAX_SPOTS];
uniform vec4 uSpotC[MAX_SPOTS];
uniform vec4 uSpotTint[MAX_SPOTS];
uniform int uRetouchCount;
uniform int uRetouchCh[MAX_RBRUSH];
uniform vec4 uRetouchData[MAX_RBRUSH];
uniform bool uMembraneHeal;
uniform sampler2D uRetouchTex;
uniform sampler2D u_6zr4_stageResult;
uniform float uTemperature;
uniform float uTint;
uniform float uExposure;
uniform float uHighlights;
uniform float uShadows;
uniform int uMaskCount;
uniform int uMaskInvert[MAX_MASKS];
uniform float uMaskOpacity[MAX_MASKS];
uniform int uCompCount;
uniform int uCompMaskIdx[MAX_COMPONENTS];
uniform int uCompMode[MAX_COMPONENTS];
uniform int uCompType[MAX_COMPONENTS];
uniform int uCompInvert[MAX_COMPONENTS];
uniform int uCompBrushCh[MAX_COMPONENTS];
uniform vec4 uCompGeoA[MAX_COMPONENTS];
uniform vec4 uCompGeoB[MAX_COMPONENTS];
uniform vec4 uMaskAdj0[MAX_MASKS];
uniform vec4 uMaskAdj1[MAX_MASKS];
uniform vec4 uMaskAdj2[MAX_MASKS];
uniform vec4 uMaskAdj3[MAX_MASKS];
uniform int uMaskHasHsl[MAX_MASKS];
uniform vec4 uMaskHsl[MAX_MASKS * 6];
uniform int uMaskHasCurve[MAX_MASKS];
uniform sampler2D uMaskCurves;
uniform float uWhites;
uniform float uBlacks;
uniform float uContrast;
uniform sampler2D uCurve;
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform float uHslRange;
uniform float uHslSmooth;
uniform float uTexture;
uniform float uClarity;
uniform float uDehaze;
uniform float uHighlightDetail;
uniform float uShadowDetail;
uniform float uVibrance;
uniform float uSaturation;
uniform float uCGShadowHue;
uniform float uCGShadowSat;
uniform float uCGShadowLuma;
uniform float uCGMidHue;
uniform float uCGMidSat;
uniform float uCGMidLuma;
uniform float uCGHighHue;
uniform float uCGHighSat;
uniform float uCGHighLuma;
uniform float uCGGlobalHue;
uniform float uCGGlobalSat;
uniform float uCGGlobalLuma;
uniform float uCGShadowRange;
uniform float uCGHighlightRange;
uniform float uSharpening;
uniform float uSharpenRadius;
uniform float uSharpenDetail;
uniform float uSharpenMasking;
uniform float uVignetteAmount;
uniform float uVignetteMidpoint;
uniform float uVignetteRoundness;
uniform float uVignetteFeather;
uniform float uVignetteHighlights;
uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uGrainRoughness;
uniform float uGrainColor;`,
    helpers: `// The view's point (output, crop coordinates) to source UV: through the crop
// to the transformed image, then the geometry transform's inverse (straighten,
// perspective, stretch, scale, offset), which is independent of the crop. vUv
// already has V flipped, so both are in top-left-origin image space.
vec2 cropTransformUV(vec2 o) {
  vec2 p = uCrop.xy + o * uCrop.zw;
  vec3 q = uInvTransform * vec3(p, 1.0);
  return q.xy / q.z;
}

// ---- Retouch: spot heal / clone -------------------------------------------
// Closed-form gradient-domain (membrane) correction for a heal spot. Samples the
// boundary mismatch (destination - source) just outside the disc and interpolates
// it across the interior with inverse-distance (Shepard) weights — a smooth
// low-frequency field that makes the copied source meet its surroundings
// seamlessly even across a tone gradient. This is the per-pixel generalisation of
// the single mean-colour offset carried in uSpotTint. Both terms sample uImage so
// the correction stays in source space (it is added to the source patch, then the
// whole patched image is developed downstream — matching the flat-tint path).
vec3 membraneCorrection(vec2 dst, vec2 src, vec4 tc, float radius, vec2 uv) {
  vec2 q = vec2((uv.x - dst.x) * uImageAspect, uv.y - dst.y); // pixel in aspect space
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  const int N = 16;
  for (int k = 0; k < N; k++) {
    float a = (float(k) + 0.5) / float(N) * 6.2831853;
    vec2 e = vec2(cos(a), sin(a)) * radius * 1.04;       // boundary point (aspect space)
    vec2 dUv = clamp(dst + vec2(e.x / uImageAspect, e.y), 0.0, 1.0);
    // Same inverse rotate+scale the patch fetch uses, so the source boundary point
    // corresponds to the same place in the copied texture.
    float rx = (tc.x * e.x + tc.y * e.y) * tc.z;
    float ry = (-tc.y * e.x + tc.x * e.y) * tc.z;
    vec2 sUv = clamp(src + vec2(rx / uImageAspect, ry), 0.0, 1.0);
    // Explicit LOD: this runs in divergent control flow (inside the per-spot
    // branch), where auto-LOD derivatives are undefined and sample wrong mips.
    vec3 delta = textureLod(uImage, dUv, 0.0).rgb - textureLod(uImage, sUv, 0.0).rgb;
    float dist = length(q - e) + 1e-3;
    float w = 1.0 / (dist * dist);                        // mean-value-style weighting
    acc += delta * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-4);
}

vec3 applyRetouch(vec2 uv, vec3 base) {
  vec3 c = base;
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (i >= uSpotCount) break;
    vec4 a = uSpotA[i];
    vec4 b = uSpotB[i];
    vec2 dst = a.xy;
    vec2 src = a.zw;                  // source-patch centre
    vec4 tc = uSpotC[i];             // cosA, sinA, 1/scale
    float radius = max(b.x, 1e-4);
    float feather = b.y;
    float opacity = b.z;
    // Offset from the spot centre in image-height units (aspect-corrected so the
    // disc stays round on screen).
    float dx = (uv.x - dst.x) * uImageAspect;
    float dy = uv.y - dst.y;
    float dist = length(vec2(dx, dy));
    // The marked radius is fully replaced, so the blemish is removed outright;
    // feather softens the seam by fading out *beyond* the radius rather than
    // carving into the core (which only made the blemish go lighter, not gone).
    // feather=0 -> hard edge; feather=1 -> blend out to 2x the radius.
    float edge = radius * (1.0 + feather);
    if (dist >= edge) continue;
    float w = opacity * (1.0 - smoothstep(radius, edge, dist));
    if (w <= 0.0) continue;
    // Fetch the source with the inverse rotation+scale, so the patch lands
    // rotated by +angle and scaled by +scale to match the surrounding texture.
    float rx = (tc.x * dx + tc.y * dy) * tc.z;
    float ry = (-tc.y * dx + tc.x * dy) * tc.z;
    vec2 sUv = clamp(src + vec2(rx / uImageAspect, ry), 0.0, 1.0);
    // Recolour toward the destination's surroundings so the seam disappears. Heal
    // spots (b.w > 0.5) use the per-pixel gradient-domain membrane; clone spots —
    // and the membrane A/B toggle when off — fall back to the flat mean offset.
    vec3 corr = (uMembraneHeal && b.w > 0.5)
      ? membraneCorrection(dst, src, tc, radius, uv)
      : uSpotTint[i].rgb;
    vec3 srcCol = clamp(textureLod(uImage, sUv, 0.0).rgb + corr, 0.0, 1.0);
    c = mix(c, srcCol, w);
  }
  // Brush-shaped retouch: painted coverage from the atlas, one source offset each.
  if (uRetouchCount > 0) {
    vec4 rcov = texture(uRetouchTex, uv);
    for (int i = 0; i < MAX_RBRUSH; i++) {
      if (i >= uRetouchCount) break;
      int ch = uRetouchCh[i];
      float cov = ch == 0 ? rcov.r : (ch == 1 ? rcov.g : (ch == 2 ? rcov.b : rcov.a));
      vec4 rd = uRetouchData[i];
      float w = cov * rd.z;
      if (w <= 0.0) continue;
      vec2 sUv = clamp(uv + rd.xy, 0.0, 1.0);
      vec3 srcCol = texture(uImage, sUv).rgb;
      c = mix(c, srcCol, w);
    }
  }
  return c;
}

// Coverage of one component (0..1), before add/subtract combine. px is the
// current pixel's working (scene-linear) colour and pxL its luma — used by the
// parametric range masks (luminance / colour).
float compCoverage(int i, vec2 uv, vec3 px, float pxL) {
  int type = uCompType[i];
  vec4 gA = uCompGeoA[i];
  vec4 gB = uCompGeoB[i];
  float m = 0.0;
  if (type == 0) {
    // Linear gradient: ramp 0->1 projected onto the drag direction.
    vec2 p0 = gA.xy;
    vec2 p1 = gA.zw;
    vec2 dir = p1 - p0;
    float len2 = max(dot(dir, dir), 1e-6);
    m = clamp(dot(uv - p0, dir) / len2, 0.0, 1.0);
  } else if (type == 1) {
    // Radial: 1 inside, feathered to 0 at the edge, in screen-proportional space.
    vec2 ctr = gA.xy;
    vec2 rad = max(gA.zw, vec2(1e-4));
    float feather = gB.x;
    float ang = gB.y;
    vec2 q = vec2((uv.x - ctr.x) * uImageAspect, uv.y - ctr.y);
    float ca = cos(ang);
    float sa = sin(ang);
    vec2 qr = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    vec2 radS = vec2(rad.x * uImageAspect, rad.y);
    float d = length(qr / radS);
    m = 1.0 - smoothstep(1.0 - feather, 1.0, d);
  } else if (type == 3) {
    // Luminance range: 1 inside [lo,hi], soft ramps of width loF/hiF at the ends.
    float lo = gA.x;
    float hi = gA.y;
    float loF = max(gA.z, 1e-4);
    float hiF = max(gA.w, 1e-4);
    float lower = smoothstep(lo - loF, lo, pxL);
    float upper = 1.0 - smoothstep(hi, hi + hiF, pxL);
    m = lower * upper;
  } else if (type == 4) {
    // Colour range: closeness to a target colour, measured in hue + chroma.
    vec3 tgt = gA.xyz;
    float hueRange = max(gA.w, 1e-3);
    float satRange = max(gB.x, 1e-3);
    float smth = gB.y;
    // Compare in a tone-normalized chroma space so exposure differences along
    // the same hue don't break the match. Direction of the colour vector ~ hue,
    // its length relative to luma ~ saturation.
    float tL = max(luma(tgt), 1e-4);
    vec3 pd = px - vec3(pxL);
    vec3 td = tgt - vec3(tL);
    float pLen = length(pd);
    float tLen = length(td);
    float hueDist = 1.0 - (dot(pd, td) / max(pLen * tLen, 1e-4)); // 0 = same hue
    float satDist = abs(pLen / max(pxL, 1e-3) - tLen / tL);       // chroma mismatch
    float hueM = 1.0 - smoothstep(hueRange, hueRange + smth + 1e-3, hueDist);
    float satM = 1.0 - smoothstep(satRange, satRange + smth + 1e-3, satDist);
    // Near-neutral target/pixel have no meaningful hue — fall back to chroma only.
    float chromaW = smoothstep(0.01, 0.05, tLen);
    m = mix(satM, hueM * satM, chromaW);
  } else {
    // Brush: prebaked coverage from the atlas channel. ch < 0 marks a brush with
    // no atlas slot (beyond the 4 the RGBA atlas holds) — it contributes nothing
    // rather than borrowing channel 0's coverage.
    vec4 cov = texture(uMaskTex, uv);
    int ch = uCompBrushCh[i];
    m = ch < 0 ? 0.0 : (ch == 0 ? cov.r : (ch == 1 ? cov.g : (ch == 2 ? cov.b : cov.a)));
  }
  if (uCompInvert[i] == 1) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}

vec3 applyToneCurve(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  // Per-channel LUTs packed into RGBA (master curve already composed in).
  c.r = texture(uCurve, vec2(c.r, 0.5)).r;
  c.g = texture(uCurve, vec2(c.g, 0.5)).g;
  c.b = texture(uCurve, vec2(c.b, 0.5)).b;
  return c;
}

vec3 applyHSL(vec3 c) {
  vec3 hsl = rgb2hsl(c);
  // Protect near-neutral pixels: an achromatic pixel has no real hue (rgb2hsl
  // reports 0 = red), so without this gate the Red sliders would tint/relight
  // every grey. Fades the whole effect in over a low saturation threshold, so
  // genuinely coloured pixels (even pale skies/skin) still respond fully.
  float chromaW = smoothstep(0.0, 0.10, hsl.y);
  if (chromaW < 1e-4) return c;

  float hueDeg = hsl.x * 360.0;

  float hueShift = 0.0;
  float satAdj = 0.0;
  float lumAdj = 0.0;
  for (int i = 0; i < 8; i++) {
    float wi = hslBandWeight(hueDeg, HSL_CENTERS[i], HSL_DPREV[i], HSL_DNEXT[i], uHslRange, uHslSmooth);
    hueShift += uHslHue[i] * wi;
    satAdj   += uHslSat[i] * wi;
    lumAdj   += uHslLum[i] * wi;
  }
  hueShift *= chromaW;
  satAdj   *= chromaW;
  lumAdj   *= chromaW;

  // Hue: rotate in HSL (luminance-invariant), ±30° at full slider.
  hsl.x = fract(hsl.x + hueShift * (30.0 / 360.0));
  vec3 rgb = hsl2rgb(hsl);

  // Saturation: perceptual. Scale chroma around the pixel's true luminance, so a
  // cut collapses the colour to its actual grey (not HSL-L's mid-range grey) and
  // a boost doesn't clip the bright channel into a different hue on the way up.
  if (abs(satAdj) > 1e-4) {
    float Lp = luma(rgb);
    rgb = mix(vec3(Lp), rgb, clamp(1.0 + satAdj, 0.0, 2.0));
  }

  // Luminance: hue-preserving gain (ratio-scale). Darkening a blue sky or lifting
  // reds keeps the hue and per-channel saturation intact, unlike an HSL-L add
  // which greys and shifts the colour. Gentle factor so shadows don't blow out.
  if (abs(lumAdj) > 1e-4) {
    rgb *= 1.0 + lumAdj * 0.6;
  }

  return clamp(rgb, 0.0, 1.0);
}

// Convert hue+sat to a neutral-axis RGB color offset (equilateral triangle projection).
// The three cosines are 120° apart so they always sum to zero — no net luminance shift.
vec3 cgWheelRGB(float hueDeg, float satPct) {
  if (satPct < 0.001) return vec3(0.0);
  float rad = hueDeg * 3.14159265358979 / 180.0;
  float s = satPct / 100.0 * 0.15; // max ±15% per channel at full saturation
  return vec3(
    cos(rad),
    cos(rad - 2.09439510239320), // 2π/3
    cos(rad - 4.18879020478640)  // 4π/3
  ) * s;
}

vec3 applyColorGrading(vec3 c) {
  float l = luma(c);
  // Shadow weight: peaks at black, falls off toward midtones.
  float shRange = max(uCGShadowRange, 0.05);
  float hiRange = max(uCGHighlightRange, 0.05);
  float shadowW    = 1.0 - smoothstep(0.0, shRange, l);
  shadowW          = shadowW * shadowW;
  float highlightW = smoothstep(1.0 - hiRange, 1.0, l);
  highlightW       = highlightW * highlightW;
  float midW       = clamp(1.0 - shadowW - highlightW, 0.0, 1.0);

  vec3 shColor  = cgWheelRGB(uCGShadowHue,  uCGShadowSat);
  vec3 midColor = cgWheelRGB(uCGMidHue,     uCGMidSat);
  vec3 hiColor  = cgWheelRGB(uCGHighHue,    uCGHighSat);
  vec3 glColor  = cgWheelRGB(uCGGlobalHue,  uCGGlobalSat);

  vec3 colorOffset = shadowW    * shColor
                   + midW       * midColor
                   + highlightW * hiColor
                   + glColor;  // global applied uniformly
  // Strip any net luminance the (weight-blended) offset introduced. cgWheelRGB is
  // luma-neutral per range, but the per-pixel weighting is not, so without this the
  // tint lifts/drops tones and washes out contrast/detail. Removing the luma term
  // keeps the change purely chromatic — color shifts, tonal structure is untouched.
  colorOffset -= vec3(luma(colorOffset));
  c += colorOffset;

  // Per-range luminance adjustments, scaled so ±100 → ±0.25 exposure-equivalent.
  float lumaAdj = shadowW    * (uCGShadowLuma / 100.0) * 0.25
                + midW       * (uCGMidLuma    / 100.0) * 0.25
                + highlightW * (uCGHighLuma   / 100.0) * 0.25
                + (uCGGlobalLuma / 100.0) * 0.25;
  c += vec3(lumaAdj);

  return clamp(c, 0.0, 1.0);
}

vec3 applyVignette(vec3 c, vec2 uv) {
  if (abs(uVignetteAmount) < 0.001) return c;
  vec2 centered = uv - 0.5;
  float roundness = uVignetteRoundness / 100.0;
  float rx = abs(centered.x);
  float ry = abs(centered.y);
  float rect = max(rx, ry);
  float circ = length(centered);
  float r = mix(rect, circ, clamp(roundness + 0.5, 0.0, 1.0)) * 2.0;
  float midpoint = mix(0.5, 1.5, 1.0 - uVignetteMidpoint / 100.0);
  float feather = mix(0.05, 0.95, uVignetteFeather / 100.0);
  float lo = max(0.0, midpoint - feather * 0.5);
  float hi = midpoint + feather * 0.5;
  float edge = smoothstep(lo, hi, r);
  float vigAmt = uVignetteAmount / 100.0;
  float darkening = vigAmt < 0.0 ? -vigAmt * edge : 0.0;
  float lightening = vigAmt > 0.0 ?  vigAmt * edge : 0.0;
  float hlProtect = uVignetteHighlights > 0.001
    ? clamp(luma(c) * (uVignetteHighlights / 100.0) * 2.0, 0.0, 1.0)
    : 0.0;
  darkening *= (1.0 - hlProtect);
  c = c * (1.0 - darkening) + c * lightening;
  return clamp(c, 0.0, 1.0);
}

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float gaussGrain(vec2 seed) {
  float u1 = max(grainHash(seed), 1e-6);
  float u2 = grainHash(seed + vec2(127.1, 311.7));
  return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}

float grainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float g00 = gaussGrain(i);
  float g10 = gaussGrain(i + vec2(1.0, 0.0));
  float g01 = gaussGrain(i + vec2(0.0, 1.0));
  float g11 = gaussGrain(i + vec2(1.0, 1.0));
  return mix(mix(g00, g10, f.x), mix(g01, g11, f.x), f.y);
}

vec3 applyGrain(vec3 c, vec2 uv) {
  if (uGrainAmount < 0.001) return c;
  float amount = uGrainAmount / 100.0;
  float sizeT = (uGrainSize - 25.0) / 75.0;
  float rough = uGrainRoughness / 100.0;
  float chromaVar = uGrainColor / 100.0;
  float freq = mix(1400.0, 200.0, sizeT * sizeT);
  vec2 guv = vec2(uv.x * uImageAspect, uv.y) * freq;
  float L = luma(c);
  float density = mix(0.08, 1.0, sqrt(clamp(L, 0.0, 1.0)));
  float sigma = amount * density * 0.14;
  if (chromaVar < 0.01) {
    float n = grainNoise(guv);
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      n += grainNoise(guv * 2.17 + 17.3) * 0.5 * t;
    }
    c += vec3(n * sigma);
  } else {
    float rFreq = 1.0 + 0.25 * chromaVar;
    float bFreq = 1.0 - 0.15 * chromaVar;
    float nR = grainNoise(guv * rFreq);
    float nG = grainNoise(guv + vec2(43.7, 91.3));
    float nB = grainNoise(guv * bFreq + vec2(71.9, 37.1));
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      nR += grainNoise(guv * rFreq * 2.17 + 17.3) * 0.5 * t;
      nG += grainNoise((guv + vec2(43.7, 91.3)) * 2.17 + 17.3) * 0.5 * t;
      nB += grainNoise((guv * bFreq + vec2(71.9, 37.1)) * 2.17 + 17.3) * 0.5 * t;
    }
    c.r += nR * sigma;
    c.g += nG * sigma;
    c.b += nB * sigma;
  }
  return clamp(c, 0.0, 1.0);
}`,
    srcUv: ``,
    noiseReduction: `{
vec3 stageResult = texture(u_6zr4_stageResult, srcUv).rgb;
if (uDenoiseReady && (uLuminanceNR > 0.001 || uColorNR > 0.001)) { lin = stageResult; }
}`,
    sceneLinear: ``,
    effects: `{
c = applyVignette(c, vUv);
}
  {
c = applyGrain(c, vUv);
}`,
    anchors: {
      "band-detail": `  // Band-limited detail (highlight / shadow). Tonal recovery and lift compress a
  // luminance band, which dulls its micro-contrast (cloud texture, shadow detail).
  // A luminance curve can't add it back without also moving other tones that overlap
  // in luma (sky vs lit foliage), so restore LOCAL contrast instead — confined to the
  // band where the pixel ended up, clamped to limit edge overshoot (anti-halo).
  //
  // Each band's gain = an auto term (engaged by recovery/lift so a tone move never
  // flattens texture on its own) + the user's Highlight/Shadow Detail slider
  // (bidirectional: + crisper, - smoother). At the slider's default of 0 the highlight
  // term is identical to the original recovery-coupled restore. The shadow auto term is
  // gentler than the highlight one because the dark band is where sensor noise lives.
  // Version 2's Highlights and Shadows keep texture themselves (local-tone.ts), so
  // there each band's gain is its Detail slider alone.
  float bandDet = clamp(rawLuma - lumaLod(srcUv, 2.0), -0.15, 0.15);
  float hiGain = (H < 0.0 ? -H : 0.0) + uHighlightDetail / 100.0;
  if (abs(hiGain) > 0.001) {
    float hiZone = smoothstep(0.45, 0.78, luma(c));
    c += bandDet * hiGain * hiZone * BAND_DETAIL;
  }
  float shGain = (S > 0.0 ? 0.5 * S : 0.0) + uShadowDetail / 100.0;
  if (abs(shGain) > 0.001) {
    float shZone = 1.0 - smoothstep(0.12, 0.45, luma(c));
    c += bandDet * shGain * shZone * BAND_DETAIL;
  }
  c = clamp(c, 0.0, 1.0);`,
      "color-grading": `c = applyColorGrading(c);`,
      "display-basic": `  // Whites (display space): endpoint control for the bright end.
  // Gamma-based adjustment weighted by cubic peaking at white.
  if (abs(uWhites) > 0.001) {
    float wAmt = uWhites / 100.0;
    float L = max(luma(c), 1e-4);
    float wW = L * L * L;
    float gamma = wAmt > 0.0 ? mix(1.0, 0.5, wAmt) : mix(1.0, 1.9, -wAmt);
    float newL = mix(L, pow(L, gamma), wW);
    c = c * (newL / L);
    c = clamp(c, 0.0, 1.0);
  }

  // Blacks (display space): endpoint control for the dark end.
  // Gamma-based adjustment weighted by cubic peaking at black.
  if (abs(uBlacks) > 0.001) {
    float bAmt = uBlacks / 100.0;
    float L = max(luma(c), 1e-4);
    float bW = (1.0 - L) * (1.0 - L) * (1.0 - L);
    float gamma = bAmt > 0.0 ? mix(1.0, 0.55, bAmt) : mix(1.0, 2.2, -bAmt);
    float newL = mix(L, pow(L, gamma), bW);
    c = c * (newL / L);
    c = clamp(c, 0.0, 1.0);
  }

  // Contrast: luminance-based S-curve (always safe: display values in [0,1]).
  float ck = (uContrast / 100.0) * 0.8;
  if (abs(ck) > 0.001) {
    float L = luma(c);
    float Lnew = clamp(L + ck * L * (1.0 - L) * (2.0 * L - 1.0), 0.0, 1.0);
    c = c * (Lnew / max(L, 1e-4));
    c = clamp(c, 0.0, 1.0);
  }`,
      "geometry": ``,
      "hsl": `c = applyHSL(c);`,
      "masks": ``,
      "presence": `  // Dehaze: dark channel prior with global atmospheric light estimate.
  if (abs(dehAmt) > 0.001) {
    // Local dark channel from a medium blur
    vec3 localBlur = textureLod(uImage, srcUv, 4.0).rgb;
    if (!uLinear) localBlur = srgbToLinear(localBlur);
    localBlur = linearToSrgbU(localBlur);
    float dc = min(min(localBlur.r, localBlur.g), localBlur.b);
    // Atmospheric light: global estimate from the coarsest mip
    vec3 globalBlur = textureLod(uImage, vec2(0.5, 0.5), 9.0).rgb;
    if (!uLinear) globalBlur = srgbToLinear(globalBlur);
    globalBlur = linearToSrgbU(globalBlur);
    float A = clamp(max(max(globalBlur.r, globalBlur.g), globalBlur.b), 0.5, 0.98);
    // Transmission: normalize dark channel by atmospheric light
    float t_est = clamp(1.0 - dehAmt * 1.2 * dc / max(A, 0.5), 0.12, 1.0);
    c = (c - vec3(A) * (1.0 - t_est)) / max(t_est, 0.12);
    // Saturation restoration: haze washes out color
    float dl = luma(c);
    c = mix(vec3(dl), c, 1.0 + dehAmt * 0.4);
    c = clamp(c, 0.0, 1.0);
  }
  // Clarity: broad local contrast, midtone-focused. A plain broad mip blur
  // averages ACROSS hard edges, so rawLuma - blur overshoots in a band as wide
  // as the blur radius -- that band IS the halo, and masking/clamping it can only
  // attenuate, never remove it. The fix is to make the broad reference EDGE-AWARE:
  // a bilateral blur over 16 mip-blurred taps (two rings), each weighted by luma
  // similarity to the centre so taps across an edge are dropped. The reference
  // then tracks the local side of every boundary, rawLuma - base is ~0 at edges
  // (no ring), and only within-region midtone texture is lifted. CLAR_EDGE is the
  // edge stop: smaller = holds edges harder (less halo), larger = smoother.
  float midMask = 1.0 - pow(clamp(abs(luma(c) - 0.5) * 1.6, 0.0, 1.0), 3.0);
  if (abs(clarAmt) > 0.001) {
    // Edge-aware reference. Each broad tap is blended TOWARD the centre by its
    // luma-similarity weight: a same-side tap contributes its value, a tap across
    // an edge (incl. a mip tap that straddles one) contributes the centre value
    // instead. So the reference equals the local side at every boundary -- no
    // cross-edge averaging (no halo) and no pull from intermediate taps (no ghost
    // outline). rawLuma - base is ~0 at edges and in flats, nonzero only for
    // within-region midtone texture. CLAR_EDGE = edge stop (smaller = stricter).
    const float CLAR_EDGE = 0.08;
    float cen = rawLuma;
    float base = cen;            // centre tap
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981634;   // i * 2*pi/8
      vec2 dir = vec2(cos(a), sin(a));
      float s1 = lumaLod(srcUv + dir * 0.016, 3.0);
      float w1 = exp(-(s1 - cen) * (s1 - cen) / (2.0 * CLAR_EDGE * CLAR_EDGE));
      base += mix(cen, s1, w1);
      float s2 = lumaLod(srcUv + dir * 0.034, 4.0);
      float w2 = exp(-(s2 - cen) * (s2 - cen) / (2.0 * CLAR_EDGE * CLAR_EDGE));
      base += mix(cen, s2, w2);
    }
    base /= 17.0;               // centre + 16 taps
    c += (cen - base) * clarAmt * 1.5 * midMask;
  }
  // Texture: edge-aware micro-detail (LOD 0.75) — fine surface detail like
  // skin pores and fabric weave, suppressed at strong edges to avoid halos.
  if (abs(texAmt) > 0.001) {
    float fineBlur = lumaLod(srcUv, 0.75);
    float texDetail = rawLuma - fineBlur;
    float broadBlur = lumaLod(srcUv, 2.5);
    float edgeStrength = abs(rawLuma - broadBlur);
    float edgeMask = 1.0 - smoothstep(0.02, 0.12, edgeStrength);
    texDetail = clamp(texDetail, -0.08, 0.08);
    c += texDetail * texAmt * 2.5 * edgeMask;
  }`,
      "retouch": ``,
      "sharpen": `  // Capture sharpening with radius, detail (halo control), and edge masking.
  // Runs after vibrance/saturation so sharpening halos are not re-saturated.
  // sharpenViz carries the grayscale preview value when uSharpenViz is active;
  // the block also runs at amount 0 in that case so the preview is always live.
  float sharpenViz = 0.0;
  float sharpen = uSharpening / 100.0;
  if (sharpen > 0.001 || uSharpenViz > 0) {
    float lod = mix(0.5, 1.5, (uSharpenRadius - 1.0) / 2.0);
    float blur = lumaLod(srcUv, lod);
    float detail = rawLuma - blur;
    float detailFactor = uSharpenDetail / 100.0;
    float broadBlur = lumaLod(srcUv, lod + 1.0);
    detail = mix((rawLuma - broadBlur) * 0.35, detail, detailFactor);
    float mask = 1.0;
    if (uSharpenMasking > 0.001) {
      float edgeMag = abs(rawLuma - lumaLod(srcUv, 0.5));
      float threshold = (uSharpenMasking / 100.0) * 0.12;
      mask = smoothstep(threshold * 0.4, threshold, edgeMag);
    }
    if (sharpen > 0.001) c += detail * sharpen * 1.6 * mask;
    if (uSharpenViz == 1) sharpenViz = mask;                          // masking coverage
    else if (uSharpenViz == 2) sharpenViz = clamp(0.5 + detail * 4.0, 0.0, 1.0); // edge signal
    else if (uSharpenViz == 3) sharpenViz = luma(clamp(c, 0.0, 1.0)); // sharpened luminance
  }`,
      "tone": `  // Integrated tonal pipeline: exposure, highlights, and shadows are applied as
  // a single shoulder-based tone map instead of sequential independent operations.
  // Where the shoulder applies, exposure can't create unbounded values (no
  // blow-out); a display transform that skips it takes that headroom instead.
  // Either way highlight recovery works even at high exposure (+3..+5 EV).
  float E = uExposure;
  float H = clamp(uHighlights / 100.0, -1.0, 1.0);
  float S = clamp(uShadows / 100.0, -1.0, 1.0);
  {
    float L = max(luma(lin), 1e-4);

    // Exposure: true linear gain (×2 per stop)
    float Lx = L * exp2(E);

    // Filmic shoulder: piecewise curve — linear below knee, smooth Reinhard
    // compression above, keeping blown values out of display space wherever
    // it applies. Highlights slider controls the knee position:
    //   H < 0 (recover): lower knee → more of the range gets compressed
    //   H > 0 (brighten): raise knee → more headroom before compression
    float knee = 0.85;
    float rolloff = 0.5;
    if (H < 0.0) {
      knee = mix(0.85, 0.15, -H);
      rolloff = mix(0.5, 0.2, -H);
    } else if (H > 0.0) {
      knee = mix(0.85, 2.0, H);
      rolloff = mix(0.5, 1.5, H);
    }
    // Slope at the knee is (1-knee)/rolloff; clamp so it never exceeds 1.0,
    // otherwise midtones just above a low knee get lifted instead of compressed.
    rolloff = max(rolloff, 1.0 - knee);
    // Scale rolloff with sqrt of gain — enough to preserve highlight separation
    // at moderate exposure but lets high exposure (+5) push the image toward white
    rolloff *= max(exp2(max(E, 0.0) * 0.5), 1.0);

    float Lsc = Lx;
    if (Lx > knee) {
      float excess = Lx - knee;
      Lsc = knee + (1.0 - knee) * excess / (excess + rolloff);
    }
    // A transform with its own roll-off keeps the headroom: only recovery
    // (H < 0) blends the shoulder back in, in proportion to the slider.
    if (!uApplyToneShoulder) Lsc = mix(Lx, Lsc, max(-H, 0.0));

    lin = retargetLuma(lin, L, Lsc);

    // Hunt effect: restore colourfulness lost by pulling bright values down
    if (H < -0.001 && Lx > knee) {
      float pulled = clamp(Lx - Lsc, 0.0, 1.0);
      float Lr = luma(lin);
      lin = mix(vec3(Lr), lin, 1.0 + pulled * HI_SAT);
    }

    // Highlight lift (H > 0): gamma brighten the upper zone
    if (H > 0.001) {
      float Lcur = max(luma(lin), 1e-4);
      float hw = smoothstep(0.3, 0.9, Lcur);
      float gamma = mix(1.0, 0.5, H);
      float newLcur = mix(Lcur, pow(Lcur, gamma), hw * H);
      // The gamma lift darkens values above white; without the shoulder those
      // are the transform's headroom, so the lift may only brighten.
      if (!uApplyToneShoulder) newLcur = max(newLcur, Lcur);
      lin = retargetLuma(lin, Lcur, newLcur);
    }

    // Shadows: gamma toe weighted toward the dark end, fading out in highlights
    if (abs(S) > 0.001) {
      float Lcur = max(luma(lin), 1e-4);
      float shW = exp(-3.0 * Lcur);
      float gamma = S > 0.0 ? mix(1.0, 0.65, S) : mix(1.0, 1.8, -S);
      float newLcur = mix(Lcur, pow(Lcur, gamma), shW * abs(S));
      lin = retargetLuma(lin, Lcur, newLcur);
    }
  }`,
      "tone-curve": `c = applyToneCurve(c);`,
      "vibrance": `  c = applyVibSat(c, uVibrance, uSaturation);`,
      "white-balance": `lin = applyWhiteBalance(lin, uTemperature, uTint, uAsShotTemperature);`,
    },
  },
  legacyExtensions: {
    uniforms: `uniform vec4 uCrop;
uniform mat3 uInvTransform;
#define MAX_SPOTS 32
#define MAX_RBRUSH 4
uniform int uSpotCount;
uniform vec4 uSpotA[MAX_SPOTS];
uniform vec4 uSpotB[MAX_SPOTS];
uniform vec4 uSpotC[MAX_SPOTS];
uniform vec4 uSpotTint[MAX_SPOTS];
uniform int uRetouchCount;
uniform int uRetouchCh[MAX_RBRUSH];
uniform vec4 uRetouchData[MAX_RBRUSH];
uniform bool uMembraneHeal;
uniform sampler2D uRetouchTex;
uniform float u_yac9_warpAmount;
uniform float u_1ixp_fringeAmount;
uniform sampler2D u_1ixp_stageResult;
uniform float u_1p0n_smoothAmount;
uniform sampler2D u_1p0n_stageResult;
uniform float uTemperature;
uniform float uTint;
uniform float uExposure;
uniform float uHighlights;
uniform float uShadows;
uniform int uMaskCount;
uniform int uMaskInvert[MAX_MASKS];
uniform float uMaskOpacity[MAX_MASKS];
uniform int uCompCount;
uniform int uCompMaskIdx[MAX_COMPONENTS];
uniform int uCompMode[MAX_COMPONENTS];
uniform int uCompType[MAX_COMPONENTS];
uniform int uCompInvert[MAX_COMPONENTS];
uniform int uCompBrushCh[MAX_COMPONENTS];
uniform vec4 uCompGeoA[MAX_COMPONENTS];
uniform vec4 uCompGeoB[MAX_COMPONENTS];
uniform vec4 uMaskAdj0[MAX_MASKS];
uniform vec4 uMaskAdj1[MAX_MASKS];
uniform vec4 uMaskAdj2[MAX_MASKS];
uniform vec4 uMaskAdj3[MAX_MASKS];
uniform int uMaskHasHsl[MAX_MASKS];
uniform vec4 uMaskHsl[MAX_MASKS * 6];
uniform int uMaskHasCurve[MAX_MASKS];
uniform sampler2D uMaskCurves;
uniform float u_1wb6_localGain;
uniform int u_1wb6_localCov_ch;
uniform float u_ya1k_filmAmount;
uniform sampler2D u_ya1k_filmLut;
uniform float uWhites;
uniform float uBlacks;
uniform float uContrast;
uniform sampler2D uCurve;
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform float uHslRange;
uniform float uHslSmooth;
uniform float uTexture;
uniform float uClarity;
uniform float uDehaze;
uniform float uHighlightDetail;
uniform float uShadowDetail;
uniform float uVibrance;
uniform float uSaturation;
uniform float uCGShadowHue;
uniform float uCGShadowSat;
uniform float uCGShadowLuma;
uniform float uCGMidHue;
uniform float uCGMidSat;
uniform float uCGMidLuma;
uniform float uCGHighHue;
uniform float uCGHighSat;
uniform float uCGHighLuma;
uniform float uCGGlobalHue;
uniform float uCGGlobalSat;
uniform float uCGGlobalLuma;
uniform float uCGShadowRange;
uniform float uCGHighlightRange;
uniform float uSharpening;
uniform float uSharpenRadius;
uniform float uSharpenDetail;
uniform float uSharpenMasking;
uniform vec3 u_yaai_tintColor;
uniform float u_yaai_tintAmount;
uniform float uVignetteAmount;
uniform float uVignetteMidpoint;
uniform float uVignetteRoundness;
uniform float uVignetteFeather;
uniform float uVignetteHighlights;
uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uGrainRoughness;
uniform float uGrainColor;
uniform float u_ya29_glowAmount;
uniform bool u_ya66_monoOn;`,
    helpers: `// The view's point (output, crop coordinates) to source UV: through the crop
// to the transformed image, then the geometry transform's inverse (straighten,
// perspective, stretch, scale, offset), which is independent of the crop. vUv
// already has V flipped, so both are in top-left-origin image space.
vec2 cropTransformUV(vec2 o) {
  vec2 p = uCrop.xy + o * uCrop.zw;
  vec3 q = uInvTransform * vec3(p, 1.0);
  return q.xy / q.z;
}

// ---- Retouch: spot heal / clone -------------------------------------------
// Closed-form gradient-domain (membrane) correction for a heal spot. Samples the
// boundary mismatch (destination - source) just outside the disc and interpolates
// it across the interior with inverse-distance (Shepard) weights — a smooth
// low-frequency field that makes the copied source meet its surroundings
// seamlessly even across a tone gradient. This is the per-pixel generalisation of
// the single mean-colour offset carried in uSpotTint. Both terms sample uImage so
// the correction stays in source space (it is added to the source patch, then the
// whole patched image is developed downstream — matching the flat-tint path).
vec3 membraneCorrection(vec2 dst, vec2 src, vec4 tc, float radius, vec2 uv) {
  vec2 q = vec2((uv.x - dst.x) * uImageAspect, uv.y - dst.y); // pixel in aspect space
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  const int N = 16;
  for (int k = 0; k < N; k++) {
    float a = (float(k) + 0.5) / float(N) * 6.2831853;
    vec2 e = vec2(cos(a), sin(a)) * radius * 1.04;       // boundary point (aspect space)
    vec2 dUv = clamp(dst + vec2(e.x / uImageAspect, e.y), 0.0, 1.0);
    // Same inverse rotate+scale the patch fetch uses, so the source boundary point
    // corresponds to the same place in the copied texture.
    float rx = (tc.x * e.x + tc.y * e.y) * tc.z;
    float ry = (-tc.y * e.x + tc.x * e.y) * tc.z;
    vec2 sUv = clamp(src + vec2(rx / uImageAspect, ry), 0.0, 1.0);
    // Explicit LOD: this runs in divergent control flow (inside the per-spot
    // branch), where auto-LOD derivatives are undefined and sample wrong mips.
    vec3 delta = textureLod(uImage, dUv, 0.0).rgb - textureLod(uImage, sUv, 0.0).rgb;
    float dist = length(q - e) + 1e-3;
    float w = 1.0 / (dist * dist);                        // mean-value-style weighting
    acc += delta * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-4);
}

vec3 applyRetouch(vec2 uv, vec3 base) {
  vec3 c = base;
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (i >= uSpotCount) break;
    vec4 a = uSpotA[i];
    vec4 b = uSpotB[i];
    vec2 dst = a.xy;
    vec2 src = a.zw;                  // source-patch centre
    vec4 tc = uSpotC[i];             // cosA, sinA, 1/scale
    float radius = max(b.x, 1e-4);
    float feather = b.y;
    float opacity = b.z;
    // Offset from the spot centre in image-height units (aspect-corrected so the
    // disc stays round on screen).
    float dx = (uv.x - dst.x) * uImageAspect;
    float dy = uv.y - dst.y;
    float dist = length(vec2(dx, dy));
    // The marked radius is fully replaced, so the blemish is removed outright;
    // feather softens the seam by fading out *beyond* the radius rather than
    // carving into the core (which only made the blemish go lighter, not gone).
    // feather=0 -> hard edge; feather=1 -> blend out to 2x the radius.
    float edge = radius * (1.0 + feather);
    if (dist >= edge) continue;
    float w = opacity * (1.0 - smoothstep(radius, edge, dist));
    if (w <= 0.0) continue;
    // Fetch the source with the inverse rotation+scale, so the patch lands
    // rotated by +angle and scaled by +scale to match the surrounding texture.
    float rx = (tc.x * dx + tc.y * dy) * tc.z;
    float ry = (-tc.y * dx + tc.x * dy) * tc.z;
    vec2 sUv = clamp(src + vec2(rx / uImageAspect, ry), 0.0, 1.0);
    // Recolour toward the destination's surroundings so the seam disappears. Heal
    // spots (b.w > 0.5) use the per-pixel gradient-domain membrane; clone spots —
    // and the membrane A/B toggle when off — fall back to the flat mean offset.
    vec3 corr = (uMembraneHeal && b.w > 0.5)
      ? membraneCorrection(dst, src, tc, radius, uv)
      : uSpotTint[i].rgb;
    vec3 srcCol = clamp(textureLod(uImage, sUv, 0.0).rgb + corr, 0.0, 1.0);
    c = mix(c, srcCol, w);
  }
  // Brush-shaped retouch: painted coverage from the atlas, one source offset each.
  if (uRetouchCount > 0) {
    vec4 rcov = texture(uRetouchTex, uv);
    for (int i = 0; i < MAX_RBRUSH; i++) {
      if (i >= uRetouchCount) break;
      int ch = uRetouchCh[i];
      float cov = ch == 0 ? rcov.r : (ch == 1 ? rcov.g : (ch == 2 ? rcov.b : rcov.a));
      vec4 rd = uRetouchData[i];
      float w = cov * rd.z;
      if (w <= 0.0) continue;
      vec2 sUv = clamp(uv + rd.xy, 0.0, 1.0);
      vec3 srcCol = texture(uImage, sUv).rgb;
      c = mix(c, srcCol, w);
    }
  }
  return c;
}

vec3 _1p0n_smoothBlend(vec3 a, vec3 b) { return 0.5 * (a + b); }

// Coverage of one component (0..1), before add/subtract combine. px is the
// current pixel's working (scene-linear) colour and pxL its luma — used by the
// parametric range masks (luminance / colour).
float compCoverage(int i, vec2 uv, vec3 px, float pxL) {
  int type = uCompType[i];
  vec4 gA = uCompGeoA[i];
  vec4 gB = uCompGeoB[i];
  float m = 0.0;
  if (type == 0) {
    // Linear gradient: ramp 0->1 projected onto the drag direction.
    vec2 p0 = gA.xy;
    vec2 p1 = gA.zw;
    vec2 dir = p1 - p0;
    float len2 = max(dot(dir, dir), 1e-6);
    m = clamp(dot(uv - p0, dir) / len2, 0.0, 1.0);
  } else if (type == 1) {
    // Radial: 1 inside, feathered to 0 at the edge, in screen-proportional space.
    vec2 ctr = gA.xy;
    vec2 rad = max(gA.zw, vec2(1e-4));
    float feather = gB.x;
    float ang = gB.y;
    vec2 q = vec2((uv.x - ctr.x) * uImageAspect, uv.y - ctr.y);
    float ca = cos(ang);
    float sa = sin(ang);
    vec2 qr = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    vec2 radS = vec2(rad.x * uImageAspect, rad.y);
    float d = length(qr / radS);
    m = 1.0 - smoothstep(1.0 - feather, 1.0, d);
  } else if (type == 3) {
    // Luminance range: 1 inside [lo,hi], soft ramps of width loF/hiF at the ends.
    float lo = gA.x;
    float hi = gA.y;
    float loF = max(gA.z, 1e-4);
    float hiF = max(gA.w, 1e-4);
    float lower = smoothstep(lo - loF, lo, pxL);
    float upper = 1.0 - smoothstep(hi, hi + hiF, pxL);
    m = lower * upper;
  } else if (type == 4) {
    // Colour range: closeness to a target colour, measured in hue + chroma.
    vec3 tgt = gA.xyz;
    float hueRange = max(gA.w, 1e-3);
    float satRange = max(gB.x, 1e-3);
    float smth = gB.y;
    // Compare in a tone-normalized chroma space so exposure differences along
    // the same hue don't break the match. Direction of the colour vector ~ hue,
    // its length relative to luma ~ saturation.
    float tL = max(luma(tgt), 1e-4);
    vec3 pd = px - vec3(pxL);
    vec3 td = tgt - vec3(tL);
    float pLen = length(pd);
    float tLen = length(td);
    float hueDist = 1.0 - (dot(pd, td) / max(pLen * tLen, 1e-4)); // 0 = same hue
    float satDist = abs(pLen / max(pxL, 1e-3) - tLen / tL);       // chroma mismatch
    float hueM = 1.0 - smoothstep(hueRange, hueRange + smth + 1e-3, hueDist);
    float satM = 1.0 - smoothstep(satRange, satRange + smth + 1e-3, satDist);
    // Near-neutral target/pixel have no meaningful hue — fall back to chroma only.
    float chromaW = smoothstep(0.01, 0.05, tLen);
    m = mix(satM, hueM * satM, chromaW);
  } else {
    // Brush: prebaked coverage from the atlas channel. ch < 0 marks a brush with
    // no atlas slot (beyond the 4 the RGBA atlas holds) — it contributes nothing
    // rather than borrowing channel 0's coverage.
    vec4 cov = texture(uMaskTex, uv);
    int ch = uCompBrushCh[i];
    m = ch < 0 ? 0.0 : (ch == 0 ? cov.r : (ch == 1 ? cov.g : (ch == 2 ? cov.b : cov.a)));
  }
  if (uCompInvert[i] == 1) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}

float u_1wb6_localCov(vec2 uv) {
  int ch = u_1wb6_localCov_ch;
  if (ch < 0) return 0.0;
  vec4 t = texture(uMaskTex, uv);
  return ch == 0 ? t.r : ch == 1 ? t.g : ch == 2 ? t.b : t.a;
}

vec3 applyToneCurve(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  // Per-channel LUTs packed into RGBA (master curve already composed in).
  c.r = texture(uCurve, vec2(c.r, 0.5)).r;
  c.g = texture(uCurve, vec2(c.g, 0.5)).g;
  c.b = texture(uCurve, vec2(c.b, 0.5)).b;
  return c;
}

vec3 applyHSL(vec3 c) {
  vec3 hsl = rgb2hsl(c);
  // Protect near-neutral pixels: an achromatic pixel has no real hue (rgb2hsl
  // reports 0 = red), so without this gate the Red sliders would tint/relight
  // every grey. Fades the whole effect in over a low saturation threshold, so
  // genuinely coloured pixels (even pale skies/skin) still respond fully.
  float chromaW = smoothstep(0.0, 0.10, hsl.y);
  if (chromaW < 1e-4) return c;

  float hueDeg = hsl.x * 360.0;

  float hueShift = 0.0;
  float satAdj = 0.0;
  float lumAdj = 0.0;
  for (int i = 0; i < 8; i++) {
    float wi = hslBandWeight(hueDeg, HSL_CENTERS[i], HSL_DPREV[i], HSL_DNEXT[i], uHslRange, uHslSmooth);
    hueShift += uHslHue[i] * wi;
    satAdj   += uHslSat[i] * wi;
    lumAdj   += uHslLum[i] * wi;
  }
  hueShift *= chromaW;
  satAdj   *= chromaW;
  lumAdj   *= chromaW;

  // Hue: rotate in HSL (luminance-invariant), ±30° at full slider.
  hsl.x = fract(hsl.x + hueShift * (30.0 / 360.0));
  vec3 rgb = hsl2rgb(hsl);

  // Saturation: perceptual. Scale chroma around the pixel's true luminance, so a
  // cut collapses the colour to its actual grey (not HSL-L's mid-range grey) and
  // a boost doesn't clip the bright channel into a different hue on the way up.
  if (abs(satAdj) > 1e-4) {
    float Lp = luma(rgb);
    rgb = mix(vec3(Lp), rgb, clamp(1.0 + satAdj, 0.0, 2.0));
  }

  // Luminance: hue-preserving gain (ratio-scale). Darkening a blue sky or lifting
  // reds keeps the hue and per-channel saturation intact, unlike an HSL-L add
  // which greys and shifts the colour. Gentle factor so shadows don't blow out.
  if (abs(lumAdj) > 1e-4) {
    rgb *= 1.0 + lumAdj * 0.6;
  }

  return clamp(rgb, 0.0, 1.0);
}

// Convert hue+sat to a neutral-axis RGB color offset (equilateral triangle projection).
// The three cosines are 120° apart so they always sum to zero — no net luminance shift.
vec3 cgWheelRGB(float hueDeg, float satPct) {
  if (satPct < 0.001) return vec3(0.0);
  float rad = hueDeg * 3.14159265358979 / 180.0;
  float s = satPct / 100.0 * 0.15; // max ±15% per channel at full saturation
  return vec3(
    cos(rad),
    cos(rad - 2.09439510239320), // 2π/3
    cos(rad - 4.18879020478640)  // 4π/3
  ) * s;
}

vec3 applyColorGrading(vec3 c) {
  float l = luma(c);
  // Shadow weight: peaks at black, falls off toward midtones.
  float shRange = max(uCGShadowRange, 0.05);
  float hiRange = max(uCGHighlightRange, 0.05);
  float shadowW    = 1.0 - smoothstep(0.0, shRange, l);
  shadowW          = shadowW * shadowW;
  float highlightW = smoothstep(1.0 - hiRange, 1.0, l);
  highlightW       = highlightW * highlightW;
  float midW       = clamp(1.0 - shadowW - highlightW, 0.0, 1.0);

  vec3 shColor  = cgWheelRGB(uCGShadowHue,  uCGShadowSat);
  vec3 midColor = cgWheelRGB(uCGMidHue,     uCGMidSat);
  vec3 hiColor  = cgWheelRGB(uCGHighHue,    uCGHighSat);
  vec3 glColor  = cgWheelRGB(uCGGlobalHue,  uCGGlobalSat);

  vec3 colorOffset = shadowW    * shColor
                   + midW       * midColor
                   + highlightW * hiColor
                   + glColor;  // global applied uniformly
  // Strip any net luminance the (weight-blended) offset introduced. cgWheelRGB is
  // luma-neutral per range, but the per-pixel weighting is not, so without this the
  // tint lifts/drops tones and washes out contrast/detail. Removing the luma term
  // keeps the change purely chromatic — color shifts, tonal structure is untouched.
  colorOffset -= vec3(luma(colorOffset));
  c += colorOffset;

  // Per-range luminance adjustments, scaled so ±100 → ±0.25 exposure-equivalent.
  float lumaAdj = shadowW    * (uCGShadowLuma / 100.0) * 0.25
                + midW       * (uCGMidLuma    / 100.0) * 0.25
                + highlightW * (uCGHighLuma   / 100.0) * 0.25
                + (uCGGlobalLuma / 100.0) * 0.25;
  c += vec3(lumaAdj);

  return clamp(c, 0.0, 1.0);
}

vec3 applyVignette(vec3 c, vec2 uv) {
  if (abs(uVignetteAmount) < 0.001) return c;
  vec2 centered = uv - 0.5;
  float roundness = uVignetteRoundness / 100.0;
  float rx = abs(centered.x);
  float ry = abs(centered.y);
  float rect = max(rx, ry);
  float circ = length(centered);
  float r = mix(rect, circ, clamp(roundness + 0.5, 0.0, 1.0)) * 2.0;
  float midpoint = mix(0.5, 1.5, 1.0 - uVignetteMidpoint / 100.0);
  float feather = mix(0.05, 0.95, uVignetteFeather / 100.0);
  float lo = max(0.0, midpoint - feather * 0.5);
  float hi = midpoint + feather * 0.5;
  float edge = smoothstep(lo, hi, r);
  float vigAmt = uVignetteAmount / 100.0;
  float darkening = vigAmt < 0.0 ? -vigAmt * edge : 0.0;
  float lightening = vigAmt > 0.0 ?  vigAmt * edge : 0.0;
  float hlProtect = uVignetteHighlights > 0.001
    ? clamp(luma(c) * (uVignetteHighlights / 100.0) * 2.0, 0.0, 1.0)
    : 0.0;
  darkening *= (1.0 - hlProtect);
  c = c * (1.0 - darkening) + c * lightening;
  return clamp(c, 0.0, 1.0);
}

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float gaussGrain(vec2 seed) {
  float u1 = max(grainHash(seed), 1e-6);
  float u2 = grainHash(seed + vec2(127.1, 311.7));
  return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}

float grainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float g00 = gaussGrain(i);
  float g10 = gaussGrain(i + vec2(1.0, 0.0));
  float g01 = gaussGrain(i + vec2(0.0, 1.0));
  float g11 = gaussGrain(i + vec2(1.0, 1.0));
  return mix(mix(g00, g10, f.x), mix(g01, g11, f.x), f.y);
}

vec3 applyGrain(vec3 c, vec2 uv) {
  if (uGrainAmount < 0.001) return c;
  float amount = uGrainAmount / 100.0;
  float sizeT = (uGrainSize - 25.0) / 75.0;
  float rough = uGrainRoughness / 100.0;
  float chromaVar = uGrainColor / 100.0;
  float freq = mix(1400.0, 200.0, sizeT * sizeT);
  vec2 guv = vec2(uv.x * uImageAspect, uv.y) * freq;
  float L = luma(c);
  float density = mix(0.08, 1.0, sqrt(clamp(L, 0.0, 1.0)));
  float sigma = amount * density * 0.14;
  if (chromaVar < 0.01) {
    float n = grainNoise(guv);
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      n += grainNoise(guv * 2.17 + 17.3) * 0.5 * t;
    }
    c += vec3(n * sigma);
  } else {
    float rFreq = 1.0 + 0.25 * chromaVar;
    float bFreq = 1.0 - 0.15 * chromaVar;
    float nR = grainNoise(guv * rFreq);
    float nG = grainNoise(guv + vec2(43.7, 91.3));
    float nB = grainNoise(guv * bFreq + vec2(71.9, 37.1));
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      nR += grainNoise(guv * rFreq * 2.17 + 17.3) * 0.5 * t;
      nG += grainNoise((guv + vec2(43.7, 91.3)) * 2.17 + 17.3) * 0.5 * t;
      nB += grainNoise((guv * bFreq + vec2(71.9, 37.1)) * 2.17 + 17.3) * 0.5 * t;
    }
    c.r += nR * sigma;
    c.g += nG * sigma;
    c.b += nB * sigma;
  }
  return clamp(c, 0.0, 1.0);
}`,
    srcUv: `{
srcUv.x += u_yac9_warpAmount * 0.01 * (srcUv.y - 0.5);
}`,
    noiseReduction: `{
vec3 stageResult = texture(u_1ixp_stageResult, srcUv).rgb;
lin = mix(lin, stageResult, u_1ixp_fringeAmount);
}
  {
vec3 stageResult = texture(u_1p0n_stageResult, srcUv).rgb;
lin = mix(lin, _1p0n_smoothBlend(stageResult, lin), u_1p0n_smoothAmount);
}`,
    sceneLinear: `{
lin *= 1.0 + u_1wb6_localGain * u_1wb6_localCov(srcUv);
}
  {
lin = mix(lin, texture(u_ya1k_filmLut, vec2(clamp(luma(lin), 0.0, 1.0), 0.5)).rgb, u_ya1k_filmAmount);
}`,
    effects: `{
c = mix(c, c * u_yaai_tintColor, u_yaai_tintAmount);
}
  {
c = applyVignette(c, vUv);
}
  {
c = applyGrain(c, vUv);
}
  {
c += u_ya29_glowAmount * 0.1 * luma(c);
}
  {
if (u_ya66_monoOn) c = vec3(luma(c));
}`,
    anchors: {
      "band-detail": `  // Band-limited detail (highlight / shadow). Tonal recovery and lift compress a
  // luminance band, which dulls its micro-contrast (cloud texture, shadow detail).
  // A luminance curve can't add it back without also moving other tones that overlap
  // in luma (sky vs lit foliage), so restore LOCAL contrast instead — confined to the
  // band where the pixel ended up, clamped to limit edge overshoot (anti-halo).
  //
  // Each band's gain = an auto term (engaged by recovery/lift so a tone move never
  // flattens texture on its own) + the user's Highlight/Shadow Detail slider
  // (bidirectional: + crisper, - smoother). At the slider's default of 0 the highlight
  // term is identical to the original recovery-coupled restore. The shadow auto term is
  // gentler than the highlight one because the dark band is where sensor noise lives.
  // Version 2's Highlights and Shadows keep texture themselves (local-tone.ts), so
  // there each band's gain is its Detail slider alone.
  float bandDet = clamp(rawLuma - lumaLod(srcUv, 2.0), -0.15, 0.15);
  float hiGain = (H < 0.0 ? -H : 0.0) + uHighlightDetail / 100.0;
  if (abs(hiGain) > 0.001) {
    float hiZone = smoothstep(0.45, 0.78, luma(c));
    c += bandDet * hiGain * hiZone * BAND_DETAIL;
  }
  float shGain = (S > 0.0 ? 0.5 * S : 0.0) + uShadowDetail / 100.0;
  if (abs(shGain) > 0.001) {
    float shZone = 1.0 - smoothstep(0.12, 0.45, luma(c));
    c += bandDet * shGain * shZone * BAND_DETAIL;
  }
  c = clamp(c, 0.0, 1.0);`,
      "color-grading": `c = applyColorGrading(c);`,
      "display-basic": `  // Whites (display space): endpoint control for the bright end.
  // Gamma-based adjustment weighted by cubic peaking at white.
  if (abs(uWhites) > 0.001) {
    float wAmt = uWhites / 100.0;
    float L = max(luma(c), 1e-4);
    float wW = L * L * L;
    float gamma = wAmt > 0.0 ? mix(1.0, 0.5, wAmt) : mix(1.0, 1.9, -wAmt);
    float newL = mix(L, pow(L, gamma), wW);
    c = c * (newL / L);
    c = clamp(c, 0.0, 1.0);
  }

  // Blacks (display space): endpoint control for the dark end.
  // Gamma-based adjustment weighted by cubic peaking at black.
  if (abs(uBlacks) > 0.001) {
    float bAmt = uBlacks / 100.0;
    float L = max(luma(c), 1e-4);
    float bW = (1.0 - L) * (1.0 - L) * (1.0 - L);
    float gamma = bAmt > 0.0 ? mix(1.0, 0.55, bAmt) : mix(1.0, 2.2, -bAmt);
    float newL = mix(L, pow(L, gamma), bW);
    c = c * (newL / L);
    c = clamp(c, 0.0, 1.0);
  }

  // Contrast: luminance-based S-curve (always safe: display values in [0,1]).
  float ck = (uContrast / 100.0) * 0.8;
  if (abs(ck) > 0.001) {
    float L = luma(c);
    float Lnew = clamp(L + ck * L * (1.0 - L) * (2.0 * L - 1.0), 0.0, 1.0);
    c = c * (Lnew / max(L, 1e-4));
    c = clamp(c, 0.0, 1.0);
  }`,
      "geometry": ``,
      "hsl": `c = applyHSL(c);`,
      "masks": ``,
      "presence": `  // Dehaze: dark channel prior with global atmospheric light estimate.
  if (abs(dehAmt) > 0.001) {
    // Local dark channel from a medium blur
    vec3 localBlur = textureLod(uImage, srcUv, 4.0).rgb;
    if (!uLinear) localBlur = srgbToLinear(localBlur);
    localBlur = linearToSrgbU(localBlur);
    float dc = min(min(localBlur.r, localBlur.g), localBlur.b);
    // Atmospheric light: global estimate from the coarsest mip
    vec3 globalBlur = textureLod(uImage, vec2(0.5, 0.5), 9.0).rgb;
    if (!uLinear) globalBlur = srgbToLinear(globalBlur);
    globalBlur = linearToSrgbU(globalBlur);
    float A = clamp(max(max(globalBlur.r, globalBlur.g), globalBlur.b), 0.5, 0.98);
    // Transmission: normalize dark channel by atmospheric light
    float t_est = clamp(1.0 - dehAmt * 1.2 * dc / max(A, 0.5), 0.12, 1.0);
    c = (c - vec3(A) * (1.0 - t_est)) / max(t_est, 0.12);
    // Saturation restoration: haze washes out color
    float dl = luma(c);
    c = mix(vec3(dl), c, 1.0 + dehAmt * 0.4);
    c = clamp(c, 0.0, 1.0);
  }
  // Clarity: broad local contrast, midtone-focused. A plain broad mip blur
  // averages ACROSS hard edges, so rawLuma - blur overshoots in a band as wide
  // as the blur radius -- that band IS the halo, and masking/clamping it can only
  // attenuate, never remove it. The fix is to make the broad reference EDGE-AWARE:
  // a bilateral blur over 16 mip-blurred taps (two rings), each weighted by luma
  // similarity to the centre so taps across an edge are dropped. The reference
  // then tracks the local side of every boundary, rawLuma - base is ~0 at edges
  // (no ring), and only within-region midtone texture is lifted. CLAR_EDGE is the
  // edge stop: smaller = holds edges harder (less halo), larger = smoother.
  float midMask = 1.0 - pow(clamp(abs(luma(c) - 0.5) * 1.6, 0.0, 1.0), 3.0);
  if (abs(clarAmt) > 0.001) {
    // Edge-aware reference. Each broad tap is blended TOWARD the centre by its
    // luma-similarity weight: a same-side tap contributes its value, a tap across
    // an edge (incl. a mip tap that straddles one) contributes the centre value
    // instead. So the reference equals the local side at every boundary -- no
    // cross-edge averaging (no halo) and no pull from intermediate taps (no ghost
    // outline). rawLuma - base is ~0 at edges and in flats, nonzero only for
    // within-region midtone texture. CLAR_EDGE = edge stop (smaller = stricter).
    const float CLAR_EDGE = 0.08;
    float cen = rawLuma;
    float base = cen;            // centre tap
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981634;   // i * 2*pi/8
      vec2 dir = vec2(cos(a), sin(a));
      float s1 = lumaLod(srcUv + dir * 0.016, 3.0);
      float w1 = exp(-(s1 - cen) * (s1 - cen) / (2.0 * CLAR_EDGE * CLAR_EDGE));
      base += mix(cen, s1, w1);
      float s2 = lumaLod(srcUv + dir * 0.034, 4.0);
      float w2 = exp(-(s2 - cen) * (s2 - cen) / (2.0 * CLAR_EDGE * CLAR_EDGE));
      base += mix(cen, s2, w2);
    }
    base /= 17.0;               // centre + 16 taps
    c += (cen - base) * clarAmt * 1.5 * midMask;
  }
  // Texture: edge-aware micro-detail (LOD 0.75) — fine surface detail like
  // skin pores and fabric weave, suppressed at strong edges to avoid halos.
  if (abs(texAmt) > 0.001) {
    float fineBlur = lumaLod(srcUv, 0.75);
    float texDetail = rawLuma - fineBlur;
    float broadBlur = lumaLod(srcUv, 2.5);
    float edgeStrength = abs(rawLuma - broadBlur);
    float edgeMask = 1.0 - smoothstep(0.02, 0.12, edgeStrength);
    texDetail = clamp(texDetail, -0.08, 0.08);
    c += texDetail * texAmt * 2.5 * edgeMask;
  }`,
      "retouch": ``,
      "sharpen": `  // Capture sharpening with radius, detail (halo control), and edge masking.
  // Runs after vibrance/saturation so sharpening halos are not re-saturated.
  // sharpenViz carries the grayscale preview value when uSharpenViz is active;
  // the block also runs at amount 0 in that case so the preview is always live.
  float sharpenViz = 0.0;
  float sharpen = uSharpening / 100.0;
  if (sharpen > 0.001 || uSharpenViz > 0) {
    float lod = mix(0.5, 1.5, (uSharpenRadius - 1.0) / 2.0);
    float blur = lumaLod(srcUv, lod);
    float detail = rawLuma - blur;
    float detailFactor = uSharpenDetail / 100.0;
    float broadBlur = lumaLod(srcUv, lod + 1.0);
    detail = mix((rawLuma - broadBlur) * 0.35, detail, detailFactor);
    float mask = 1.0;
    if (uSharpenMasking > 0.001) {
      float edgeMag = abs(rawLuma - lumaLod(srcUv, 0.5));
      float threshold = (uSharpenMasking / 100.0) * 0.12;
      mask = smoothstep(threshold * 0.4, threshold, edgeMag);
    }
    if (sharpen > 0.001) c += detail * sharpen * 1.6 * mask;
    if (uSharpenViz == 1) sharpenViz = mask;                          // masking coverage
    else if (uSharpenViz == 2) sharpenViz = clamp(0.5 + detail * 4.0, 0.0, 1.0); // edge signal
    else if (uSharpenViz == 3) sharpenViz = luma(clamp(c, 0.0, 1.0)); // sharpened luminance
  }`,
      "tone": `  // Integrated tonal pipeline: exposure, highlights, and shadows are applied as
  // a single shoulder-based tone map instead of sequential independent operations.
  // Where the shoulder applies, exposure can't create unbounded values (no
  // blow-out); a display transform that skips it takes that headroom instead.
  // Either way highlight recovery works even at high exposure (+3..+5 EV).
  float E = uExposure;
  float H = clamp(uHighlights / 100.0, -1.0, 1.0);
  float S = clamp(uShadows / 100.0, -1.0, 1.0);
  {
    float L = max(luma(lin), 1e-4);

    // Exposure: true linear gain (×2 per stop)
    float Lx = L * exp2(E);

    // Filmic shoulder: piecewise curve — linear below knee, smooth Reinhard
    // compression above, keeping blown values out of display space wherever
    // it applies. Highlights slider controls the knee position:
    //   H < 0 (recover): lower knee → more of the range gets compressed
    //   H > 0 (brighten): raise knee → more headroom before compression
    float knee = 0.85;
    float rolloff = 0.5;
    if (H < 0.0) {
      knee = mix(0.85, 0.15, -H);
      rolloff = mix(0.5, 0.2, -H);
    } else if (H > 0.0) {
      knee = mix(0.85, 2.0, H);
      rolloff = mix(0.5, 1.5, H);
    }
    // Slope at the knee is (1-knee)/rolloff; clamp so it never exceeds 1.0,
    // otherwise midtones just above a low knee get lifted instead of compressed.
    rolloff = max(rolloff, 1.0 - knee);
    // Scale rolloff with sqrt of gain — enough to preserve highlight separation
    // at moderate exposure but lets high exposure (+5) push the image toward white
    rolloff *= max(exp2(max(E, 0.0) * 0.5), 1.0);

    float Lsc = Lx;
    if (Lx > knee) {
      float excess = Lx - knee;
      Lsc = knee + (1.0 - knee) * excess / (excess + rolloff);
    }
    // A transform with its own roll-off keeps the headroom: only recovery
    // (H < 0) blends the shoulder back in, in proportion to the slider.
    if (!uApplyToneShoulder) Lsc = mix(Lx, Lsc, max(-H, 0.0));

    lin = retargetLuma(lin, L, Lsc);

    // Hunt effect: restore colourfulness lost by pulling bright values down
    if (H < -0.001 && Lx > knee) {
      float pulled = clamp(Lx - Lsc, 0.0, 1.0);
      float Lr = luma(lin);
      lin = mix(vec3(Lr), lin, 1.0 + pulled * HI_SAT);
    }

    // Highlight lift (H > 0): gamma brighten the upper zone
    if (H > 0.001) {
      float Lcur = max(luma(lin), 1e-4);
      float hw = smoothstep(0.3, 0.9, Lcur);
      float gamma = mix(1.0, 0.5, H);
      float newLcur = mix(Lcur, pow(Lcur, gamma), hw * H);
      // The gamma lift darkens values above white; without the shoulder those
      // are the transform's headroom, so the lift may only brighten.
      if (!uApplyToneShoulder) newLcur = max(newLcur, Lcur);
      lin = retargetLuma(lin, Lcur, newLcur);
    }

    // Shadows: gamma toe weighted toward the dark end, fading out in highlights
    if (abs(S) > 0.001) {
      float Lcur = max(luma(lin), 1e-4);
      float shW = exp(-3.0 * Lcur);
      float gamma = S > 0.0 ? mix(1.0, 0.65, S) : mix(1.0, 1.8, -S);
      float newLcur = mix(Lcur, pow(Lcur, gamma), shW * abs(S));
      lin = retargetLuma(lin, Lcur, newLcur);
    }
  }`,
      "tone-curve": `c = applyToneCurve(c);`,
      "vibrance": `  c = applyVibSat(c, uVibrance, uSaturation);`,
      "white-balance": `lin = applyWhiteBalance(lin, uTemperature, uTint, uAsShotTemperature);`,
    },
  },
};
