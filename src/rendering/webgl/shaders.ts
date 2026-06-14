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
uniform bool uApplyBaseCurve; // true: full-res RAW float decode -- add the default camera
                              // tone curve the already-rendered preview/export bitmaps carry

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


// Local adjustment masks. Each mask is a GROUP of components combined
// (add = union, subtract = intersect-with-complement). Per-mask data is keyed by
// mask index; component geometry lives in a flat per-component list.
#define MAX_MASKS 8
#define MAX_COMPONENTS 16
uniform int uMaskCount;
uniform sampler2D uMaskTex;        // RGBA brush coverage atlas
uniform int uMaskInvert[MAX_MASKS];    // invert the whole combined coverage
uniform float uMaskOpacity[MAX_MASKS]; // 0..1
// Flat component list.
uniform int uCompCount;
uniform int uCompMaskIdx[MAX_COMPONENTS]; // parent mask index
uniform int uCompMode[MAX_COMPONENTS];    // 0 add (max), 1 subtract (*(1-c))
uniform int uCompType[MAX_COMPONENTS];    // 0 linear,1 radial,2 brush
uniform int uCompInvert[MAX_COMPONENTS];
uniform int uCompBrushCh[MAX_COMPONENTS]; // channel 0..3 in uMaskTex
uniform vec4 uCompGeoA[MAX_COMPONENTS];   // lin:x0,y0,x1,y1 | rad:cx,cy,rx,ry
uniform vec4 uCompGeoB[MAX_COMPONENTS];   // rad:feather,angle,_,_
uniform vec4 uMaskAdj0[MAX_MASKS]; // exposure, contrast, highlights, shadows
uniform vec4 uMaskAdj1[MAX_MASKS]; // saturation, temperature, tint, clarity
uniform vec4 uMaskAdj2[MAX_MASKS]; // sharpness, _, _, _
// Optional per-mask sub-panels: 8-band HSL (packed 6 vec4s per mask:
// hue0-3, hue4-7, sat0-3, sat4-7, lum0-3, lum4-7) and an RGB tone-curve LUT
// atlas (256 x MAX_MASKS; row mi at v=(mi+0.5)/MAX_MASKS).
uniform int uMaskHasHsl[MAX_MASKS];
uniform vec4 uMaskHsl[MAX_MASKS * 6];
uniform int uMaskHasCurve[MAX_MASKS];
uniform sampler2D uMaskCurves;

// Retouch (spot removal): heal discs.
#define MAX_SPOTS 16
uniform int uSpotCount;
uniform vec4 uSpotA[MAX_SPOTS]; // dstX, dstY, srcX, srcY
uniform vec4 uSpotB[MAX_SPOTS]; // radius(height units), feather(0..1), opacity(0..1), _reserved
uniform vec4 uSpotC[MAX_SPOTS];    // cosA, sinA, 1/scale, _  (source rotate/scale)
uniform vec4 uSpotTint[MAX_SPOTS]; // recolour offset rgb (encoded 0..1), _

// Brush-shaped retouch: painted coverage atlas + per-item source offset.
#define MAX_RBRUSH 4
uniform sampler2D uRetouchTex;
uniform int uRetouchCount;
uniform int uRetouchCh[MAX_RBRUSH];     // channel 0..3 in uRetouchTex
uniform vec4 uRetouchData[MAX_RBRUSH];  // offX, offY (UV), opacity(0..1), _reserved
uniform float uRetouchRadius[MAX_RBRUSH]; // image-height units, for heal LOD
uniform sampler2D uDevelopedSrc; // pass-1 developed image, source-UV space
uniform bool uHaveDeveloped;     // true on the compositing pass (match in edited space)
uniform bool uApplyRetouch;      // false while rendering the developed pass
uniform sampler2D uHealFill;     // precomputed content-aware fill, source-UV space
uniform bool uHaveHealFill;      // true when the fill texture is valid
// Pass 1 of the heal/clone pipeline: output ONLY the retouched source (no tone
// edits) into an offscreen copy. Pass 2 then develops from that copy, so every
// blur/sharpen tap sees the spot already removed instead of the original
// blemish (which otherwise drives the unsharp masks negative and inverts it).
uniform bool uPatchPass;

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

// Pluggable display transform (Pixel Peeper): scene-linear HDR -> display-encoded.
// Replaced via buildFragmentShader() when a non-default pipeline is active.
//__PIPELINE_GLSL__

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

