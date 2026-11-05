// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import {
  CURRENT_PROCESS_VERSION,
  normalizeProcessVersion,
} from "@/catalog/types";

import { BASELINE_REFIT_GLSL, BASELINE_TONE_GLSL } from "../baseline-tone";
import { LOCAL_TONE_GLSL } from "../local-tone";
import { OUTPUT_MAP_GLSL } from "../output-map";
import { STAGE_SPACE_GLSL } from "../stage-space";
import type { StageAnchor } from "@/extensions/types";
import { STAGE_ANCHORS, anchorMarker } from "./stage-anchors";

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

export type ProcessVersion = 1 | 2 | 3;

/** What a photo's process version changes in the develop shader. */
export interface ShaderVariant {
  readonly version: ProcessVersion;
  /** Version 2 and later: nothing clips between the display transform and the
   *  output encode unless a tool that needs [0, 1] is in use (the fallback
   *  preview's clamp clips too), and the built-in transform keeps colours
   *  outside sRGB as signed values. */
  readonly fullInfo: boolean;
  /** Version 3 and later: the signed colour reaches the output stage, which
   *  gamut-maps it into the target (slOutput, output-map.ts). Tools that need
   *  [0, 1] still clamp their own input while in use. */
  readonly signedOutput: boolean;
}

const VARIANTS: Readonly<Record<ProcessVersion, ShaderVariant>> = {
  1: { version: 1, fullInfo: false, signedOutput: false },
  2: { version: 2, fullInfo: true, signedOutput: false },
  3: { version: 3, fullInfo: true, signedOutput: true },
};
export const V1_VARIANT = VARIANTS[1];
export const V2_VARIANT = VARIANTS[2];
export const V3_VARIANT = VARIANTS[3];

/** The program a stored process version renders with. Anything that isn't a
 *  valid version predates them and renders as version 1; a version newer
 *  than `newest` renders as `newest`, the newest this build lets a photo use. */
export function shaderVariantFor(
  processVersion: unknown,
  newest: ProcessVersion = CURRENT_PROCESS_VERSION,
): ShaderVariant {
  return VARIANTS[Math.min(normalizeProcessVersion(processVersion), newest) as ProcessVersion];
}

export function variantKey(v: ShaderVariant): string {
  return `pv${v.version}`;
}

// Version 2 records what the core's default shoulder (the curve at Highlights
// 0) took off each pixel's luminance, so stages after the display transform can
// read the scene's headroom as slSceneLuma (contributions.md). The Highlights
// slider's own knee and lift stay in it, as do Shadows, Exposure and masks.
// It is taken before path-to-white, which is part of the shoulder's machinery
// and can move a bright pixel's luminance. Version 1's text is frozen and has
// neither.
const SCENE_LUMA_DECL = "\n  float slSceneLuma = max(luma(lin), 0.0) * slShoulderGain;";


/** The clipped sRGB encode. OUTPUT_MAP_GLSL's slEncodeOutput calls it, so a
 *  program that maps output outside this shader compiles it too. */
export const LINEAR_TO_SRGB_GLSL = `vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}`;

/** Where a probe-only program stops and hands back its working colour instead
 *  of the frame: "mask" at the scene-linear `lin` the mask components compare,
 *  "scene" at the `lin` the display transform receives. */
export type ProgramExit = "mask" | "scene";

// Single-pass develop shader, assembled per process version. Most stages are
// per-pixel point operations; clarity is a midtone-contrast approximation.
// `splits`: the program has reads-current exits (StageInjection.splitCount).
/** The template's per-version text. */
export function variantGuards(v: ShaderVariant) {
  // Version 2 GLSL is "" under version 1, which keeps the version 1 program
  // token-for-token the frozen shader (program-identity.test.tsx).
  const v2 = (glsl: string): string => (v.fullInfo ? glsl : "");
  const pick = (v1Glsl: string, v2Glsl: string): string => (v.fullInfo ? v2Glsl : v1Glsl);
  // Version 3 GLSL is "" under versions 1 and 2, the same way.
  const signed = (glsl: string): string => (v.signedOutput ? glsl : "");
  // Opens the block of a tool whose math needs [0, 1]: nothing upstream has
  // clipped its input on version 2.
  const clampInput = v2("\n    c = clamp(c, 0.0, 1.0);");
  return { v2, pick, signed, clampInput };
}

