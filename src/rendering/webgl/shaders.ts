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

uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTexture;
uniform float uClarity;
uniform float uDehaze;
uniform float uVibrance;
uniform float uSaturation;
uniform float uTemperature;
uniform float uTint;

uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];

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

// Map luminance through the Highlights / Shadows / Whites / Blacks controls as a
// single monotonic tone curve (Lightroom-like):
//   - Blacks / Whites shift the black & white points (a linear endpoint remap).
//   - Shadows / Highlights are gamma curves anchored at 0 and 1, so raising
//     Shadows *spreads* the dark tones (slope > 1 near black) and widens the
//     histogram instead of crushing everything toward mid-grey. The previous
//     additive offset mapped black straight to mid-grey, which is what collapsed
//     the histogram into a central spike.
float toneMapLuma(float l, float hi, float sh, float wh, float bl) {
  float bp = -(bl / 100.0) * 0.18;                  // bl<0 deepens the black point
  float wp = 1.0 - (max(wh, 0.0) / 100.0) * 0.18;   // wh>0 brightens the white point
  l = clamp((l - bp) / max(wp - bp, 1e-3), 0.0, 1.0);
  l = pow(l, exp2(-(sh / 100.0) * 0.9));            // shadows: lift & spread
  // Positive highlights brighten the top; negative (recovery) is handled by the
  // HDR rolloff before this, so only the positive side acts here.
  l = 1.0 - pow(1.0 - l, exp2(max(hi, 0.0) / 100.0 * 0.9));
  return clamp(l, 0.0, 1.0);
}

// Re-apply a new luminance to a color while preserving its hue & saturation
// (scale RGB; additive lift near black where there's no chroma and the divide
// would blow up). Contrast and Highlights/Shadows/Whites/Blacks all run through
// this, so none of them grey-out or desaturate the image.
vec3 recolorToLuma(vec3 c, float l0, float ln) {
  vec3 scaled = c * (ln / max(l0, 1e-3));
  vec3 added = c + (ln - l0);
  return mix(added, scaled, smoothstep(0.0, 0.08, l0));
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
float lumaLod(vec2 uv, float lod) {
  return luma(textureLod(uImage, uv, lod).rgb);
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

// Inverse map from output (crop) coord to source UV: see crop-transform.ts,
// which mirrors this exactly. vUv already has V flipped, so both are in
// top-left-origin image space. The geometry transform (straighten, perspective,
// stretch, scale, offset) is processed before — and independent of — the crop.
vec2 cropTransformUV(vec2 o) {
  vec2 p = uCrop.xy + o * uCrop.zw;
  vec3 q = uInvTransform * vec3(p, 1.0);
  return q.xy / q.z;
}

void main() {
  vec2 srcUv = cropTransformUV(vUv);
  // Content rotated out of frame by straighten reads as neutral dark, so corners
  // stay clean instead of smearing the edge texel.
  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    fragColor = vec4(0.04, 0.04, 0.04, 1.0);
    return;
  }
  vec3 c = texture(uImage, srcUv).rgb;
  float rawLuma = luma(c);

  // Local-contrast detail (unsharp masks), measured from the source: a fine
  // scale for Texture and a broad scale for Clarity/Dehaze. Skipped when unused.
  float texAmt = uTexture / 100.0;
  float clarAmt = uClarity / 100.0;
  float dehAmt = uDehaze / 100.0;
  float texDetail = abs(texAmt) > 0.001 ? rawLuma - lumaLod(srcUv, 2.0) : 0.0;
  float broadDetail =
    (abs(clarAmt) > 0.001 || abs(dehAmt) > 0.001)
      ? rawLuma - lumaLod(srcUv, 5.0)
      : 0.0;

  // White balance & exposure in linear light, kept HDR (no clamp) so highlights
  // survive past 1.0 into the recovery stage.
  vec3 lin = srgbToLinear(c);
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

  // Contrast + Shadows/Blacks (+ positive Highlights/Whites), on luminance, then
  // recolor so none of them desaturate.
  float l0 = luma(disp);
  float lc = clamp((l0 - 0.5) * (1.0 + uContrast / 100.0) + 0.5, 0.0, 1.0);
  float ln = toneMapLuma(lc, uHighlights, uShadows, uWhites, uBlacks);
  c = clamp(recolorToLuma(disp, l0, ln), 0.0, 1.0);

  c = applyToneCurve(c);
  c = applyHSL(c);

  // Scale the source-measured local contrast to the displayed brightness, so it
  // stays effective on lifted shadows / pulled highlights (not just bright pixels).
  float lcGain = clamp(luma(c) / max(rawLuma, 1e-3), 0.0, 6.0);

  // Dehaze: clear the veil with broad local contrast, then add contrast & color.
  if (abs(dehAmt) > 0.001) {
    c += broadDetail * lcGain * dehAmt * 1.5;
    c = (c - 0.45) * (1.0 + dehAmt * 0.35) + 0.45;
    float dl = luma(c);
    c = mix(vec3(dl), c, 1.0 + dehAmt * 0.6);
  }
  // Clarity: broad local contrast, eased away from the deepest shadows/brightest
  // highlights. Texture: fine local contrast across the whole range.
  float midMask = 1.0 - pow(clamp(abs(luma(c) - 0.5) * 1.6, 0.0, 1.0), 3.0);
  c += broadDetail * lcGain * clarAmt * 2.2 * midMask;
  c += texDetail * lcGain * texAmt * 3.2;

  c = applyVibSat(c, uVibrance, uSaturation);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