// Exposure as a TRUE linear gain: ×2 per stop, exactly like a camera sensor and
// Lightroom. Midtones brighten linearly so tonal separation/contrast is kept, and
// the brightest values roll past 1.0 into HDR headroom — carried (unclamped) into
// the highlight-recovery stage and clipped to white on display unless Highlights
// pulls them back, which is how LR blows a +5 sky to white then recovers it.
//
// The previous asymptotic curve  g·i/(1+(g−β)i)  asymptoted to ~1.0 and never
// actually clipped: at +5 it crushed the whole scene range (linear 0.05→1.0) into
// the thin band sRGB 0.81–0.99. Nothing clipped like LR, and with no separation
// left the highlights/upper-mids went flat/milky as soon as Highlights pulled on
// them. Identity at E=0; negative E is the same plain gain as before.
float applyExposure(float i_in, float E) {
  return i_in * exp2(E);
}

// Highlights recovery (H < 0): saturating shoulder on LUMINANCE with a sliding
// knee. knee = 1.0 at H=0 (no-op), slides to 0.30 at H=-1 (aggressive recovery).
// [knee, inf) is compressed into [knee, 1) — blown values resolve near white with
// ordering/separation preserved (LR behaviour). Applied via luma-ratio so hue and
// per-channel saturation are preserved (no per-channel graying/desaturation).
//
// Highlights lift (H > 0): luminance-ratio applied to preserve hue.
// Additive bell on luminance; ratio scales all channels identically → no hue shift.
//
// Shadows (S): gamma toe on linear luminance, ratio-scaled (hue preserved). Strength
// falls off as exp(-λ·t) over display luma t so shadows lift most, mids/highlights
// still stretch with exponentially decreasing weight — no hard shadow/mid cutoff.

// Exponential shadow weight: w = exp(-λ·t), t = display luma in [0,1]. Black gets
// full strength; mids and highlights still move, with weight decreasing exponentially.
// t is the SCENE (pre-exposure) display luma so a global exposure push does not
// reclassify which pixels count as shadows.
float shadowWeight(float t) {
  return exp(-2.75 * t);
}