function fragmentShaderSource(v: ShaderVariant, splits = false, exit?: ProgramExit): string {
  const { v2, pick, signed } = variantGuards(v);
  // Likewise "" without splits, so such a program's text is unchanged.
  const split = (glsl: string): string => (splits ? glsl : "");
  // And "" without an exit. A split draw runs past it: a probe's frame can draw
  // a stage's input, which is cached for the live frames after it.
  const maskExit =
    exit === "mask" ? `\n  ${split("if (uSplitAt < 0) ")}{ fragColor = vec4(lin, 1.0); return; }` : "";
  // A scene measurement stops where the display transform takes `lin`, and
  // hands it over in the perceptual encoding every float frame is drawn in.
  const sceneExit =
    exit === "scene"
      ? `\n  ${split("if (uSplitAt < 0) ")}{ fragColor = vec4(slEncodePerceptual(lin), 1.0); return; }`
      : "";
  // Version 3 maps the signed colour into the target; earlier versions clip it.
  const output = v.signedOutput ? "slOutput(c)" : "encodeOutput(clamp(c, 0.0, 1.0))";
  // Nothing produces a fallback preview (load-image.ts declares the flag and
  // nothing sets it), so version 3 drops the clamp only one would reach, which
  // would clip its signed colour ahead of the output stage.
  const fallbackClamp = v.signedOutput
    ? ""
    : `
  // Fallback previews have limited dynamic range - clamp final output
  // since there's no true sensor headroom above 1.0
  if (uIsFallbackPreview) {
    c = clamp(c, 0.0, 1.0);
  }`;
  return `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;

// Output color space: 0 sRGB (no-op, live view), 1 Display-P3, 2 Adobe RGB,
// 3 ProPhoto. uOutMatrix is sRGB-linear -> target-linear; only used when != 0.
uniform int uOutSpace;
uniform mat3 uOutMatrix;${signed(`
uniform mat3 uOutToLms;
uniform mat3 uLmsToOut;
// Soft proof: map into the export's space first (proofUniforms, output-map.ts).
uniform bool uProof;
uniform bool uProofFits;    // the display holds the proof space whole
uniform mat3 uProofMatrix;  // sRGB-linear -> proof-linear
uniform mat3 uProofToLms;
uniform mat3 uLmsToProof;
uniform mat3 uProofToOut;   // proof-linear -> target-linear`)}

// Display-space colour painted where the sampled source falls outside the image
// (crop-mode margins, straighten/transform out-of-frame corners). Set to the
// canvas surround so the margin reads as the back canvas, not a black frame.
uniform vec3 uOutsideColor;
// Viewport window into the displayed (cropped) image: x, y, width, height in
// [0,1]. Default (0,0,1,1) renders the whole frame; a zoomed Develop view sets a
// sub-rect so the output canvas (sized to the screen) samples that region of the
// resident full-res source at 1:1 — crisp detail instead of CSS-upscaling a small
// buffer. Everything downstream derives from srcUv, so the window applies once.
uniform vec4 uViewport;
uniform bool uLinear;       // true: source texture is linear float (RAW); skip sRGB decode
uniform bool uIsFallbackPreview; // true: source is pseudo-linear from 8-bit JPEG preview
uniform bool uApplyBaseCurve; // true: scene-linear RAW source -- apply the default baseline
                              // (baselineTone); off for camera-rendered bitmaps and for
                              // display transforms that own their own baseline${v2(`
uniform float uBaselineGain;  // the camera maker's exposure offset as a gain, applied with
                              // slBaselineRefit (the camera baseline)
uniform float uBaselineShadows; // the camera match's shadows lift (Shadows / 100), on each
                                // pixel before the photo's own Shadows`)}
uniform bool uApplyToneShoulder; // true: the core filmic shoulder compresses highlights;
                                 // off for display transforms with their own roll-off
uniform bool uRawHistogram;   // true: output c as the display tools leave it (display-encoded,
                              // unclamped) for the extended histogram
uniform int uShowClipping;    // bitmask: bit 0 = shadow clipping, bit 1 = highlight clipping,
                              // bit 2 = gamut warning (version 3 only)

uniform float uLuminanceNR;
uniform bool uSkipCoreNR;        // true when an extension denoise stage is active
uniform float uLumNRDetail;      // 0..100
uniform float uLumNRContrast;    // 0..100
uniform float uLumNRShadows;     // 0..100
uniform float uLumNRHighlights;  // 0..100
uniform float uColorNR;
uniform float uColorNRDetail;    // 0..100
uniform float uColorNRSmooth;    // 0..100
uniform float uAsShotTemperature;
uniform float uClipThreshold;     // ~0.98, sensor white level for channel reconstruction


// Local adjustment masks. Each mask is a GROUP of components combined (add =
// union, subtract = carve, intersect = confine). Per-mask data is keyed by mask
// index; component geometry lives in a flat per-component list. Capacities are
// fixed by the fragment uniform budget. Masking's stage declares the uniforms,
// sized by these.
#define MAX_MASKS 16
#define MAX_COMPONENTS 24

//__CONTRIBUTED_UNIFORMS__

// Image aspect (width / height) — used so radial masks and round retouch discs
// stay circular on screen despite the non-square source-UV space.
uniform float uImageAspect;


// The brush coverage atlas: masks' brush components first, then the
// coverage-kind textures extension stages paint.
uniform sampler2D uMaskTex;        // RGBA brush coverage atlas
// Coverage visualization: when uVizMask >= 0, tint the output by that mask's
// combined coverage (pre-opacity) in uVizColor — the hover-to-see-coverage UX.
uniform int uVizMask;
uniform vec3 uVizColor;
uniform float uVizStrength; // overlay opacity (animated fade in/out)
// Sharpening / noise-reduction preview (Lightroom-style Alt/Ctrl-drag): when > 0
// the whole frame is replaced by a visualization of a sub-signal.
//   1 = masking (white = sharpened, black = protected/flat)
//   2 = detail (the high-frequency edge signal, on mid-grey)
//   3 = luminance (B&W of the sharpened result, to judge halos)
//   4 = color-NR chroma (luma flattened, chroma amplified over neutral grey)
uniform int uSharpenViz;
// True only when the built-in denoise prepass produced a valid (float, linear)
// result this frame. Gates the denoise stage's inline swap of lin so it never
// applies a raw/8-bit fallback texture (which would corrupt the image). Replaces
// the old uLinear gate, which wrongly disabled denoise for non-float sources.
uniform bool uDenoiseReady;

uniform sampler2D uDevelopedSrc; // pass-1 developed image, source-UV space
uniform bool uHaveDeveloped;     // true on the compositing pass (match in edited space)
uniform bool uApplyRetouch;      // false while rendering the developed pass
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

${LINEAR_TO_SRGB_GLSL}

// sRGB encode without the upper clamp, so exposure can carry highlights past 1.0
// (HDR) into the highlight-recovery stage instead of hard-clipping immediately.
vec3 linearToSrgbU(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
${BASELINE_TONE_GLSL}${v2(BASELINE_REFIT_GLSL)}
// Convert the final sRGB-encoded display pixel into the selected output color
// space: decode to linear sRGB primaries, rotate primaries with uOutMatrix, then
// re-encode with the target transfer function (must match the ICC TRC built in
// color-space.ts so the round-trip is lossless). No-op for sRGB (uOutSpace 0).
vec3 encodeOutput(vec3 srgb) {
  if (uOutSpace == 0) return srgb;
  vec3 lin = clamp(uOutMatrix * srgbToLinear(srgb), 0.0, 1.0);
  if (uOutSpace == 2) return pow(lin, vec3(1.0 / 2.19921875));        // Adobe RGB
  if (uOutSpace == 3)                                                  // ProPhoto (ROMM)
    return mix(lin * 16.0, pow(lin, vec3(1.0 / 1.8)), step(0.001953125, lin));
  return linearToSrgb(lin);                                           // Display-P3 (sRGB TRC)
}

// Pluggable display transform (Pixel Peeper): scene-linear HDR -> display-encoded.
// Replaced via buildFragmentShader() when a non-default pipeline is active.
//__PIPELINE_GLSL__${signed(`\n${OUTPUT_MAP_GLSL}`)}

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
// plus a green↔magenta tint. Gains are derived so asShotK (the camera's
// shooting WB, baked into the decoded pixels) is the neutral point.${v2(`
// Version 2 scales them so a grey keeps its luminance (blackbody.ts
// whiteBalanceGains); at the as-shot point luma(gain) is exactly 1.`)}
vec3 applyWhiteBalance(vec3 c, float kelvin, float tint, float asShotK) {
  vec3 gain = blackbodyLinear(asShotK) / blackbodyLinear(kelvin);
  gain /= gain.g;
  gain.g *= 1.0 - (tint / 150.0) * 0.6; // +tint -> magenta, -tint -> green${v2(`
  gain /= luma(gain);`)}
  return c * gain;
}

// Reconstruct clipped channels from unclipped ones. When 1 or 2 channels hit
// the sensor ceiling (>= clipThreshold), their true values are unknown. Estimate
// them from the ratio of unclipped channels in the local neighbourhood so the
// recovered pixel has correct colour rather than a clipped-channel colour cast.
//
// The mip-1 sample weighs this pixel by 0.75^2 / 4 (about 0.14), so with
// non-negative neighbours the local reference never falls below an eighth of
// the pixel's own source value. That bound holds before the baseline tone:
// own comes from lin, which has been through it, while localColor is the raw
// mip-1 sample. Colours outside the sRGB primaries put channels below
// black, and such neighbours can drag the reference to zero or past it; a
// reference that low says nothing about this pixel, so the pixel is left as
// decoded rather than rebuilt into a speck, a hole or the opposite hue.
bool hasLocalReference(float own, float local) {
  return own > 0.0 && local > max(1e-4, own * 0.125);
}

vec3 reconstructClipped(vec3 c, vec2 uv) {
  float clipT = uClipThreshold;
  if (clipT <= 0.0) return c;
  bool rClip = c.r >= clipT;
  bool gClip = c.g >= clipT;
  bool bClip = c.b >= clipT;
  int nClipped = int(rClip) + int(gClip) + int(bClip);
  if (nClipped == 0 || nClipped == 3) return c;
  vec3 localColor = textureLod(uImage, uv, 1.0).rgb;
  if (nClipped == 1) {
    float L = luma(c);
    float localL = luma(localColor);
    if (!hasLocalReference(L, localL)) return c;
    if (rClip) {
      c.r = L * (localColor.r / localL);
    } else if (gClip) {
      c.g = L * (localColor.g / localL);
    } else {
      c.b = L * (localColor.b / localL);
    }
  } else {
    float unclipped = !rClip ? c.r : !gClip ? c.g : c.b;
    float localUnclipped = !rClip ? localColor.r : !gClip ? localColor.g : localColor.b;
    if (!hasLocalReference(unclipped, localUnclipped)) return c;
    c = localColor * (unclipped / localUnclipped);
  }
  return c;
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
// knee. knee = 1.0 at H=0 (no-op), slides to 0.25 at H=-1 (aggressive recovery).
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

// Ratio-scale a color from luma L to a target newL: hue and per-channel saturation
// preserving. Visible-saturation compensation is NOT done here — it is applied once
// at the end of the tone chain in display space (see main), so each stage's tonal
// mapping (e.g. highlight recovery) stays clean and never overshoots into false color.
const float HI_SAT  = 0.55; // saturation lift inside highlight recovery (offsets pull-down)
const float BAND_DETAIL = 1.5; // micro-contrast restored/added per tonal band (highlight & shadow detail)
vec3 retargetLuma(vec3 c, float L, float newL) {
  return c * (newL / L);
}
${v2(LOCAL_TONE_GLSL)}

// Highlights applied to linear RGB. H in [-1, 1] (uHighlights / 100).
// refT is the SCENE (pre-exposure) display luma used to pick the highlight band,
// so exposure-lifted midtones are not treated as highlights and pulled to grey.
vec3 applyHighlightsRGB(vec3 c, float H, float refT) {
  if (H < 0.0) {
    // Recovery: saturating shoulder on luminance with a sliding knee.
    // Monotonic — brighter input always maps to brighter output, preventing
    // tonal inversion and the bright ring/halo at high-contrast edges.
    // Applied via luma-ratio so hue/saturation are preserved.
    float amt = -H;
    float L = max(luma(c), 1e-4);
    float knee = mix(1.0, 0.25, amt);
    float newL = L;
    if (L > knee) {
      float range = max(1.0 - knee, 1e-3);
      float excess = (L - knee) / range;
      float compressed = 1.0 - exp(-excess * (1.5 + amt));
      newL = knee + range * compressed;
    }
    // Without the core shoulder, values above white are the transform's
    // headroom: blend the recovery in with the slider, as the global one does,
    // instead of flattening them to white at the slightest pull.
    if (!uApplyToneShoulder) newL = mix(L, newL, amt);
    c = retargetLuma(c, L, newL);
    // Hunt effect: restore colourfulness lost by pulling bright values down.
    float pulled = clamp(min(L, 1.0) - newL, 0.0, 1.0);
    float Lr = luma(c);
    c = mix(vec3(Lr), c, 1.0 + pulled * HI_SAT);
  } else {
    // Lift: gamma brightening of the highlight zone, ratio-scaled (hue-preserving).
    float w = highlightWeight(refT);
    float blend = H * w;
    if (blend < 1e-5) return c;
    float L = max(luma(c), 1e-4);
    float gamma = mix(1.0, 0.4, H);
    float newL = mix(L, pow(L, gamma), blend);
    // The gamma lift darkens values above white; without the shoulder those
    // are the transform's headroom, so the lift may only brighten.
    if (!uApplyToneShoulder) newL = max(newL, L);
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

  float gamma = S > 0.0 ? mix(1.0, 0.65, abs(S)) : mix(1.0, 1.8, -S);
  float newL = mix(L, pow(L, gamma), blend);
  c = retargetLuma(c, L, newL);
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

// Circular gap (deg) from each band center to its previous / next neighbour.
// The centers are unevenly spaced, so the falloff width differs per side.
const float HSL_DPREV[8] = float[8](40.0, 30.0, 30.0, 60.0, 60.0, 60.0, 40.0, 40.0);
const float HSL_DNEXT[8] = float[8](30.0, 30.0, 60.0, 60.0, 60.0, 40.0, 40.0, 40.0);

// Hat weight for one band: 1 at its own center, 0 at distance dPrev/dNext * range
// to each side, with a tunable falloff in between. range scales the half-widths
// (1 = partition-of-unity tiling: weights sum to 1 across adjacent bands, seamless,
// and a pure band hue keeps full slider authority). smoothv blends the ramp from
// linear (0 = defined edges) to smoothstep (1). range=1, smoothv=1 reproduces the
// original smoothstep falloff exactly.
float hslBandWeight(float hueDeg, float center, float dPrev, float dNext, float range, float smoothv) {
  float d = mod(hueDeg - center + 540.0, 360.0) - 180.0; // signed -180..180
  float dp = dPrev * range;
  float dn = dNext * range;
  float t;
  if (d <= 0.0) {
    if (d <= -dp) return 0.0;
    t = (d + dp) / dp; // 0 at -dp, 1 at center
  } else {
    if (d >= dn) return 0.0;
    t = 1.0 - d / dn; // 1 at center, 0 at +dn
  }
  return mix(t, t * t * (3.0 - 2.0 * t), smoothv);
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
  c = clamp(c, 0.0, 1.0);
  float l = luma(c);
  if (abs(sat) > 0.1) {
    c = clamp(mix(vec3(l), c, 1.0 + sat / 100.0), 0.0, 1.0);
    l = luma(c);
  }
  if (abs(vib) < 0.1) return c;
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float curSat = clamp((mx - mn) / max(mx, 0.01), 0.0, 1.0);
  float satFactor = pow(1.0 - curSat, 2.5);
  float skinWeight = 0.0;
  if (mx > 0.02) {
    float d = mx - mn;
    float hue6 = 0.0;
    if (d > 0.001) {
      if (c.r >= c.g && c.r >= c.b) hue6 = mod((c.g - c.b) / d, 6.0);
      else if (c.g >= c.b) hue6 = (c.b - c.r) / d + 2.0;
      else hue6 = (c.r - c.g) / d + 4.0;
    }
    float hueNorm = hue6 / 6.0;
    skinWeight = smoothstep(0.22, 0.12, hueNorm) + smoothstep(0.88, 0.98, hueNorm);
    skinWeight = min(skinWeight, 1.0);
    skinWeight *= smoothstep(0.0, 0.15, curSat) * smoothstep(0.75, 0.5, curSat);
    skinWeight *= smoothstep(0.08, 0.2, l) * smoothstep(0.92, 0.75, l);
  }
  float vibAmt = (vib / 100.0) * satFactor * (1.0 - skinWeight * 0.8);
  l = luma(c);
  c = clamp(mix(vec3(l), c, 1.0 + vibAmt), 0.0, 1.0);
  return c;
}

//__CONTRIBUTED_HELPERS__

// ---- Local adjustment masks ------------------------------------------------
// Mask stage 1 — scene-referred linear, BEFORE the display conversion and
// tone curve. The tonal + WB mask controls run here with full HDR headroom, so
// mask Highlights can un-clip a blown sky and mask WB is true channel gains.
// Highlights/Shadows deliberately keep the LEGACY recovery curves
// (applyHighlightsRGB / applyShadowsRGB, a sliding-knee shoulder); the GLOBAL
// slider has since moved to the integrated filmic shoulder (see main). They are
// NOT kept in lockstep on purpose — changing the mask math would silently alter
// every existing mask edit, so the two recovery models are allowed to differ.
vec3 applyMaskLinear(vec3 c, vec4 a0, vec4 a1, float m, float refT) {
  vec3 r = c;
  // Exposure in true stops (±2.5 EV at the slider ends), hue-preserving.
  float ev = (a0.x / 100.0) * 2.5;
  if (abs(ev) > 1e-3) {
    float L = max(luma(r), 1e-4);
    r = retargetLuma(r, L, applyExposure(L, ev));
  }
  // Highlights / shadows: the legacy recovery/lift functions, anchored to the scene tone (refT).${v2(`
  // Version 2's Shadows is Basic's curve (slShadows) on the colour's luminance.`)}
  float H = clamp(a0.z / 100.0, -1.0, 1.0);
  if (abs(H) > 0.001) r = applyHighlightsRGB(r, H, refT);
  float S = clamp(a0.w / 100.0, -1.0, 1.0);
  if (abs(S) > 0.001) r = ${pick("applyShadowsRGB(r, S, refT)", "retargetLuma(r, max(luma(r), 1e-4), slShadows(luma(r), S))")};
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
  }${v2(`
  // Version 2 scales the gains so a grey keeps its luminance; 1 at 0.
  r /= luma(vec3(exp2(temp * 0.35 + tnt * 0.12), exp2(-tnt * 0.20), exp2(-temp * 0.35 + tnt * 0.12)));`)}
  return mix(c, r, m);
}

// Mask stage 2 — display space, after the global tone curve. Contrast,
// saturation, and the detail taps were tuned for the 0..1 display range and
// stay here (matching LR, whose point curve and local contrast are
// display-referred).
// a2 = (sharpness, whites, blacks, vibrance); a3 = (texture, dehaze, _, _).
// Whites/Blacks/Vibrance/Texture/Dehaze reuse the global display-stage formulas
// (shaders.ts main) so a masked slider matches its global counterpart exactly.
// The detail taps (clarity, sharpness, texture) measure the pixel against blurs
// of the source's luma, so the pixel's own value has to be the source's luma too.
// Version 2 gets it from main as rawLuma, the centre the global tools use. Version
// 1 took the luma of the edited colour, a different encoding (0.59 against 0.42 on
// a RAW mid-grey), so it read every flat area as detail.
vec3 applyMaskDisplay(vec3 c, vec4 a0, vec4 a1, vec4 a2, vec4 a3, float m, vec2 uv${v2(", float rawLuma")}) {
  vec3 r = c;
  // Whites: gamma endpoint cubic-weighted toward white (global lines ~1306).
  float wh = a2.y / 100.0;
  if (abs(wh) > 0.001) {
    float L = max(luma(r), 1e-4);
    float wW = L * L * L;
    float gamma = wh > 0.0 ? mix(1.0, 0.5, wh) : mix(1.0, 1.9, -wh);
    r = clamp(r * (mix(L, pow(L, gamma), wW) / L), 0.0, 1.0);
  }
  // Blacks: gamma endpoint cubic-weighted toward black (global lines ~1318).
  float bl = a2.z / 100.0;
  if (abs(bl) > 0.001) {
    float L = max(luma(r), 1e-4);
    float bW = (1.0 - L) * (1.0 - L) * (1.0 - L);
    float gamma = bl > 0.0 ? mix(1.0, 0.55, bl) : mix(1.0, 2.2, -bl);
    r = clamp(r * (mix(L, pow(L, gamma), bW) / L), 0.0, 1.0);
  }
  // Contrast S-curve.
  float k = (a0.y / 100.0) * 0.7;
  r = clamp(r + k * r * (1.0 - r) * (2.0 * r - 1.0), 0.0, 1.0);
  // Saturation.
  float Lr = luma(r);
  r = mix(vec3(Lr), r, 1.0 + a1.x / 100.0);
  // Vibrance: low-saturation/skin-protected boost (shared global helper).
  if (abs(a2.w) > 0.1) r = applyVibSat(r, a2.w, 0.0);
  // Dehaze: dark-channel-prior contrast/saturation restore (global lines ~1341).
  float deh = a3.y / 100.0;
  if (abs(deh) > 0.001) {
    vec3 localBlur = textureLod(uImage, uv, 4.0).rgb;
    if (!uLinear) localBlur = srgbToLinear(localBlur);
    localBlur = linearToSrgbU(localBlur);
    float dc = min(min(localBlur.r, localBlur.g), localBlur.b);
    vec3 globalBlur = textureLod(uImage, vec2(0.5, 0.5), 9.0).rgb;
    if (!uLinear) globalBlur = srgbToLinear(globalBlur);
    globalBlur = linearToSrgbU(globalBlur);
    float A = clamp(max(max(globalBlur.r, globalBlur.g), globalBlur.b), 0.5, 0.98);
    float t_est = clamp(1.0 - deh * 1.2 * dc / max(A, 0.5), 0.12, 1.0);
    r = (r - vec3(A) * (1.0 - t_est)) / max(t_est, 0.12);
    float dl = luma(r);
    r = clamp(mix(vec3(dl), r, 1.0 + deh * 0.4), 0.0, 1.0);
  }
  // Clarity (broad) and sharpness (fine) local contrast.
  float clar = a1.w / 100.0;
  float shp = a2.x / 100.0; // sharpness
  if (abs(clar) > 0.001 || abs(shp) > 0.001) {
    float base = ${pick("luma(r)", "rawLuma")};
    r += (base - lumaLod(uv, 4.0)) * clar * 1.2;
    // Sharpness: blend the fine detail (LOD 1.5) toward a broader tap (LOD 2.5)
    // the same way the global sharpen path does (shaders.ts ~1483). A raw fine
    // unsharp overshoots at bright edges and pushes highlights; the broad blend
    // tames that overshoot. Masks have no Detail slider, so use a fixed,
    // fine-biased blend that keeps most of the sharpening while cutting overshoot.
    float fine = base - lumaLod(uv, 1.5);
    float broad = (base - lumaLod(uv, 2.5)) * 0.35;
    r += mix(broad, fine, 0.65) * shp * 1.2;
  }
  // Texture: edge-aware micro-detail (LOD 0.75), suppressed at strong edges to
  // avoid halos (global lines ~1396).
  float texAmt = a3.x / 100.0;
  if (abs(texAmt) > 0.001) {
    float cen = ${pick("luma(r)", "rawLuma")};
    float texDetail = clamp(cen - lumaLod(uv, 0.75), -0.08, 0.08);
    float edgeStrength = abs(cen - lumaLod(uv, 2.5));
    float edgeMask = 1.0 - smoothstep(0.02, 0.12, edgeStrength);
    r += texDetail * texAmt * 2.5 * edgeMask;
  }
  r = clamp(r, 0.0, 1.0);
  return mix(c, r, m);
}

// Per-mask 8-band HSL mixer — shares the global applyHSL color science
// (partition-of-unity hat weights, neutral protection, hue-preserving luminance,
// perceptual saturation), but the band values come from the per-mask data
// texture, packed as two vec4s so the accumulation is three dot() pairs.
vec3 maskHsl(vec3 c, int mi) {
  vec3 hsl = rgb2hsl(c);
  // Protect near-neutral pixels (see applyHSL): grays report hue 0 = red.
  float chromaW = smoothstep(0.0, 0.10, hsl.y);
  if (chromaW < 1e-4) return c;
  float hueDeg = hsl.x * 360.0;
  vec4 wA, wB;
  for (int i = 0; i < 4; i++) {
    wA[i] = hslBandWeight(hueDeg, HSL_CENTERS[i],     HSL_DPREV[i],     HSL_DNEXT[i],     1.0, 1.0);
    wB[i] = hslBandWeight(hueDeg, HSL_CENTERS[i + 4], HSL_DPREV[i + 4], HSL_DNEXT[i + 4], 1.0, 1.0);
  }
  int b = mi * 6;
  float hueShift = (dot(uMaskHsl[b],     wA) + dot(uMaskHsl[b + 1], wB)) * chromaW;
  float satAdj   = (dot(uMaskHsl[b + 2], wA) + dot(uMaskHsl[b + 3], wB)) * chromaW;
  float lumAdj   = (dot(uMaskHsl[b + 4], wA) + dot(uMaskHsl[b + 5], wB)) * chromaW;

  hsl.x = fract(hsl.x + hueShift * (30.0 / 360.0));
  vec3 rgb = hsl2rgb(hsl);
  if (abs(satAdj) > 1e-4) {
    float Lp = luma(rgb);
    rgb = mix(vec3(Lp), rgb, clamp(1.0 + satAdj, 0.0, 2.0));
  }
  if (abs(lumAdj) > 1e-4) rgb *= 1.0 + lumAdj * 0.6;
  return clamp(rgb, 0.0, 1.0);
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
  // Apply the viewport window before the crop/transform map so the whole
  // pipeline (crop, geometry, lens, masks, retouch) stays anchored to the source.
  vec2 viewUv = uViewport.xy + vUv * uViewport.zw;
  //__ANCHOR_GEOMETRY__
  vec2 srcUv = cropTransformUV(viewUv);${split(`
  // A split draw renders one stage's input in source texels (the patch
  // pass's convention), so the stage's passes line up with uImage.
  if (uSplitAt >= 0) srcUv = vec2(vUv.x, 1.0 - vUv.y);`)}
  // Captured before contributed geometry stages warp srcUv, so radial
  // corrections (e.g. an extension's vignette) measure from the sensor centre.
  vec2 sensorUv = srcUv;
  // Contributed geometry stages (extension-owned): may displace the mutable
  // srcUv so the whole pipeline below resamples the warped position. Runs
  // before the bounds check, so content warped past the frame reads as the
  // outside colour rather than smearing an edge texel.
  ${split("if (uSplitAt < 0) {\n  ")}//__CONTRIBUTED_GEOMETRY__${split("\n  }")}
  // Content rotated out of frame by straighten reads as neutral dark, so corners
  // stay clean instead of smearing the edge texel.
  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    fragColor = vec4(uOutsideColor, 1.0);
    return;
  }
  vec3 src = texture(uImage, srcUv).rgb;
  //__ANCHOR_RETOUCH__
  // Spot removal (heal / clone): patch the source before any tone edits.
  if (uApplyRetouch && (uSpotCount > 0 || uRetouchCount > 0)) src = applyRetouch(srcUv, src);
  float rawLuma = srcLuma(src);

  float texAmt = uTexture / 100.0;
  float clarAmt = uClarity / 100.0;
  float dehAmt = uDehaze / 100.0;

  // White balance & exposure in linear light, kept HDR (no clamp) so highlights
  // survive past 1.0 into the recovery stage. RAW input is already linear.
  // Fallback preview is already pseudo-linear (inverse gamma applied in JS).
  vec3 lin = uLinear ? src : (uIsFallbackPreview ? src : srgbToLinear(src));

  // Default baseline for scene-linear sources (see baseline-tone.ts): the
  // camera-style lift a RAW decode lacks and every already-rendered bitmap
  // carries. Scene-linear in and out, but a nonlinear per-channel curve (about
  // +0.75 EV at mid grey, with 1.0 staying 1.0): values above 1.0 pass through
  // unchanged and values below 0 continue along the curve's slope, so the
  // downstream linear edits (WB, exposure, highlight recovery) still see the headroom.
  if (uApplyBaseCurve) lin = baselineTone(lin);

  // Contributed noise-reduction stages (extension-owned), on scene-linear lin,
  // before exposure so denoising isn't amplified -- same rationale as core NR.
  //__CONTRIBUTED_NOISE_REDUCTION__

  // Noise reduction, applied before exposure so it isn't amplified. Color NR
  // replaces chroma with a blurred (mip) version -- kills the rainbow speckle
  // that big exposure pushes reveal; Luminance NR eases luma toward the blur in
  // flat areas while protecting edges.
  float colorNR = uColorNR / 100.0;
  float lumNR = uLuminanceNR / 100.0;
  // An extension denoise stage (in the noise-reduction phase) replaces — not
  // stacks on — the built-in NR, so skip this block when one is active.
  if (!uSkipCoreNR && (colorNR > 0.001 || lumNR > 0.001)) {
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
      float detailPres = uLumNRDetail / 100.0;
      float ls = max(luma(lin), 1e-4);

      float shadowBias = uLumNRShadows / 100.0;
      float highlightBias = uLumNRHighlights / 100.0;
      float zoneMult = 1.0
        + shadowBias * (1.0 - smoothstep(0.0, 0.35, ls))
        - highlightBias * smoothstep(0.65, 1.0, ls);
      float effectiveNR = lumNR * clamp(zoneMult, 0.0, 2.0);

      vec3 b1raw = textureLod(uImage, srcUv, 1.0).rgb;
      float l1 = luma(uLinear ? b1raw : srgbToLinear(b1raw));
      float l2 = lb;
      vec3 b3raw = textureLod(uImage, srcUv, 3.0).rgb;
      float l3 = luma(uLinear ? b3raw : srgbToLinear(b3raw));

      float d1 = ls - l1;
      float d2 = l1 - l2;
      float d3 = l2 - l3;

      float t1 = mix(0.06, 0.015, detailPres);
      float shrink1 = effectiveNR * t1;
      float shrink2 = effectiveNR * t1 * 1.8 * 0.4;
      float shrink3 = effectiveNR * t1 * 3.5 * 0.15;
      d1 = sign(d1) * max(abs(d1) - shrink1, 0.0);
      d2 = sign(d2) * max(abs(d2) - shrink2, 0.0);
      d3 = sign(d3) * max(abs(d3) - shrink3, 0.0);

      float targetL = l3 + d3 + d2 + d1;
      float contrastBias = uLumNRContrast / 100.0;
      float edgeMag = abs(ls - l2);
      float edgeProtect = smoothstep(0.01, mix(0.12, 0.03, contrastBias), edgeMag);
      targetL = mix(targetL, ls, edgeProtect);

      lin *= max(targetL, 1e-4) / ls;
    }
  }

  // Channel reconstruction: recover colour from clipped highlights by estimating
  // saturated channels from their unclipped neighbours. Must run before WB/exposure
  // so the per-channel clip detection still reflects the raw sensor data.
  if (uLinear) lin = reconstructClipped(lin, srcUv);${v2(`

  // The camera baseline (baseline-tone.ts): the refit to the camera curve and
  // the camera maker's exposure offset. Here, not with baselineTone, so the
  // decode stages' passes and clip recovery's threshold still see the curve
  // they were written against.
  if (uApplyBaseCurve) lin = slBaselineRefit(lin) * uBaselineGain;`)}

  //__ANCHOR_WHITE_BALANCE__

  // Scene tonal zone, captured BEFORE exposure. Only the masks' Highlights/Shadows
  // use it (applyMaskLinear): they classify pixels by where they sat in the original
  // scene, so a global exposure push (e.g. +5) does not reclassify lifted midtones as
  // highlights and let a mask's Highlights -100 drag them to grey. The global
  // Highlights/Shadows below act on the current luma and do not read it.
  float refT = clamp(luma(linearToSrgbU(max(lin, vec3(0.0)))), 0.0, 1.0);

  //__ANCHOR_TONE__
  //__ANCHOR_MASKS__


  // Local adjustment masks, stage 1: tonal + WB controls in scene-referred
  // linear with HDR headroom intact (Lightroom-style — this is what lets a
  // mask's Highlights/Exposure recover data the display stage can't see).
  //
  // First combine each mask's components into one coverage value: ADD unions
  // (max), SUBTRACT carves away (×(1−c)), in list order. Then whole-mask invert
  // and opacity. Coverage is reused by stage 2 below.
  float mcovs[MAX_MASKS];
  for (int mi = 0; mi < MAX_MASKS; mi++) mcovs[mi] = 0.0;${maskExit}
  float mLuma = luma(lin);
  for (int ci = 0; ci < MAX_COMPONENTS; ci++) {
    if (ci >= uCompCount) break;
    int p = uCompMaskIdx[ci];
    float cc = compCoverage(ci, srcUv, lin, mLuma);
    if (uCompMode[ci] == 0) mcovs[p] = max(mcovs[p], cc);       // add (union)
    else if (uCompMode[ci] == 1) mcovs[p] = mcovs[p] * (1.0 - cc); // subtract (carve)
    else mcovs[p] = mcovs[p] * cc;                              // intersect
  }
  // Combined coverage of the visualized mask (post-invert, pre-opacity), so even
  // a fresh or 0-opacity mask still previews on hover.
  float vizCov = 0.0;
  for (int mi = 0; mi < MAX_MASKS; mi++) {
    if (mi >= uMaskCount) break;
    float mm = mcovs[mi];
    if (uMaskInvert[mi] == 1) mm = 1.0 - mm;
    if (mi == uVizMask) vizCov = mm;
    mcovs[mi] = clamp(mm * uMaskOpacity[mi], 0.0, 1.0);
  }
  for (int mi = 0; mi < MAX_MASKS; mi++) {
    if (mi >= uMaskCount) break;
    if (mcovs[mi] <= 0.0) continue;
    lin = applyMaskLinear(lin, uMaskAdj0[mi], uMaskAdj1[mi], mcovs[mi], refT);
  }

  // Contributed scene-linear stages (extension-owned), on lin after all the
  // core linear edits and just before the display transform.
  //__CONTRIBUTED_SCENE_LINEAR__${v2(SCENE_LUMA_DECL)}
