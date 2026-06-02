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

// Single-pass develop shader. Operations run in a Lightroom-like order. Most
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

// White balance as a Kelvin temperature (warming the image as the value rises,
// like Lightroom) plus a green↔magenta tint. Gains are derived so 6500K is
// neutral, normalized on green to hold brightness.
vec3 applyWhiteBalance(vec3 c, float kelvin, float tint) {
  vec3 gain = blackbodyLinear(6500.0) / blackbodyLinear(kelvin);
  gain /= gain.g;
  gain.g *= 1.0 - (tint / 150.0) * 0.6; // +tint -> magenta, -tint -> green
  return c * gain;
}

// Tone-map one channel through Blacks/Shadows/Highlights/Whites using the same
// global gamma curves as the original implementation, now applied per-channel
// (R, G, B independently) rather than to scalar luminance + recolor. Per-channel
// application lets shadow lifts preserve natural colour, and lets each blown
// channel recover independently for proper highlight detail.
// Negative Highlights is handled upstream by the per-channel HDR shoulder rolloff;
// only positive hi acts here (matching the rolloff's complementary design).
float toneMapChannel(float v, float hi, float sh, float wh, float bl) {
  float bp = -(bl / 100.0) * 0.18;
  float wp = 1.0 - (max(wh, 0.0) / 100.0) * 0.18;
  v = clamp((v - bp) / max(wp - bp, 1e-3), 0.0, 1.0);
  v = pow(max(v, 1e-6), exp2(-(sh / 100.0) * 0.9));
  v = 1.0 - pow(max(1.0 - v, 1e-6), exp2(max(hi, 0.0) / 100.0 * 0.9));
  return clamp(v, 0.0, 1.0);
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

// Post-crop creative vignette (Lightroom Post-Crop Vignetting style).
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
  lin *= exp2(uExposure);
  vec3 disp = linearToSrgbU(lin); // per-channel, may exceed 1.0

  // Highlight/White recovery: fold the HDR overshoot back into range with a soft
  // per-channel shoulder. Driven by negative Highlights/Whites; at 0 it clips.
  float rec = max(
    clamp(-uHighlights / 100.0, 0.0, 1.0),
    clamp(-uWhites / 100.0, 0.0, 1.0) * 0.85
  );
  float knee = mix(1.0, 0.5, rec);
  disp = vec3(rollHi(disp.r, knee), rollHi(disp.g, knee), rollHi(disp.b, knee));

  // Contrast: S-curve applied per-channel (like Lightroom), which naturally pushes
  // channel differences apart and increases perceived saturation with positive contrast.
  // f(x) = x + k·x·(1-x)·(2x-1) — passes through (0,0), (0.5,0.5), (1,1).
  // Monotonic for |k| < 1; applied to the vec3 so all three channels shift independently.
  float ck = (uContrast / 100.0) * 0.8;
  vec3 afterContrast = abs(ck) > 0.001
    ? clamp(disp + ck * disp * (1.0 - disp) * (2.0 * disp - 1.0), 0.0, 1.0)
    : disp;

  // Shadows / Highlights / Whites / Blacks — applied per-channel so each channel
  // recovers independently (critical for highlight detail) and shadow lifts
  // preserve natural colour rather than graying out.
  vec3 c = clamp(vec3(
    toneMapChannel(afterContrast.r, uHighlights, uShadows, uWhites, uBlacks),
    toneMapChannel(afterContrast.g, uHighlights, uShadows, uWhites, uBlacks),
    toneMapChannel(afterContrast.b, uHighlights, uShadows, uWhites, uBlacks)
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

  // Creative effects: vignette then grain (applied in display/output space)
  c = applyVignette(c, vUv);
  c = applyGrain(c, vUv);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
