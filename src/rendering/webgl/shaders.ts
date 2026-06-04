export const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  // Flip V here rather than via UNPACK_FLIP_Y_WEBGL. That pixelStore flag is
  // silently ignored for ImageBitmap uploads in some browsers, which left the
  // develop preview upside-down. Our source bitmaps are always top-down, so a
  // deterministic flip in the shader is correct on every browser.
  vUv = vec2(aUv.x, 1.0 - aUv.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// Single-pass develop shader. Most
// are per-pixel point operations; clarity is a midtone-contrast approximation
// (a true local-contrast version needs a blur pass, planned for a later phase).
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;
uniform sampler2D uCurve;

uniform vec4 uCrop;         // x, y, width, height (transformed image space, y-down)
uniform mat3 uInvTransform; // transformed-image coord -> source UV (projective)
uniform bool uLinear;       // true: source texture is linear float (RAW); skip sRGB decode
uniform bool uIsFallbackPreview; // true: source is pseudo-linear from 8-bit JPEG preview

uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTexture;
uniform float uClarity;
uniform float uDehaze;
uniform float uSharpening;
uniform float uSharpenRadius;    // 1..3
uniform float uSharpenDetail;    // 0..100
uniform float uSharpenMasking;   // 0..100
uniform float uLuminanceNR;
uniform float uLumNRDetail;      // 0..100
uniform float uLumNRContrast;    // 0..100
uniform float uColorNR;
uniform float uColorNRDetail;    // 0..100
uniform float uColorNRSmooth;    // 0..100
uniform float uVibrance;
uniform float uSaturation;
uniform float uTemperature;
uniform float uTint;

uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];

// Color grading wheels: per-range hue (degrees), saturation (0..100), luma (-100..100)
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
uniform float uCGShadowRange;    // 0..1
uniform float uCGHighlightRange; // 0..1

// Lens correction
uniform float uLensDistortion;    // -100..100 (barrel/pincushion)
uniform float uLensCA;            // 0..100 lateral chromatic aberration removal
uniform float uLensDefringe;      // 0..100 purple/green fringe suppression
uniform float uLensVignetting;    // -100..100 optical vignetting correction

// Effects: vignette
uniform float uVignetteAmount;    // -100..100
uniform float uVignetteMidpoint;  // 0..100
uniform float uVignetteRoundness; // -100..100
uniform float uVignetteFeather;   // 0..100
uniform float uVignetteHighlights;// 0..100

// Effects: grain
uniform float uGrainAmount;    // 0..100
uniform float uGrainSize;      // 25..100
uniform float uGrainRoughness; // 0..100

// Image aspect (width / height) — used so radial masks and round retouch discs
// stay circular on screen despite the non-square source-UV space.
uniform float uImageAspect;


// Local adjustment masks (linear / radial parametric, brush via texture).
#define MAX_MASKS 8
uniform int uMaskCount;
uniform sampler2D uMaskTex;        // RGBA brush coverage atlas
uniform int uMaskType[MAX_MASKS];  // 0 linear, 1 radial, 2 brush
uniform int uMaskInvert[MAX_MASKS];
uniform int uMaskBrushCh[MAX_MASKS]; // channel 0..3 in uMaskTex
uniform float uMaskOpacity[MAX_MASKS]; // 0..1
uniform vec4 uMaskGeoA[MAX_MASKS]; // linear: x0,y0,x1,y1 ; radial: cx,cy,rx,ry
uniform vec4 uMaskGeoB[MAX_MASKS]; // radial: feather,_,_,_
uniform vec4 uMaskAdj0[MAX_MASKS]; // exposure, contrast, highlights, shadows
uniform vec4 uMaskAdj1[MAX_MASKS]; // saturation, temperature, tint, clarity
uniform vec4 uMaskAdj2[MAX_MASKS]; // sharpness, _, _, _

// Retouch (spot removal): heal / clone discs.
#define MAX_SPOTS 16
uniform int uSpotCount;
uniform vec4 uSpotA[MAX_SPOTS]; // dstX, dstY, srcX, srcY
uniform vec4 uSpotB[MAX_SPOTS]; // radius(height units), feather(0..1), opacity(0..1), mode(0 heal,1 clone)

// Brush-shaped retouch: painted coverage atlas + per-item source offset.
#define MAX_RBRUSH 4
uniform sampler2D uRetouchTex;
uniform int uRetouchCount;
uniform int uRetouchCh[MAX_RBRUSH];     // channel 0..3 in uRetouchTex
uniform vec4 uRetouchData[MAX_RBRUSH];  // offX, offY (UV), opacity(0..1), mode(0 heal,1 clone)

