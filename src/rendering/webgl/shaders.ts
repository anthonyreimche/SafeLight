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

uniform vec4 uCrop;         // x, y, width, height (image space, y-down)
uniform float uStraighten;  // radians
uniform float uImageAspect; // image width / height

uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uClarity;
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

vec3 applyWhiteBalance(vec3 c, float temp, float tint) {
  float t = temp / 100.0;
  float ti = tint / 100.0;
  c.r *= 1.0 + 0.25 * t;
  c.b *= 1.0 - 0.25 * t;
  c.g *= 1.0 - 0.12 * ti;
  c.r *= 1.0 + 0.06 * ti;
  c.b *= 1.0 + 0.06 * ti;
  return c;
}

vec3 applyTonal(vec3 c, float hi, float sh, float wh, float bl) {
  float l = luma(c);
  float shMask = pow(1.0 - smoothstep(0.0, 0.6, l), 2.0);
  float hiMask = pow(smoothstep(0.4, 1.0, l), 2.0);
  float blMask = 1.0 - smoothstep(0.0, 0.4, l);
  float whMask = smoothstep(0.6, 1.0, l);
  c += (sh / 100.0) * 0.5 * shMask;
  c += (hi / 100.0) * 0.5 * hiMask;
  c += (bl / 100.0) * 0.35 * blMask;
  c += (wh / 100.0) * 0.35 * whMask;
  return c;
}

vec3 applyToneCurve(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  c.r = texture(uCurve, vec2(c.r, 0.5)).r;
  c.g = texture(uCurve, vec2(c.g, 0.5)).r;
  c.b = texture(uCurve, vec2(c.b, 0.5)).r;
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

vec3 applyClarity(vec3 c, float amt) {
  float l = luma(c);
  float midMask = 1.0 - pow(clamp(abs(l - 0.5) * 2.0, 0.0, 1.0), 2.0);
  float f = (amt / 100.0) * 0.4 * midMask;
  return (c - 0.5) * (1.0 + f) + 0.5;
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
// which mirrors this exactly and is unit-tested. vUv already has V flipped, so
// both are in top-left-origin image space.
vec2 cropStraightenUV(vec2 o) {
  vec2 cropSize = uCrop.zw;
  vec2 cropCenter = uCrop.xy + cropSize * 0.5;
  vec2 local = (o - 0.5) * cropSize;
  float cs = cos(uStraighten);
  float sn = sin(uStraighten);
  float sx = local.x * uImageAspect;
  float sy = local.y;
  float rx = sx * cs - sy * sn;
  float ry = sx * sn + sy * cs;
  return cropCenter + vec2(rx / uImageAspect, ry);
}

void main() {
  vec2 srcUv = cropStraightenUV(vUv);
  // Content rotated out of frame by straighten reads as neutral dark, so corners
  // stay clean instead of smearing the edge texel.
  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    fragColor = vec4(0.04, 0.04, 0.04, 1.0);
    return;
  }
  vec3 c = texture(uImage, srcUv).rgb;

  // White balance & exposure in linear light.
  vec3 lin = srgbToLinear(c);
  lin = applyWhiteBalance(lin, uTemperature, uTint);
  lin *= exp2(uExposure);
  c = linearToSrgb(lin);

  // Tonal adjustments in display space.
  c = (c - 0.5) * (1.0 + uContrast / 100.0) + 0.5;
  c = applyTonal(c, uHighlights, uShadows, uWhites, uBlacks);
  c = clamp(c, 0.0, 1.0);
  c = applyToneCurve(c);
  c = applyHSL(c);
  c = applyClarity(c, uClarity);
  c = applyVibSat(c, uVibrance, uSaturation);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;