${v2(`
  // The core shoulder bounds luminance; this rolls the strongest channel off
  // into white with it, so bright colours whiten instead of clipping.
  if (uApplyToneShoulder) lin = slPathToWhite(lin);`)}${sceneExit}

  // Display conversion: where the filmic shoulder applies it bounds the linear
  // values, so clamping here is safe and keeps downstream display-space
  // operations from ever seeing values > 1.0 (which broke contrast, dehaze,
  // etc.). A transform that skips the shoulder must bound its own output.
  // Version 2 doesn't clamp here: each tool below whose math needs [0, 1]
  // clamps its own input, and only while it's in use.
  vec3 disp = ${pick("clamp(pipelineToDisplay(lin), 0.0, 1.0)", "pipelineToDisplay(lin)")};
  vec3 c = disp;

  //__ANCHOR_DISPLAY_BASIC__
  //__ANCHOR_TONE_CURVE__
  //__ANCHOR_HSL__

  //__ANCHOR_PRESENCE__
  //__ANCHOR_BAND_DETAIL__
  //__ANCHOR_VIBRANCE__
  //__ANCHOR_COLOR_GRADING__

  //__ANCHOR_SHARPEN__
${fallbackClamp}

  // Local adjustment masks, stage 2: contrast/saturation/detail plus the HSL
  // and tone-curve sub-panels, in display space (coverage from stage 1).
  for (int mi = 0; mi < MAX_MASKS; mi++) {
    if (mi >= uMaskCount) break;
    float mcov = mcovs[mi];
    if (mcov <= 0.0) continue;
    ${pick(
      "c = applyMaskDisplay(c, uMaskAdj0[mi], uMaskAdj1[mi], uMaskAdj2[mi], uMaskAdj3[mi], mcov, srcUv);",
      `if (uMaskHasDisplay[mi] == 1)
      c = mix(c, applyMaskDisplay(clamp(c, 0.0, 1.0), uMaskAdj0[mi], uMaskAdj1[mi],
                                  uMaskAdj2[mi], uMaskAdj3[mi], 1.0, srcUv, rawLuma), mcov);`,
    )}
    if (uMaskHasHsl[mi] == 1)
      c = mix(c, maskHsl(clamp(c, 0.0, 1.0), mi), mcov);
    if (uMaskHasCurve[mi] == 1)
      c = maskCurve(c, mi, mcov);
  }

  // Creative effects (contributed by processing stages)
  //__CONTRIBUTED_EFFECTS__

  if (uSharpenViz == 4) {
    // Alt/Ctrl-drag Color-NR preview: flatten luminance and amplify chroma so
    // colour speckle stands out against neutral grey (grayscale can't show it).
    vec3 cc = clamp(c, 0.0, 1.0);
    vec3 chroma = cc - vec3(luma(cc));
    fragColor = vec4(clamp(vec3(0.5) + chroma * 4.0, 0.0, 1.0), 1.0);
  } else if (uSharpenViz > 0) {
    // Alt/Ctrl-drag sharpening / luminance-NR preview: grayscale signal.
    fragColor = vec4(vec3(sharpenViz), 1.0);
  } else if (uRawHistogram) {
    fragColor = vec4(c, 1.0);
  } else if (uShowClipping > 0) {${v.signedOutput ? `
    // Mapped once: the warning measures the colour the display value encodes.
    vec3 mapped = slOutputLinear(c);
    vec3 display = slEncodeOutput(mapped);` : `
    vec3 display = ${output};`}
    bool shadow = (uShowClipping & 1) != 0 && c.r <= 0.0 && c.g <= 0.0 && c.b <= 0.0;
    bool highlight = (uShowClipping & 2) != 0 && (c.r >= 1.0 || c.g >= 1.0 || c.b >= 1.0);${signed(`
    bool gamut = (uShowClipping & 4) != 0 && slGamutShift(c, mapped) > SL_OK_JND;`)}
    fragColor = shadow ? vec4(0.2, 0.3, 1.0, 1.0)
               : highlight ? vec4(1.0, 0.2, 0.2, 1.0)${signed(`
               : gamut ? vec4(vec3(0.5), 1.0)`)}
               : vec4(display, 1.0);
  } else {
    vec3 outRgb = ${output};
    // Coverage overlay: tint covered pixels toward the mask's colour on hover.
    if (uVizMask >= 0) outRgb = mix(outRgb, uVizColor, vizCov * uVizStrength);
    fragColor = vec4(outRgb, 1.0);
  }
}
`;
}

export const FRAGMENT_SHADER = fragmentShaderSource(V1_VARIANT);

// The stock Safelight transform: plain unclamped sRGB encode, preserving HDR
// headroom for the downstream highlight stages.
export const DEFAULT_PIPELINE_GLSL = `vec3 pipelineToDisplay(vec3 lin) { return linearToSrgbU(lin); }`;

/** Version 2's stock transform: the same encode, with colours outside the
 *  sRGB primaries kept as signed values instead of floored at black. */
export const V2_DEFAULT_PIPELINE_GLSL =
  `vec3 pipelineToDisplay(vec3 lin) { return slEncodePerceptual(lin); }`;

/** Stage contributions passed to buildFragmentShader for hybrid injection.
 *  GLSL is grouped by the processing phase it targets. `noiseReduction` and
 *  `sceneLinear` blocks run on the scene-linear working color `vec3 lin`
 *  (HDR, pre-display-transform); `effects` blocks run on the display-encoded
 *  `vec3 c` (as the legacy vignette/grain stages always have). `uniforms` and
 *  `helpers` are global declarations shared by every group. */
export interface StageInjection {
  uniforms: string;
  helpers: string;
  /** Geometry stages operating on the mutable `vec2 srcUv` (before sampling). */
  srcUv: string;
  noiseReduction: string;
  sceneLinear: string;
  effects: string;
  /** True when a stage converts into a declared space, so the space helpers
   *  must be compiled in. */
  needsSpaceHelpers?: boolean;
  /** How many reads-current exits are compiled in. 0 leaves the program text
   *  untouched. */
  splitCount?: number;
  /** The blocks of the stages that run at anchors, by anchor; absent when no
   *  stage names one. */
  anchors?: Partial<Record<StageAnchor, string>>;
}

/** Splice pipeline GLSL and contributed processing stages into the develop
 *  shader. Pass null/undefined pipeline for the built-in transform. The
 *  stages parameter injects GLSL from registered ProcessingStageContributions
 *  at the appropriate markers; omit it (or pass empty strings) when no stages
 *  are registered. variant: the photo's process version (shaderVariantFor);
 *  defaults to version 1. exit: a probe's or a scene measurement's program
 *  (ProgramExit); omit it for the frame's. pipelineUniforms: the display transform's own uniform
 *  declarations (ResolvedPipeline.uniformDecls). */
export function buildFragmentShader(
  pipelineGlsl?: string | null,
  stages?: StageInjection,
  variant: ShaderVariant = V1_VARIANT,
  exit?: ProgramExit,
  pipelineUniforms = "",
): string {
  const pipeline =
    pipelineGlsl || (variant.fullInfo ? V2_DEFAULT_PIPELINE_GLSL : DEFAULT_PIPELINE_GLSL);
  const spaceHelpers =
    variant.fullInfo || stages?.needsSpaceHelpers || exit === "scene" ? `${STAGE_SPACE_GLSL}\n` : "";
  // Replacer functions: a replacement string would read $&, $$, $' and $` in
  // contributed GLSL (comments included) as patterns.
  return fragmentShaderSource(variant, (stages?.splitCount ?? 0) > 0, exit)
    .replace("//__PIPELINE_GLSL__", () => spaceHelpers + pipeline)
    .replace("//__CONTRIBUTED_UNIFORMS__", () =>
      pipelineUniforms ? `${pipelineUniforms}\n${stages?.uniforms ?? ""}` : stages?.uniforms ?? "",
    )
    .replace("//__CONTRIBUTED_HELPERS__", () => stages?.helpers ?? "")
    .replace("//__CONTRIBUTED_GEOMETRY__", () => stages?.srcUv ?? "")
    .replace("//__CONTRIBUTED_NOISE_REDUCTION__", () => stages?.noiseReduction ?? "")
    .replace("//__CONTRIBUTED_SCENE_LINEAR__", () => stages?.sceneLinear ?? "")
    .replace("//__CONTRIBUTED_EFFECTS__", () => stages?.effects ?? "")
    .replace(ANCHOR_MARKERS, (marker) => stages?.anchors?.[ANCHOR_BY_MARKER.get(marker)!] ?? "");
}

const ANCHOR_BY_MARKER = new Map(
  (Object.keys(STAGE_ANCHORS) as StageAnchor[]).map((a) => [anchorMarker(a), a]),
);
const ANCHOR_MARKERS = new RegExp([...ANCHOR_BY_MARKER.keys()].join("|"), "g");