const float HSL_CENTERS[8] = float[8](
  0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 280.0, 320.0
);

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// sRGB encode without the upper clamp, so exposure can carry highlights past 1.0
// (HDR) into the highlight-recovery stage instead of hard-clipping immediately.
vec3 linearToSrgbU(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Per-channel highlight rolloff: values above the knee are folded smoothly into
// [knee, 1] (a saturating shoulder), recovering blown highlights. With knee = 1
// it's a plain clip (the default, no recovery); lowering the knee — driven by
// negative Highlights/Whites — reaches further down for stronger recovery.
float rollHi(float v, float knee) {
  if (v <= knee) return min(v, 1.0);
  float head = max(1.0 - knee, 1e-3);
  return knee + head * (1.0 - exp(-(v - knee) / head));
}

// Approximate the (linear) RGB color of a blackbody at the given Kelvin
// temperature (Tanner Helland's fit). Used to derive white-balance gains.
vec3 blackbodyLinear(float kelvin) {
  float t = clamp(kelvin, 1000.0, 50000.0) / 100.0;
  float r, g, b;
  if (t <= 66.0) {
    r = 255.0;
    g = 99.4708025861 * log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
  }
  if (t >= 66.0) {
    b = 255.0;
  } else if (t <= 19.0) {
    b = 0.0;
  } else {
    b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
  }
  vec3 srgb = clamp(vec3(r, g, b) / 255.0, 0.0008, 1.0);
  return srgbToLinear(srgb);
}

// White balance as a Kelvin temperature (warming the image as the value rises)
// plus a green↔magenta tint. Gains are derived so 6500K is
// neutral, normalized on green to hold brightness.
vec3 applyWhiteBalance(vec3 c, float kelvin, float tint) {
  vec3 gain = blackbodyLinear(6500.0) / blackbodyLinear(kelvin);
  gain /= gain.g;
  gain.g *= 1.0 - (tint / 150.0) * 0.6; // +tint -> magenta, -tint -> green
  return c * gain;
}

// Exposure tone-mapping.
//
// The old Michaelis-Menten form  I*k/((k-1)*I + 1)  reaches *exactly* 1.0 at a
// linear input of I=1 and only asymptotes at k/(k-1) (e.g. 1.14 at +5). After a
// big push every bright value above ~0.16 was therefore crushed into the top
// ~10% of the range and clipped — all of it landing in the same output bin,
// which is the tall narrow highlight spike (visible even at Highlights=0) and the
// emptied upper-midtones. Lightroom instead lets highlights roll toward white
// gradually, keeping their spread as a broad hump.
//
// This keeps the same shadow/midtone gain (so positions still match LR) but gives
// the highlights real headroom: the saturation coefficient beta = 1/g makes the
// curve asymptotic to 1.0 only many stops up, so the bright band spreads across
// the highlights instead of piling at the clip point. beta -> 1 as E -> 0, so the
// curve is an exact identity at EV 0; negative exposure is a plain gain (no need
// for a highlight shoulder when darkening).
float applyExposure(float i_in, float E) {
  float g = exp2(E);
  if (E <= 0.0) return i_in * g;
  float beta = 1.0 / g;
  return g * i_in / (1.0 + (g - beta) * i_in);
}

// Highlights recovery (H < 0): per-channel rollHi with a sliding knee.
// knee = 1.0 at H=0 (no-op), slides to 0.5 at H=-1 (aggressive recovery).
// rollHi is already identity below the knee, so no bell-weight mixing is needed —
// that was the graying bug: per-channel bell mixing preferentially compressed the
// dominant channel in saturated colors while leaving others alone → desaturation.
// With rollHi, a red pixel's low G/B channels are below the knee and untouched.
//
// Highlights lift (H > 0): luminance-ratio applied to preserve hue.
// Additive bell on luminance; ratio scales all channels identically → no hue shift.
//
// Shadows (S): gamma toe on linear luminance, ratio-scaled (hue preserved). Strength
// falls off as exp(-λ·t) over display luma t so shadows lift most, mids/highlights
// still stretch with exponentially decreasing weight — no hard shadow/mid cutoff.

// Per-channel highlight recovery curve. amt in [0,1] (= -H).
// rollHi only soft-clipped the HDR over-range back toward 1.0, so blown whites
// stayed pinned to the right edge of the histogram — nothing actually moved at
// -100. This instead (1) folds any over-range into [thr,1], then (2) compresses
// that highlight band DOWNWARD toward the threshold, so a clipped white is pulled
// well back into the histogram, the way Lightroom's Highlights -100 does.
// Per-channel: a channel that clipped is rebuilt from the level of the others.
float hiDown(float v, float amt) {
  float thr = mix(0.70, 0.45, amt);           // band start slides down with amount
  if (v <= thr) return min(v, 1.0);
  float head = max(1.0 - thr, 1e-3);
  float sat = thr + head * (1.0 - exp(-(v - thr) / head)); // saturate into [thr,1]
  float comp = mix(1.0, 0.35, amt);            // pull the band toward the threshold
  return thr + (sat - thr) * comp;
}

// Exponential shadow weight: w = exp(-λ·t), t = display luma in [0,1]. Black gets
// full strength; mids and highlights still move, with weight decreasing exponentially.
float shadowWeight(vec3 linRgb) {
  float t = clamp(luma(linearToSrgbU(max(linRgb, vec3(0.0)))), 0.0, 1.0);
  return exp(-2.75 * t);
}

// Exponential highlight weight: w = exp(-λ·(1-t)), t = display luma in [0,1]. White gets
// full strength; mids and shadows still move, with weight decreasing exponentially.
float highlightWeight(vec3 linRgb) {
  float t = clamp(luma(linearToSrgbU(max(linRgb, vec3(0.0)))), 0.0, 1.0);
  return exp(-3.5 * (1.0 - t));
}

// Exponential whites weight: w = exp(-λ·(1-t)²), t = display luma in [0,1]. Stronger
// falloff than highlights, focused on the extreme bright end.
float whitesWeight(vec3 linRgb) {
  float t = clamp(luma(linearToSrgbU(max(linRgb, vec3(0.0)))), 0.0, 1.0);
  return exp(-8.0 * (1.0 - t) * (1.0 - t));
}

// Exponential blacks weight: w = exp(-λ·t²), t = display luma in [0,1]. Stronger
// falloff than shadows, focused on the extreme dark end.
float blacksWeight(vec3 linRgb) {
  float t = clamp(luma(linearToSrgbU(max(linRgb, vec3(0.0)))), 0.0, 1.0);
  return exp(-8.0 * t * t);
}

// Highlights applied to linear RGB. H in [-1, 1] (uHighlights / 100).
// Uses broad per-pixel weight centered on highlights, feathering across the range.
vec3 applyHighlightsRGB(vec3 c, float H) {
  if (H < 0.0) {
    // Recovery: pull the highlight band down with luminance-based compression
    // to preserve hue. Weighted by highlightWeight so different luminances shift
    // by different amounts.
    float amt = -H;
    float w = highlightWeight(c);
    float blend = amt * w;
    if (blend < 1e-5) return c;
    float L = max(luma(c), 1e-4);
    // Apply per-channel compression, then ratio-scale to preserve hue
    vec3 compressed = vec3(hiDown(c.r, amt), hiDown(c.g, amt), hiDown(c.b, amt));
    float Lcomp = luma(compressed);
    float newL = mix(L, Lcomp, blend);
    c *= newL / L;
  } else {
    // Lift: gamma brightening of the highlight zone, ratio-scaled (hue-preserving).
    // Weighted by highlightWeight so different luminances shift by different amounts.
    float w = highlightWeight(c);
    float blend = H * w;
    if (blend < 1e-5) return c;
    float L = max(luma(c), 1e-4);
    float gamma = mix(1.0, 0.4, H);
    float newL = mix(L, pow(L, gamma), blend);
    c *= newL / L;
  }
  return c;
}

// Shadows lift/crush on linear RGB. S in [-1, 1] (uShadows / 100).
vec3 applyShadowsRGB(vec3 c, float S) {
  float L = max(luma(c), 1e-4);
  float w = shadowWeight(c);
  float blend = abs(S) * w;
  if (blend < 1e-5) return c;

  float gamma = S > 0.0 ? mix(1.0, 0.55, abs(S)) : mix(1.0, 2.35, -S);
  float newL = mix(L, pow(L, gamma), blend);
  c *= newL / L;
  return c;
}

// Whites point adjustment with broad per-pixel weight centered on extreme highlights.
// Different luminances shift by different amounts, redistributing across the range.
float applyWhites(float v, float wh) {
  if (wh <= 0.0) return v;
  float amt = wh / 100.0;
  vec3 c = vec3(v);
  float w = whitesWeight(c);
  float blend = amt * w;
  if (blend < 1e-5) return v;
  // Gamma brightening for whites lift
  float gamma = mix(1.0, 0.5, amt);
  return mix(v, pow(max(v, 0.0), gamma), blend);
}

// Blacks point adjustment with broad per-pixel weight centered on extreme shadows.
// Different luminances shift by different amounts, redistributing across the range.
float applyBlacks(float v, float bl) {
  if (bl <= 0.0) return v;
  float amt = bl / 100.0;
  vec3 c = vec3(v);
  float w = blacksWeight(c);
  float blend = amt * w;
  if (blend < 1e-5) return v;
  // Gamma darkening for blacks crush
  float gamma = mix(1.0, 2.5, amt);
  return mix(v, pow(max(v, 0.0), gamma), blend);
}

vec3 applyToneCurve(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  // Per-channel LUTs packed into RGBA (master curve already composed in).
  c.r = texture(uCurve, vec2(c.r, 0.5)).r;
  c.g = texture(uCurve, vec2(c.g, 0.5)).g;
  c.b = texture(uCurve, vec2(c.b, 0.5)).b;
  return c;
}

vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float h = 0.0;
  float s = 0.0;
  float l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d > 0.00001) {
    s = l < 0.5 ? d / (mx + mn) : d / (2.0 - mx - mn);
    if (mx == c.r) {
      h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    } else if (mx == c.g) {
      h = (c.b - c.r) / d + 2.0;
    } else {
      h = (c.r - c.g) / d + 4.0;
    }
    h /= 6.0;
  }
  return vec3(h, s, l);
}