// Exponential highlight weight: w = exp(-λ·(1-t)), t = display luma in [0,1]. White gets
// full strength; mids and shadows still move, with weight decreasing exponentially.
// t is the SCENE (pre-exposure) display luma (see shadowWeight).
float highlightWeight(float t) {
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

// Ratio-scale a color from luma L to a target newL: hue and per-channel saturation
// preserving. Visible-saturation compensation is NOT done here — it is applied once
// at the end of the tone chain in display space (see main), so each stage's tonal
// mapping (e.g. highlight recovery) stays clean and never overshoots into false color.
const float SAT_COMP = 0.4; // strength of the end-of-chain visible-saturation comp
const float HI_SAT  = 0.55; // saturation lift inside highlight recovery (offsets pull-down)
const float HI_DETAIL = 1.5; // local contrast restored to recovered highlights (cloud detail)
vec3 retargetLuma(vec3 c, float L, float newL) {
  return c * (newL / L);
}

// Highlights applied to linear RGB. H in [-1, 1] (uHighlights / 100).
// refT is the SCENE (pre-exposure) display luma used to pick the highlight band,
// so exposure-lifted midtones are not treated as highlights and pulled to grey.
vec3 applyHighlightsRGB(vec3 c, float H, float refT) {
  if (H < 0.0) {
    // Recovery as a strictly MONOTONIC highlight rolloff on luminance: slope 1 at the
    // knee, sub-linear above, and it only ever darkens — so brighter input ALWAYS maps
    // to brighter output. No tonal inversion means no bright ring/halo along the
    // high-contrast tree↔sky edges. (The previous brightness-gated 'over' term was
    // non-monotonic: sky just under the clip point recovered less than sky just over
    // it, leaving a halo hugging the tree line, which default sharpening then amplified.)
    // Keyed to luminance like Lightroom, so it separates the bright sky from darker
    // foliage on its own; applied via luma-ratio so hue/saturation are preserved.
    float amt = -H;
    float L = max(luma(c), 1e-4);
    float knee = mix(1.0, 0.15, amt);     // recovery starts here; reaches down as amt rises
    float newL = L;
    if (L > knee) {
      // LR-style recovery: place the range above the knee EVENLY PER STOP
      // across the display band [knee, white] (log placement in display~sqrt
      // space). This pulls the recovered range DEEP — a +5EV sky lands around
      // 0.6..0.95 display with ~0.07/stop separation, instead of a shoulder
      // gluing everything to the bright end (slope-1-at-knee curves can never
      // pull the band down; that was the pale cream clouds).
      float kd = sqrt(knee);
      // White point: brightest scene value the current exposure can produce
      // (source clips at ~1.0 -> 2^E), plus ~half a stop of VIRTUAL headroom
      // (x1.5) so scene-white maps slightly below display-white at low E —
      // LR's -100 darkens bright skies even when nothing is actually blown.
      float Lmax = exp2(max(uExposure, 0.0)) * 1.5;
      float S = log2(max(Lmax / knee, 1.06)); // stops of range above the knee
      float s = log2(L / knee);               // this pixel's stops above knee
      float u = min(s / S, 1.0);
      // Convex placement (pow > 1): allot LESS display range to the stops just
      // above the knee and MORE to the top stops — LR sits recovered cloud
      // bodies deep (~0.6 display) while bright edges keep their separation.
      // 1.0 = even per-stop spacing; raise toward 2.0 for a deeper, contrastier
      // recovery; the cost is mild flattening right above the knee.
      const float HI_CONVEX = 1.5;
      float d = kd + (1.0 - kd) * pow(u, HI_CONVEX);
      newL = d * d;
    }
    c = retargetLuma(c, L, newL);
    // Restore the colourfulness that pulling bright values down costs (Hunt effect),
    // scaled by the PERCEIVED (display) darkening. min(L, 1.0): anything over 1.0
    // would have displayed as clipped white, so recovering it to ~0.95 is barely a
    // perceived pull and gets almost no boost. (The old linear ratio 1 - newL/L was
    // ~0.97 for blown sky -> chroma x1.4 on near-neutral clipped pixels, amplifying
    // demosaic chroma noise into pastel splotches.)
    float pulled = clamp(min(L, 1.0) - newL, 0.0, 1.0);
    float Lr = luma(c);
    c = mix(vec3(Lr), c, 1.0 + pulled * HI_SAT);
  } else {
    // Lift: gamma brightening of the highlight zone, ratio-scaled (hue-preserving).
    // Weighted by highlightWeight so different luminances shift by different amounts.
    float w = highlightWeight(refT);
    float blend = H * w;
    if (blend < 1e-5) return c;
    float L = max(luma(c), 1e-4);
    float gamma = mix(1.0, 0.4, H);
    float newL = mix(L, pow(L, gamma), blend);
    c = retargetLuma(c, L, newL);
  }
  return c;
}

// Shadows lift/crush on linear RGB. S in [-1, 1] (uShadows / 100).
// refT is the SCENE (pre-exposure) display luma used to pick the shadow band.
vec3 applyShadowsRGB(vec3 c, float S, float refT) {
  float L = max(luma(c), 1e-4);
  float w = shadowWeight(refT);
  float blend = abs(S) * w;
  if (blend < 1e-5) return c;

  float gamma = S > 0.0 ? mix(1.0, 0.55, abs(S)) : mix(1.0, 2.35, -S);
  float newL = mix(L, pow(L, gamma), blend);
  c = retargetLuma(c, L, newL);
  return c;
}

// Whites endpoint, display space. wh in [-100,100]; bidirectional.
// + brightens the bright end, - pulls it down. Luminance-targeted and
// ratio-scaled so it shifts tone WITHOUT changing hue/saturation.
// refT is the SCENE (pre-exposure) display luma used to pick the band, so an
// exposure push does not reclassify lifted midtones as whites.
vec3 applyWhitesRGB(vec3 c, float wh, float refT) {
  if (abs(wh) < 0.001) return c;
  float amt = wh / 100.0;
  float L = max(luma(c), 1e-4);
  float t = refT;
  float w = exp(-8.0 * (1.0 - t) * (1.0 - t)); // extreme highlights
  float blend = abs(amt) * w;
  if (blend < 1e-5) return c;
  float gamma = amt > 0.0 ? mix(1.0, 0.5, amt) : mix(1.0, 1.9, -amt);
  float newL = mix(L, pow(L, gamma), blend);
  return retargetLuma(c, L, newL);
}

// Blacks endpoint, display space. bl in [-100,100]; bidirectional.
// LIGHTROOM CONVENTION: + lifts/opens blacks (brighter dark end),
// - crushes/deepens them. The old curve did the opposite (and ignored the
// negative half) — that's the "Blacks is backwards" bug. Luminance-targeted
// and ratio-scaled so it does not pump saturation.
// refT is the SCENE (pre-exposure) display luma used to pick the band.
vec3 applyBlacksRGB(vec3 c, float bl, float refT) {
  if (abs(bl) < 0.001) return c;
  float amt = bl / 100.0;
  float L = max(luma(c), 1e-4);
  float t = refT;
  float w = exp(-8.0 * t * t); // extreme shadows
  float blend = abs(amt) * w;
  if (blend < 1e-5) return c;
  // + -> gamma < 1 (lift), - -> gamma > 1 (crush)
  float gamma = amt > 0.0 ? mix(1.0, 0.55, amt) : mix(1.0, 2.2, -amt);
  float newL = mix(L, pow(L, gamma), blend);
  return retargetLuma(c, L, newL);
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

// Smooth 2D value noise: hashes a lattice and bilinearly interpolates with a
// smoothstep fade. Unlike hash(floor(uv)) this has no hard square cells, so the
// grain reads as soft organic specks rather than blocky pixels.
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 applyGrain(vec3 c, vec2 uv) {
  if (uGrainAmount < 0.001) return c;
  float amount = uGrainAmount / 100.0 * 0.12; // max ~12% peak grain
  // Frequency: higher = finer grain. Much finer than the old 100..800 cells so
  // the grain isn't oversized; Size scales from fine (25) to coarse (100).
  // Aspect-corrected so specks stay round rather than stretched.
  float freq = mix(1600.0, 450.0, (uGrainSize - 25.0) / 75.0);
  vec2 guv = vec2(uv.x * uImageAspect, uv.y) * freq;
  // Base soft speck; Roughness folds in a finer second octave to break it up.
  float n = valueNoise(guv);
  float rough = uGrainRoughness / 100.0;
  if (rough > 0.001) {
    float n2 = valueNoise(guv * 2.07 + 17.3);
    n = mix(n, clamp(n + (n2 - 0.5) * 0.9, 0.0, 1.0), rough);
  }
  // Center the noise at 0 and scale. Luminance-weighted: less grain in shadows.
  float lumaW = clamp(luma(c) * 1.5 + 0.2, 0.2, 1.0);
  float grain = (n - 0.5) * 2.0 * amount * lumaW;
  return clamp(c + grain, 0.0, 1.0);
}


// ---- Retouch: spot heal / clone -------------------------------------------
// Heal keeps the source patch's fine detail but swaps its low-frequency content
// for the destination's, so the patch melds into its surroundings (skin, sky).
// The match is done at a blur scale that tracks the patch radius — a small spot
// matches a small neighbourhood, a large one a large neighbourhood — instead of
// an arbitrary fixed mip level, which is what makes the seam disappear. The
// correction is per-pixel (sampled at the current uv), so a tone gradient under
// the patch is followed rather than flattened.
// Sample the *edited* image (pass-1 develop) when available, else the source.
vec3 devSample(vec2 uv) {
  return uHaveDeveloped ? texture(uDevelopedSrc, uv).rgb : texture(uImage, uv).rgb;
}

float retouchCovAt(int ch, vec2 uv) {
  vec4 c = texture(uRetouchTex, uv);
  return ch == 0 ? c.r : (ch == 1 ? c.g : (ch == 2 ? c.b : c.a));
}


// Content-aware heal: instead of copying a source patch, ERASE the interior and
// reconstruct it from the ring of pixels surrounding the spot. Each interior
// pixel is a distance-weighted blend of the boundary just outside the disc — a
// cheap harmonic in-fill, so whatever was inside (blemish, branch, wire) is
// replaced by a smooth continuation of its surroundings.
vec3 inpaintCircle(vec2 ctr, float radius, vec2 uv) {
  vec2 q = vec2((uv.x - ctr.x) * uImageAspect, uv.y - ctr.y);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  const int N = 16;
  for (int k = 0; k < N; k++) {
    float a = (float(k) + 0.5) / float(N) * 6.2831853;
    vec2 e = vec2(cos(a), sin(a));                 // aspect-corrected direction
    vec2 bpos = e * radius;                         // boundary point (aspect space)
    vec2 buv = clamp(ctr + vec2(e.x / uImageAspect, e.y) * radius * 1.04, 0.0, 1.0);
    float dist = length(q - bpos) + 1e-3;
    float w = 1.0 / (dist * dist);                  // mean-value-style weighting
    acc += devSample(buv) * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-4);
}

// Same idea for a painted (brush) region: march outward from the pixel in a fan
// of directions until each ray leaves the painted coverage, then blend those
// boundary colours weighted toward the nearest edge.
vec3 inpaintBrush(int ch, vec2 uv, float radius) {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  float step = max(radius * 0.5, 0.003);
  const int DIRS = 12;
  for (int k = 0; k < DIRS; k++) {
    float a = (float(k) + 0.5) / float(DIRS) * 6.2831853;
    vec2 e = vec2(cos(a) / uImageAspect, sin(a));
    vec2 p = uv;
    float dist = 0.0;
    bool found = false;
    for (int s = 0; s < 20; s++) {
      p += e * step;
      dist += step;
      if (retouchCovAt(ch, p) < 0.4) { found = true; break; }
    }
    if (!found) continue;
    float w = 1.0 / (dist * dist);
    acc += devSample(clamp(p, 0.0, 1.0)) * w;
    wsum += w;
  }
  return wsum > 0.0 ? acc / wsum : devSample(uv);
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
    // Recolour toward the destination's surroundings so the seam disappears.
    vec3 srcCol = clamp(texture(uImage, sUv).rgb + uSpotTint[i].rgb, 0.0, 1.0);
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

// ---- Local adjustment masks ------------------------------------------------
// Coverage of one component (0..1), before add/subtract combine.
float compCoverage(int i, vec2 uv) {
  int type = uCompType[i];
  float m = 0.0;
  if (type == 0) {
    // Linear gradient: ramp 0->1 projected onto the drag direction.
    vec2 p0 = uCompGeoA[i].xy;
    vec2 p1 = uCompGeoA[i].zw;
    vec2 dir = p1 - p0;
    float len2 = max(dot(dir, dir), 1e-6);
    m = clamp(dot(uv - p0, dir) / len2, 0.0, 1.0);
  } else if (type == 1) {
    // Radial: 1 inside, feathered to 0 at the edge, in screen-proportional space.
    vec2 ctr = uCompGeoA[i].xy;
    vec2 rad = max(uCompGeoA[i].zw, vec2(1e-4));
    float feather = uCompGeoB[i].x;
    float ang = uCompGeoB[i].y;
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
    int ch = uCompBrushCh[i];
    m = ch == 0 ? cov.r : (ch == 1 ? cov.g : (ch == 2 ? cov.b : cov.a));
  }
  if (uCompInvert[i] == 1) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}

// Mask stage 1 — scene-referred linear, BEFORE the display conversion and
// tone curve. The tonal + WB mask controls run here with full HDR headroom,
// reusing the global sliders' machinery — so mask Highlights can un-clip a
// blown sky exactly like the global slider, and mask WB is true channel gains.
vec3 applyMaskLinear(vec3 c, vec4 a0, vec4 a1, float m, float refT) {
  vec3 r = c;
  // Exposure in true stops (±2.5 EV at the slider ends), hue-preserving.
  float ev = (a0.x / 100.0) * 2.5;
  if (abs(ev) > 1e-3) {
    float L = max(luma(r), 1e-4);
    r = retargetLuma(r, L, applyExposure(L, ev));
  }
  // Highlights / shadows: the global recovery/lift functions, scene-anchored.
  float H = clamp(a0.z / 100.0, -1.0, 1.0);
  if (abs(H) > 0.001) r = applyHighlightsRGB(r, H, refT);
  float S = clamp(a0.w / 100.0, -1.0, 1.0);
  if (abs(S) > 0.001) r = applyShadowsRGB(r, S, refT);
  // White balance as linear channel gains (the physically correct space; the
  // old display-space additive shifts greyed highlights and crushed hue).
  float temp = a1.y / 100.0;
  if (abs(temp) > 0.001) {
    r.r *= exp2(temp * 0.35);
    r.b *= exp2(-temp * 0.35);
  }
  float tnt = a1.z / 100.0;
  if (abs(tnt) > 0.001) {
    r.r *= exp2(tnt * 0.12);
    r.g *= exp2(-tnt * 0.20);
    r.b *= exp2(tnt * 0.12);
  }
  return mix(c, r, m);
}

// Mask stage 2 — display space, after the global tone curve. Contrast,
// saturation, and the detail taps were tuned for the 0..1 display range and
// stay here (matching LR, whose point curve and local contrast are
// display-referred).
vec3 applyMaskDisplay(vec3 c, vec4 a0, vec4 a1, float sharp, float m, vec2 uv) {
  vec3 r = c;
  // Contrast S-curve.
  float k = (a0.y / 100.0) * 0.7;
  r = clamp(r + k * r * (1.0 - r) * (2.0 * r - 1.0), 0.0, 1.0);
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

// Per-mask 8-band HSL mixer — same weighting as the global applyHSL, but the
// band values come from the packed uMaskHsl vec4s. Band weights are built into
// two vec4s so the accumulation is three dot() pairs instead of dynamic
// component indexing.
vec3 maskHsl(vec3 c, int mi) {
  vec3 hsl = rgb2hsl(c);
  float hueDeg = hsl.x * 360.0;
  vec4 wA, wB;
  for (int i = 0; i < 4; i++) {
    float dA = abs(mod(hueDeg - HSL_CENTERS[i] + 540.0, 360.0) - 180.0);
    float dB = abs(mod(hueDeg - HSL_CENTERS[i + 4] + 540.0, 360.0) - 180.0);
    wA[i] = max(0.0, 1.0 - dA / 35.0);
    wB[i] = max(0.0, 1.0 - dB / 35.0);
  }
  int b = mi * 6;
  float hueShift = dot(uMaskHsl[b], wA) + dot(uMaskHsl[b + 1], wB);
  float satMul = dot(uMaskHsl[b + 2], wA) + dot(uMaskHsl[b + 3], wB);
  float lumAdd = dot(uMaskHsl[b + 4], wA) + dot(uMaskHsl[b + 5], wB);
  hsl.x = fract(hsl.x + hueShift * (30.0 / 360.0));
  hsl.y = clamp(hsl.y * (1.0 + satMul), 0.0, 1.0);
  hsl.z = clamp(hsl.z + lumAdd * 0.4, 0.0, 1.0);
  return hsl2rgb(hsl);
}

// Per-mask RGB tone curve from the LUT atlas row, blended by coverage.
vec3 maskCurve(vec3 c, int mi, float m) {
  vec3 cs = clamp(c, 0.0, 1.0);
  float v = (float(mi) + 0.5) / float(MAX_MASKS);
  vec3 cc = vec3(
    texture(uMaskCurves, vec2(cs.r, v)).r,
    texture(uMaskCurves, vec2(cs.g, v)).g,
    texture(uMaskCurves, vec2(cs.b, v)).b);
  return mix(c, cc, m);
}

void main() {
  // Pass 1: bake the retouch into an offscreen copy of the source. We render in
  // the source's own texel space (the V-flip in vUv is undone here) so the
  // result is a drop-in replacement for uImage: sampling the copy at any
  // coordinate X yields applyRetouch(X, source(X)). Pass 2 binds this copy as
  // uImage and develops normally, so its blur/sharpen taps read the patched
  // pixels and no false detail is synthesised over the removed spot.
  if (uPatchPass) {
    vec2 c = vec2(vUv.x, 1.0 - vUv.y);
    vec3 raw = texture(uImage, c).rgb;
    raw = applyRetouch(c, raw);
    fragColor = vec4(raw, 1.0);
    return;
  }
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
  if (uApplyRetouch && (uSpotCount > 0 || uRetouchCount > 0)) src = applyRetouch(srcUv, src);
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

  // Default base tone curve. The full-res RAW float decode is scene-linear, so
  // its default render is flat compared with the preview/export/loupe views,
  // which inherit a camera-style contrast curve from their already-rendered
  // bitmaps. Re-create that curve here so all views match. Applied in display
  // space, then returned to linear so the downstream linear edits (WB, exposure,
  // highlight recovery) are unchanged; HDR highlights above 1.0 pass through
  // untouched so recovery still has headroom. Tune BASE_CONTRAST to taste.
  if (uApplyBaseCurve) {
    const float BASE_CONTRAST = 0.55; // 0 = flat (linear), 1 = full smoothstep S
    vec3 d  = linearToSrgbU(lin);            // display-space; may exceed 1.0
    vec3 dc = clamp(d, 0.0, 1.0);
    vec3 s  = dc * dc * (3.0 - 2.0 * dc);    // smoothstep S-curve, pivot 0.5
    vec3 c  = mix(dc, s, BASE_CONTRAST) + max(d - 1.0, 0.0);
    lin = srgbToLinear(c);
  }

  // Noise reduction, applied before exposure so it isn't amplified. Color NR
  // replaces chroma with a blurred (mip) version -- kills the rainbow speckle
  // that big exposure pushes reveal; Luminance NR eases luma toward the blur in
  // flat areas while protecting edges.
  float colorNR = uColorNR / 100.0;
  float lumNR = uLuminanceNR / 100.0;
  if (colorNR > 0.001 || lumNR > 0.001) {
    vec3 b = textureLod(uImage, srcUv, 2.0).rgb;
    vec3 blurLin = uLinear ? b : srgbToLinear(b);
    float lb = luma(blurLin);
    if (colorNR > 0.001) {
      // Color NR removes chroma SPECKLE while keeping luma and overall saturation.
      // Work in luma-normalized color (lin / luma): pulling that toward the local
      // average smooths color noise but leaves flat regions at their original
      // saturation, so the slider reduces chroma noise instead of desaturating.
      float colorLod = mix(4.0, 2.0, uColorNRDetail / 100.0);   // detail = less blur
      float colorSmMult = mix(0.4, 1.0, uColorNRSmooth / 100.0);
      vec3 bc = textureLod(uImage, srcUv, colorLod).rgb;
      vec3 blurC = uLinear ? bc : srgbToLinear(bc);
      float ls = max(luma(lin), 1e-4);
      float lbc = max(luma(blurC), 1e-4);
      vec3 ratioCur = lin / ls;      // this pixel's color direction
      vec3 ratioBlur = blurC / lbc;  // local-average color direction
      float blend = clamp(colorNR * colorSmMult, 0.0, 1.0);
      lin = mix(ratioCur, ratioBlur, blend) * ls; // keep luma, smooth chroma only
    }
    if (lumNR > 0.001) {
      // Luminance NR changes only the LUMA, leaving chroma/saturation intact, by
      // ratio-scaling toward the local-average luma. (An additive luma shift, the
      // old approach, desaturates in linear light — the "luminance changes chroma"
      // bug.) Edge-protected so texture survives.
      float edgeThresh = mix(0.14, 0.03, uLumNRDetail / 100.0);
      float contrastBias = mix(0.0, 0.05, uLumNRContrast / 100.0);
      float ls = max(luma(lin), 1e-4);
      float edge = abs(ls - lb);
      float w = lumNR * (1.0 - smoothstep(max(edgeThresh - contrastBias, 0.0), edgeThresh, edge));
      float targetL = mix(ls, lb, w);
      lin *= targetL / ls;
    }
  }

  lin = applyWhiteBalance(lin, uTemperature, uTint);

  // Scene tonal zone, captured BEFORE exposure. Highlights/Shadows classify pixels
  // by where they sat in the original scene, so a global exposure push (e.g. +5) does
  // not reclassify lifted midtones as highlights and let Highlights -100 drag them to grey.
  float refT = clamp(luma(linearToSrgbU(max(lin, vec3(0.0)))), 0.0, 1.0);

  // Exposure in true stops: the slider is an EV value, so +1 doubles the linear
  // signal (×2), matching Lightroom. A true linear gain (see applyExposure) keeps
  // midtone separation and lets the brightest values run past 1.0 into HDR headroom,
  // which is carried unclamped into highlight recovery below and only resolves to
  // display at the end. Ratio-scaled on luma so hue/saturation are preserved (for a
  // constant gain this is just a per-channel ×2^E).
  float E = uExposure;
  {
    float L = max(luma(lin), 1e-4);
    float newL = applyExposure(L, E);
    lin = retargetLuma(lin, L, newL);
  }
  
  float H = clamp(uHighlights / 100.0, -1.0, 1.0);
  float S = clamp(uShadows / 100.0, -1.0, 1.0);
  if (abs(H) > 0.001) {
    lin = applyHighlightsRGB(lin, H, refT);
  }
  if (abs(S) > 0.001) lin = applyShadowsRGB(lin, S, refT);

  // Local adjustment masks, stage 1: tonal + WB controls in scene-referred
  // linear with HDR headroom intact (Lightroom-style — this is what lets a
  // mask's Highlights/Exposure recover data the display stage can't see).
  //
  // First combine each mask's components into one coverage value: ADD unions
  // (max), SUBTRACT carves away (×(1−c)), in list order. Then whole-mask invert
  // and opacity. Coverage is reused by stage 2 below.
  float mcovs[MAX_MASKS];
  for (int mi = 0; mi < MAX_MASKS; mi++) mcovs[mi] = 0.0;
  for (int ci = 0; ci < MAX_COMPONENTS; ci++) {
    if (ci >= uCompCount) break;
    int p = uCompMaskIdx[ci];
    float cc = compCoverage(ci, srcUv);
    if (uCompMode[ci] == 0) mcovs[p] = max(mcovs[p], cc);
    else mcovs[p] = mcovs[p] * (1.0 - cc);
  }
  for (int mi = 0; mi < MAX_MASKS; mi++) {
    if (mi >= uMaskCount) break;
    float mm = mcovs[mi];
    if (uMaskInvert[mi] == 1) mm = 1.0 - mm;
    mcovs[mi] = clamp(mm * uMaskOpacity[mi], 0.0, 1.0);
  }
  for (int mi = 0; mi < MAX_MASKS; mi++) {
    if (mi >= uMaskCount) break;
    if (mcovs[mi] <= 0.0) continue;
    lin = applyMaskLinear(lin, uMaskAdj0[mi], uMaskAdj1[mi], mcovs[mi], refT);
  }

  vec3 disp = pipelineToDisplay(lin); // per-channel, may exceed 1.0 (built-in)

  // Contrast: S-curve applied per-channel, which naturally pushes
  // channel differences apart and increases perceived saturation with positive contrast.
  // f(x) = x + k·x·(1-x)·(2x-1) — passes through (0,0), (0.5,0.5), (1,1).
  // Monotonic for |k| < 1; applied to the vec3 so all three channels shift independently.
  float ck = (uContrast / 100.0) * 0.8;
  vec3 afterContrast = abs(ck) > 0.001
    ? clamp(disp + ck * disp * (1.0 - disp) * (2.0 * disp - 1.0), 0.0, 1.0)
    : disp;

  // Whites / Blacks — luminance-targeted, hue/saturation preserving, bidirectional,
  // and SCENE-anchored (refT) like exposure/highlights/shadows. Carried unclamped
  // so the highlight stages keep their HDR headroom; the final per-channel clip
  // (in applyToneCurve) resolves anything still over 1.0 to white, exactly like a
  // sensor / Lightroom — which is what lets a +5 blowout read as white and lets
  // Highlights -100 visibly un-clip it.
  vec3 c = applyWhitesRGB(afterContrast, uWhites, refT);
  c = applyBlacksRGB(c, uBlacks, refT);

  // Visible-saturation compensation (once, in display space). The tone controls hold
  // HSV saturation but darkening still reads as a loss of colorfulness, so where a
  // pixel ended up darker than its scene luma (refT) — i.e. any slider was lowered —
  // nudge chroma back up in proportion to that drop, keeping the image's visible
  // saturation steady. Brightening: no-op. Gamut-safe: the boost is capped so the
  // darkest channel cannot cross 0 (crossing 0 is what flipped hue / "inverted").
  {
    float Lc = luma(c);
    float drop = clamp(1.0 - Lc / max(refT, 1e-3), 0.0, 1.0);
    if (drop > 1e-4 && Lc > 1e-4) {
      float mn = min(min(c.r, c.g), c.b);
      float boost = drop * SAT_COMP;
      if (mn < Lc) boost = min(boost, mn / (Lc - mn)); // keep darkest channel >= 0
      c = mix(vec3(Lc), c, 1.0 + boost);
    }
  }

  c = applyToneCurve(c); // clamps per-channel to [0,1] — LR-style white clip
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

  // Highlight detail restore: the Highlights recovery compresses the bright band and
  // dulls cloud/texture micro-contrast. A luminance curve can't add it back without
  // also darkening lit foliage (sky and foliage overlap in luma after a big push), so
  // restore LOCAL contrast instead — only where the pixel ended up bright, scaled by
  // recovery strength (-H). Clamped to limit edge overshoot (anti-halo).
  if (H < -0.001) {
    float hiZone = smoothstep(0.45, 0.78, luma(c));
    float hiDet = clamp(rawLuma - lumaLod(srcUv, 2.0), -0.15, 0.15);
    c += hiDet * (-H) * hiZone * HI_DETAIL;
  }

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

  // Local adjustment masks, stage 2: contrast/saturation/detail plus the HSL
  // and tone-curve sub-panels, in display space (coverage from stage 1).
  for (int mi = 0; mi < MAX_MASKS; mi++) {
    if (mi >= uMaskCount) break;
    float mcov = mcovs[mi];
    if (mcov <= 0.0) continue;
    c = applyMaskDisplay(c, uMaskAdj0[mi], uMaskAdj1[mi], uMaskAdj2[mi].x, mcov, srcUv);
    if (uMaskHasHsl[mi] == 1)
      c = mix(c, maskHsl(clamp(c, 0.0, 1.0), mi), mcov);
    if (uMaskHasCurve[mi] == 1)
      c = maskCurve(c, mi, mcov);
  }

  // Creative effects: vignette then grain (applied in display/output space)
  c = applyVignette(c, vUv);
  c = applyGrain(c, vUv);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

// The stock Safelight transform: plain unclamped sRGB encode, preserving HDR
// headroom for the downstream highlight stages.
export const DEFAULT_PIPELINE_GLSL = `vec3 pipelineToDisplay(vec3 lin) { return linearToSrgbU(lin); }`;

/** Splice a pipeline's pipelineToDisplay definition into the develop shader.
 *  Pass null/undefined for the built-in transform. */
export function buildFragmentShader(pipelineGlsl?: string | null): string {
  return FRAGMENT_SHADER.replace(
    "//__PIPELINE_GLSL__",
    pipelineGlsl || DEFAULT_PIPELINE_GLSL,
  );
}