// Convert RGB to YCbCr (BT.709) for better luminance/chroma separation
vec3 rgb2YCbCr(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float cb = (c.b - y) * 0.5 / (1.0 - 0.0722) + 0.5;
  float cr = (c.r - y) * 0.5 / (1.0 - 0.2126) + 0.5;
  return vec3(y, cb, cr);
}

// Convert YCbCr (BT.709) back to RGB
vec3 yCbCr2rgb(vec3 ycbcr) {
  float y = ycbcr.x;
  float cb = ycbcr.y - 0.5;
  float cr = ycbcr.z - 0.5;
  float r = y + cr * (1.0 - 0.2126) * 2.0;
  float b = y + cb * (1.0 - 0.0722) * 2.0;
  float g = y - (cb * (1.0 - 0.0722) * 2.0 * 0.0722 / 0.7152 + cr * (1.0 - 0.2126) * 2.0 * 0.2126 / 0.7152);
  return clamp(vec3(r, g, b), 0.0, 1.0);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x;
  float s = hsl.y;
  float l = hsl.z;
  if (s <= 0.00001) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(
    hue2rgb(p, q, h + 1.0 / 3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0 / 3.0)
  );
}

vec3 applyHSL(vec3 c) {
  vec3 hsl = rgb2hsl(c);
  float hueDeg = hsl.x * 360.0;
  float hueShift = 0.0;
  float satMul = 0.0;
  float lumAdd = 0.0;
  for (int i = 0; i < 8; i++) {
    float dist = abs(mod(hueDeg - HSL_CENTERS[i] + 540.0, 360.0) - 180.0);
    float w = max(0.0, 1.0 - dist / 35.0);
    hueShift += uHslHue[i] * w;
    satMul += uHslSat[i] * w;
    lumAdd += uHslLum[i] * w;
  }
  hsl.x = fract(hsl.x + hueShift * (30.0 / 360.0));
  hsl.y = clamp(hsl.y * (1.0 + satMul), 0.0, 1.0);
  hsl.z = clamp(hsl.z + lumAdd * 0.4, 0.0, 1.0);
  return hsl2rgb(hsl);
}

// Blurred source luminance at a mip level — a cheap Gaussian-ish blur whose
// radius grows with the lod. Texture/Clarity/Dehaze build their local contrast
// (unsharp masks) from the difference between the pixel and this blur.
// Perceptual luminance of a source sample, encoded so local-contrast magnitudes
// match whether the texture is linear-float (RAW) or already sRGB (8-bit).
float srcLuma(vec3 s) {
  float l = luma(max(s, 0.0));
  return uLinear ? sqrt(l) : l;
}
float lumaLod(vec2 uv, float lod) {
  return srcLuma(textureLod(uImage, uv, lod).rgb);
}

vec3 applyVibSat(vec3 c, float vib, float sat) {
  float l = luma(c);
  c = mix(vec3(l), c, 1.0 + sat / 100.0);
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float curSat = mx - mn;
  float vibAmt = (vib / 100.0) * (1.0 - curSat);
  c = mix(vec3(l), c, 1.0 + vibAmt);
  return c;
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

  c += shadowW    * shColor
     + midW       * midColor
     + highlightW * hiColor
     + glColor;  // global applied uniformly

  // Per-range luminance adjustments, scaled so ±100 → ±0.25 exposure-equivalent.
  float lumaAdj = shadowW    * (uCGShadowLuma / 100.0) * 0.25
                + midW       * (uCGMidLuma    / 100.0) * 0.25
                + highlightW * (uCGHighLuma   / 100.0) * 0.25
                + (uCGGlobalLuma / 100.0) * 0.20;
  c += vec3(lumaAdj);

  return clamp(c, 0.0, 1.0);
}

// Inverse map from output (crop) coord to source UV: see crop-transform.ts,
// which mirrors this exactly. vUv already has V flipped, so both are in
// top-left-origin image space. The geometry transform (straighten, perspective,
// stretch, scale, offset) is processed before — and independent of — the crop.
vec2 cropTransformUV(vec2 o) {
  vec2 p = uCrop.xy + o * uCrop.zw;
  vec3 q = uInvTransform * vec3(p, 1.0);
  return q.xy / q.z;
}

// Radial barrel/pincushion distortion correction applied to source UV.
// k > 0 fixes barrel (outward bulge), k < 0 fixes pincushion (inward pinch).
vec2 lensCorrectedUV(vec2 uv) {
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);
  float k = uLensDistortion * 0.0003; // scale factor: 100 → ~strong barrel fix
  return 0.5 + centered * (1.0 + k * r2);
}

// Lateral chromatic aberration correction: scale R and B channels outward/inward.
// The fringing is radial from center so we shift the sample UV per channel.
vec3 sampleWithCA(vec2 uv) {
  float ca = uLensCA / 100.0 * 0.008; // max 0.8% offset at full strength
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);
  float scale = ca * r2 * 4.0; // quadratic: more at corners, zero at center
  vec2 uvR = 0.5 + centered * (1.0 + scale);
  vec2 uvB = 0.5 + centered * (1.0 - scale);
  float r = texture(uImage, clamp(uvR, 0.0, 1.0)).r;
  float g = texture(uImage, uv).g;
  float b = texture(uImage, clamp(uvB, 0.0, 1.0)).b;
  return vec3(r, g, b);
}

// Defringe: detect and suppress purple/green fringing by desaturating
// hue ranges that occur at high chroma at edges.
vec3 applyDefringe(vec3 c, float amount) {
  if (amount < 0.001) return c;
  float l = luma(c);
  float chroma = length(c - vec3(l));
  // Purple (~300°) and green (~120°) fringe hues have negative R-B and R-G relations
  float purpleish = max(0.0, c.b - c.r) + max(0.0, c.b - c.g); // blue dominant
  float greenish  = max(0.0, c.g - c.r) + max(0.0, c.g - c.b); // green dominant
  float fringeMag = clamp((purpleish + greenish) * 4.0, 0.0, 1.0);
  float suppress = clamp(amount / 100.0 * fringeMag * (chroma * 8.0), 0.0, 1.0);
  return mix(c, vec3(l), suppress);
}

// Lens optical vignetting correction (adds light to corners to flatten falloff).
float lensVignetteFactor(vec2 uv) {
  if (abs(uLensVignetting) < 0.001) return 1.0;
  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered) * 4.0; // 0 at center, 1 at corners
  // cos^4 law approximation: natural falloff then we correct against it
  float falloff = pow(clamp(1.0 - r2 * 0.5, 0.0, 1.0), 2.0);
  float correction = uLensVignetting > 0.0
    ? 1.0 + (1.0 - falloff) * (uLensVignetting / 100.0) // brighten corners
    : 1.0 - (1.0 - falloff) * (-uLensVignetting / 100.0); // darken corners
  return clamp(correction, 0.0, 2.0);
}

// Post-crop creative vignette
vec3 applyVignette(vec3 c, vec2 uv) {
  if (abs(uVignetteAmount) < 0.001) return c;
  vec2 centered = uv - 0.5;
  // Roundness: -1 = rectangular, 0 = ellipse, +1 = circular
  float roundness = uVignetteRoundness / 100.0;
  float rx = abs(centered.x);
  float ry = abs(centered.y);
  // Interpolate between Chebyshev (rect) and Euclidean (circle) norms
  float rect = max(rx, ry);
  float circ = length(centered);
  float r = mix(rect, circ, clamp(roundness + 0.5, 0.0, 1.0)) * 2.0;
  // Midpoint: how far the vignette reaches in (0=edges only, 1=reaches center)
  float midpoint = mix(0.5, 1.5, 1.0 - uVignetteMidpoint / 100.0);
  float feather = mix(0.05, 0.95, uVignetteFeather / 100.0);
  float lo = max(0.0, midpoint - feather * 0.5);
  float hi = midpoint + feather * 0.5;
  float edge = smoothstep(lo, hi, r);
  float vigAmt = uVignetteAmount / 100.0;
  float darkening = vigAmt < 0.0 ? -vigAmt * edge : 0.0;
  float lightening = vigAmt > 0.0 ?  vigAmt * edge : 0.0;
  // Highlight priority: protect bright areas from darkening vignette
  float hlProtect = uVignetteHighlights > 0.001
    ? clamp(luma(c) * (uVignetteHighlights / 100.0) * 2.0, 0.0, 1.0)
    : 0.0;
  darkening *= (1.0 - hlProtect);
  c = c * (1.0 - darkening) + c * lightening;
  return clamp(c, 0.0, 1.0);
}

// Hash-based pseudo-random noise for film grain.
float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

vec3 applyGrain(vec3 c, vec2 uv) {
  if (uGrainAmount < 0.001) return c;
  float amount = uGrainAmount / 100.0 * 0.12; // max ~12% peak grain
  // Size: larger values cluster grain into coarser patches
  float sizeScale = mix(800.0, 100.0, (uGrainSize - 25.0) / 75.0);
  vec2 grainUv = uv * sizeScale;
  // Roughness: blends between smooth (averaged neighbors) and raw noise
  float n = hash(floor(grainUv));
  if (uGrainRoughness < 99.0) {
    float smoothed = 0.0;
    for (int dx = -1; dx <= 1; dx++) {
      for (int dy = -1; dy <= 1; dy++) {
        smoothed += hash(floor(grainUv) + vec2(float(dx), float(dy)));
      }
    }
    smoothed /= 9.0;
    float rough = uGrainRoughness / 100.0;
    n = mix(smoothed, n, rough);
  }
  // Center the noise at 0 and scale. Luminance-weighted: less grain in shadows.
  float lumaW = clamp(luma(c) * 1.5 + 0.2, 0.2, 1.0);
  float grain = (n - 0.5) * 2.0 * amount * lumaW;
  return clamp(c + grain, 0.0, 1.0);
}


// ---- Retouch: spot heal / clone -------------------------------------------
// Replace the source sample where retouch discs cover, before any tone edits so
// the patched pixels develop together with the rest of the frame.
vec3 applyRetouch(vec2 uv, vec3 base) {
  vec3 c = base;
  for (int i = 0; i < MAX_SPOTS; i++) {
    if (i >= uSpotCount) break;
    vec4 a = uSpotA[i];
    vec4 b = uSpotB[i];
    vec2 dst = a.xy;
    vec2 off = a.zw - dst;            // source-center minus dest-center
    float radius = max(b.x, 1e-4);
    float feather = b.y;
    float opacity = b.z;
    float d = length(vec2((uv.x - dst.x) * uImageAspect, uv.y - dst.y)) / radius;
    if (d >= 1.0) continue;
    float w = (1.0 - smoothstep(1.0 - feather, 1.0, d)) * opacity;
    if (w <= 0.0) continue;
    vec2 sUv = clamp(uv + off, 0.0, 1.0);
    vec3 srcCol = texture(uImage, sUv).rgb;
    if (b.w < 0.5) {
      // Heal: carry the source texture but match the destination's local tone.
      vec3 dstLow = textureLod(uImage, uv, 4.0).rgb;
      vec3 srcLow = textureLod(uImage, sUv, 4.0).rgb;
      srcCol = clamp(srcCol + (dstLow - srcLow), 0.0, 1.0);
    }
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
      if (rd.w < 0.5) {
        vec3 dstLow = textureLod(uImage, uv, 4.0).rgb;
        vec3 srcLow = textureLod(uImage, sUv, 4.0).rgb;
        srcCol = clamp(srcCol + (dstLow - srcLow), 0.0, 1.0);
      }
      c = mix(c, srcCol, w);
    }
  }
  return c;
}

// ---- Local adjustment masks ------------------------------------------------
float maskCoverage(int i, vec2 uv) {
  int type = uMaskType[i];
  float m = 0.0;
  if (type == 0) {
    // Linear gradient: ramp 0->1 projected onto the drag direction.
    vec2 p0 = uMaskGeoA[i].xy;
    vec2 p1 = uMaskGeoA[i].zw;
    vec2 dir = p1 - p0;
    float len2 = max(dot(dir, dir), 1e-6);
    m = clamp(dot(uv - p0, dir) / len2, 0.0, 1.0);
  } else if (type == 1) {
    // Radial: 1 inside, feathered to 0 at the edge. Worked in screen-proportional
    // space (x scaled by aspect) so the ellipse and its rotation stay rigid on
    // screen. Reduces to the plain (uv-ctr)/rad test when angle = 0.
    vec2 ctr = uMaskGeoA[i].xy;
    vec2 rad = max(uMaskGeoA[i].zw, vec2(1e-4));
    float feather = uMaskGeoB[i].x;
    float ang = uMaskGeoB[i].y;
    vec2 q = vec2((uv.x - ctr.x) * uImageAspect, uv.y - ctr.y);
    float ca = cos(ang);
    float sa = sin(ang);
    vec2 qr = vec2(ca * q.x + sa * q.y, -sa * q.x + ca * q.y);
    vec2 radS = vec2(rad.x * uImageAspect, rad.y);
    float d = length(qr / radS);
    m = 1.0 - smoothstep(1.0 - feather, 1.0, d);
  } else {
    // Brush: prebaked coverage from the atlas channel.
    vec4 cov = texture(uMaskTex, uv);
    int ch = uMaskBrushCh[i];
    m = ch == 0 ? cov.r : (ch == 1 ? cov.g : (ch == 2 ? cov.b : cov.a));
  }
  if (uMaskInvert[i] == 1) m = 1.0 - m;
  return clamp(m * uMaskOpacity[i], 0.0, 1.0);
}

// Apply a mask's local adjustments to the display-space color, blended by m.
vec3 applyMaskAdj(vec3 c, vec4 a0, vec4 a1, float sharp, float m, vec2 uv) {
  vec3 r = c;
  // Exposure (multiplicative).
  r *= exp2((a0.x / 100.0) * 1.2);
  // Contrast S-curve.
  float k = (a0.y / 100.0) * 0.7;
  r = clamp(r + k * r * (1.0 - r) * (2.0 * r - 1.0), 0.0, 1.0);
  // Highlights / shadows via luminance weighting.
  float L = luma(r);
  r += (a0.z / 100.0) * 0.25 * smoothstep(0.5, 1.0, L);
  r += (a0.w / 100.0) * 0.25 * (1.0 - smoothstep(0.0, 0.5, L));
  // Temperature (warm/cool) and tint (magenta/green) shifts.
  float temp = a1.y / 100.0;
  float tnt = a1.z / 100.0;
  r += vec3(temp * 0.12, 0.0, -temp * 0.12);
  r += vec3(tnt * 0.08, -tnt * 0.08, tnt * 0.08);
  // Saturation.
  float Lr = luma(r);
  r = mix(vec3(Lr), r, 1.0 + a1.x / 100.0);
  // Clarity (broad) and sharpness (fine) local contrast.
  float clar = a1.w / 100.0;
  float shp = sharp / 100.0;
  if (abs(clar) > 0.001 || abs(shp) > 0.001) {
    float base = luma(r);
    r += (base - lumaLod(uv, 4.0)) * clar * 1.2;
    r += (base - lumaLod(uv, 1.5)) * shp * 1.2;
  }
  r = clamp(r, 0.0, 1.0);
  return mix(c, r, m);
}

void main() {
  vec2 srcUv = cropTransformUV(vUv);
  // Lens distortion correction: remap srcUv before any sampling
  if (abs(uLensDistortion) > 0.001) {
    srcUv = lensCorrectedUV(srcUv);
  }
  // Content rotated out of frame by straighten reads as neutral dark, so corners
  // stay clean instead of smearing the edge texel.
  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    fragColor = vec4(0.04, 0.04, 0.04, 1.0);
    return;
  }
  // Sample with chromatic aberration correction (CA splits R/B channels radially)
  vec3 src = uLensCA > 0.001 ? sampleWithCA(srcUv) : texture(uImage, srcUv).rgb;
  // Spot removal (heal / clone): patch the source before any tone edits.
  if (uSpotCount > 0 || uRetouchCount > 0) src = applyRetouch(srcUv, src);
  // Lens optical vignetting correction (flatten corner light falloff)
  src *= lensVignetteFactor(srcUv);
  float rawLuma = srcLuma(src);

  // Local-contrast detail (unsharp masks), measured from the source in a
  // perceptual space: a fine scale for Texture, a broad scale for Clarity/Dehaze.
  float texAmt = uTexture / 100.0;
  float clarAmt = uClarity / 100.0;
  float dehAmt = uDehaze / 100.0;
  float texDetail = abs(texAmt) > 0.001 ? rawLuma - lumaLod(srcUv, 2.0) : 0.0;
  float broadDetail =
    (abs(clarAmt) > 0.001 || abs(dehAmt) > 0.001)
      ? rawLuma - lumaLod(srcUv, 5.0)
      : 0.0;

  // White balance & exposure in linear light, kept HDR (no clamp) so highlights
  // survive past 1.0 into the recovery stage. RAW input is already linear.
  // Fallback preview is already pseudo-linear (inverse gamma applied in JS).
  vec3 lin = uLinear ? src : (uIsFallbackPreview ? src : srgbToLinear(src));

  // Noise reduction, applied before exposure so it isn't amplified. Color NR
  // replaces chroma with a blurred (mip) version -- kills the rainbow speckle
  // that big exposure pushes reveal; Luminance NR eases luma toward the blur in
  // flat areas while protecting edges.
  float colorNR = uColorNR / 100.0;
  float lumNR = uLuminanceNR / 100.0;
  if (colorNR > 0.001 || lumNR > 0.001) {
    // Luminance NR uses a fixed LOD=2 blur for edge detection
    vec3 b = textureLod(uImage, srcUv, 2.0).rgb;
    vec3 blurLin = uLinear ? b : srgbToLinear(b);
    float ls = luma(lin);
    float lb = luma(blurLin);
    if (colorNR > 0.001) {
      // Color NR: detail (0-100) controls LOD -- higher preserves more color detail
      float colorLod = mix(3.0, 1.5, uColorNRDetail / 100.0);
      // Smoothness (0-100) scales the blend -- higher = more aggressive chroma smoothing
      float colorSmMult = mix(0.5, 1.5, uColorNRSmooth / 100.0);
      vec3 bc = textureLod(uImage, srcUv, colorLod).rgb;
      vec3 blurC = uLinear ? bc : srgbToLinear(bc);
      float lbc = luma(blurC);
      vec3 deChroma = vec3(ls) + (blurC - vec3(lbc));
      lin = mix(lin, deChroma, clamp(colorNR * colorSmMult, 0.0, 1.0));
    }
    if (lumNR > 0.001) {
      // Detail (0-100): higher = tighter edge threshold = preserve more texture
      float edgeThresh = mix(0.14, 0.03, uLumNRDetail / 100.0);
      // Contrast (0-100): widen the protection zone for tonal transitions
      float contrastBias = mix(0.0, 0.05, uLumNRContrast / 100.0);
      float edge = abs(luma(lin) - lb);
      float w = lumNR * (1.0 - smoothstep(max(edgeThresh - contrastBias, 0.0), edgeThresh, edge));
      lin += (mix(luma(lin), lb, w) - luma(lin));
    }
  }

  lin = applyWhiteBalance(lin, uTemperature, uTint);

  // Exposure in true stops: the slider is an EV value, so +1 must double the
  // linear signal (×2), matching Lightroom. The old ×0.6 scaling made +1 only
  // ~0.6 stops (×1.5) — every exposure was ~60% as strong as LR's, which is why
  // pushed shots stayed dark and the histogram bulk sat too low. The ×0.6 was a
  // workaround for the old clipping curve; the asymptotic curve no longer needs it.
  // Applied per-channel so channels recover independently for highlight detail.
  float E = uExposure;
  lin.r = applyExposure(lin.r, E);
  lin.g = applyExposure(lin.g, E);
  lin.b = applyExposure(lin.b, E);
  
  float H = clamp(uHighlights / 100.0, -1.0, 1.0);
  float S = clamp(uShadows / 100.0, -1.0, 1.0);
  if (abs(H) > 0.001) {
    lin = applyHighlightsRGB(lin, H);
  }
  if (abs(S) > 0.001) lin = applyShadowsRGB(lin, S);
  
  vec3 disp = linearToSrgbU(lin); // per-channel, may exceed 1.0

  // Contrast: S-curve applied per-channel, which naturally pushes
  // channel differences apart and increases perceived saturation with positive contrast.
  // f(x) = x + k·x·(1-x)·(2x-1) — passes through (0,0), (0.5,0.5), (1,1).
  // Monotonic for |k| < 1; applied to the vec3 so all three channels shift independently.
  float ck = (uContrast / 100.0) * 0.8;
  vec3 afterContrast = abs(ck) > 0.001
    ? clamp(disp + ck * disp * (1.0 - disp) * (2.0 * disp - 1.0), 0.0, 1.0)
    : disp;

  // Whites / Blacks — applied per-channel with broad per-pixel weights
  vec3 c = clamp(vec3(
    applyWhites(afterContrast.r, uWhites),
    applyWhites(afterContrast.g, uWhites),
    applyWhites(afterContrast.b, uWhites)
  ), 0.0, 1.0);
  c = clamp(vec3(
    applyBlacks(c.r, uBlacks),
    applyBlacks(c.g, uBlacks),
    applyBlacks(c.b, uBlacks)
  ), 0.0, 1.0);

  c = applyToneCurve(c);
  c = applyHSL(c);

  // Dehaze: clear the veil with broad local contrast, then a little contrast/color.
  if (abs(dehAmt) > 0.001) {
    c += broadDetail * dehAmt * 1.0;
    c = (c - 0.45) * (1.0 + dehAmt * 0.25) + 0.45;
    float dl = luma(c);
    c = mix(vec3(dl), c, 1.0 + dehAmt * 0.5);
  }
  // Clarity: broad local contrast, eased away from the deepest shadows/brightest
  // highlights. Texture: fine local contrast across the whole range.
  float midMask = 1.0 - pow(clamp(abs(luma(c) - 0.5) * 1.6, 0.0, 1.0), 3.0);
  c += broadDetail * clarAmt * 1.3 * midMask;
  c += texDetail * texAmt * 1.8;

  // Capture sharpening with radius, detail (halo control), and edge masking.
  float sharpen = uSharpening / 100.0;
  if (sharpen > 0.001) {
    // Radius (1..3) -> LOD (0.5..1.5): larger radius = coarser unsharp kernel
    float lod = mix(0.5, 1.5, (uSharpenRadius - 1.0) / 2.0);
    float blur = lumaLod(srcUv, lod);
    float detail = rawLuma - blur;
    // Detail (0-100): lower suppresses halos by blending with a broader USM
    float detailFactor = uSharpenDetail / 100.0;
    float broadBlur = lumaLod(srcUv, lod + 1.0);
    detail = mix((rawLuma - broadBlur) * 0.35, detail, detailFactor);
    // Masking (0-100): 0 = sharpen everywhere; 100 = edges only
    float mask = 1.0;
    if (uSharpenMasking > 0.001) {
      float edgeMag = abs(rawLuma - lumaLod(srcUv, 0.5));
      float threshold = (uSharpenMasking / 100.0) * 0.12;
      mask = smoothstep(threshold * 0.4, threshold, edgeMag);
    }
    c += detail * sharpen * 1.6 * mask;
  }

  c = applyVibSat(c, uVibrance, uSaturation);
  c = applyColorGrading(c);
  c = applyDefringe(c, uLensDefringe);

  // Fallback previews have limited dynamic range - clamp final output
  // since there's no true sensor headroom above 1.0
  if (uIsFallbackPreview) {
    c = clamp(c, 0.0, 1.0);
  }

  // Local adjustment masks (after global tone, in display space).
  for (int mi = 0; mi < MAX_MASKS; mi++) {
    if (mi >= uMaskCount) break;
    float mcov = maskCoverage(mi, srcUv);
    if (mcov <= 0.0) continue;
    c = applyMaskAdj(c, uMaskAdj0[mi], uMaskAdj1[mi], uMaskAdj2[mi].x, mcov, srcUv);
  }

  // Creative effects: vignette then grain (applied in display/output space)
  c = applyVignette(c, vUv);
  c = applyGrain(c, vUv);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
