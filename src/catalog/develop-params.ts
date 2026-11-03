// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

export interface CurvePoint {
  x: number; // 0..1 input
  y: number; // 0..1 output
}

export const TONE_CURVE_CHANNELS = ["rgb", "red", "green", "blue"] as const;
export type ToneCurveChannel = (typeof TONE_CURVE_CHANNELS)[number];

export interface ToneCurves {
  rgb: CurvePoint[]; // master curve, applied to all channels first
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export interface CropRect {
  x: number; // 0..1 left edge, image space (y-down, 0 = top)
  y: number; // 0..1 top edge
  width: number; // 0..1 fraction of image width
  height: number; // 0..1 fraction of image height
}

export const HSL_CHANNELS = [
  "red",
  "orange",
  "yellow",
  "green",
  "aqua",
  "blue",
  "purple",
  "magenta",
] as const;

export type HSLChannel = (typeof HSL_CHANNELS)[number];
export type HSLBand = "hue" | "saturation" | "luminance";

export type HSLValues = Record<HSLChannel, number>;

export interface HSLAdjustments {
  hue: HSLValues;
  saturation: HSLValues;
  luminance: HSLValues;
}

// Geometry/perspective transform applied to the whole image before the crop.
// Numeric values are -100..100 with 0 = no effect.
export interface TransformParams {
  perspectiveV: number; // vertical keystone (tilt top/bottom)
  perspectiveH: number; // horizontal keystone (tilt left/right)
  aspect: number; // horizontal vs vertical stretch
  scale: number; // zoom in/out
  offsetX: number; // pan
  offsetY: number;
  flipH: boolean; // mirror horizontal
  flipV: boolean; // mirror vertical
}

export type UprightMode = "off" | "auto" | "level" | "vertical" | "full" | "guided";

export interface GuidedLine {
  x1: number; // normalized 0..1 source-UV
  y1: number;
  x2: number;
  y2: number;
}

export interface ColorGradingRange {
  hue: number;  // 0..360 degrees
  sat: number;  // 0..100
  luma: number; // -100..100
}

export interface ColorGradingParams {
  shadows: ColorGradingRange;
  midtones: ColorGradingRange;
  highlights: ColorGradingRange;
  global: ColorGradingRange;
  shadowRange: number;    // 0..100: how far shadow wheel extends upward
  highlightRange: number; // 0..100: how far highlight wheel extends downward
}

export interface VignetteParams {
  amount: number;      // -100..100 (neg=darken, pos=lighten edges)
  midpoint: number;    // 0..100 how far the effect reaches in
  roundness: number;   // -100..100 (neg=rectangular, pos=circular)
  feather: number;     // 0..100 edge softness
  highlights: number;  // 0..100 highlight priority (protect highlights)
}

export interface GrainParams {
  amount: number;     // 0..100
  size: number;       // 25..100 crystal size (larger = coarser grain)
  roughness: number;  // 0..100 crystal size variation (higher = more irregular)
  color: number;      // 0..100 polychromatic grain (0 = mono, 100 = full per-channel)
}

// Local adjustments carried by a mask. A subset of the global develop controls,
// all -100..100 with 0 = no effect. Applied only where the mask covers.
export interface MaskAdjustments {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  saturation: number;
  vibrance: number;
  temperature: number; // relative warm(+)/cool(-)
  tint: number;        // magenta(+)/green(-)
  texture: number;
  clarity: number;
  dehaze: number;
  sharpness: number;
}

// Geometric mask tools the user can pick from the toolbar. Parametric range
// masks (lumRange/colorRange) are component KINDS but not standalone "tools" in
// the same sense — they're added from the component menu and have no canvas drag.
export type MaskType = "linear" | "radial" | "brush";

// Adjustment sub-panels a mask can carry. Each mask opts into the panels it
// needs (Lightroom-style). Entries are registered panel ids ("core.basic", or
// an extension's panel id) whose contribution declares a per-mask variant
// (PanelContribution.mask). Unknown ids are preserved so a disabled
// extension's sub-panels come back when it re-enables.
// Masks saved before sub-panels existed showed every slider; keep that view.
export const LEGACY_MASK_PANELS: string[] = ["core.basic", "core.white-balance", "core.detail"];
export const DEFAULT_MASK_PANELS: string[] = ["core.basic"];

// One freehand brush dab, in source-UV space. radius is in image-height units.
export interface BrushDab {
  x: number;
  y: number;
  radius: number;
  erase: boolean;
  feather: number; // 0..1 edge softness, captured from the brush at paint time
  opacity?: number; // 0..1 coverage ceiling of its stroke; absent = 1 (full). Captured at paint time.
  flow?: number; // 0..1 per-dab deposit; absent = 1 (full). Captured at paint time.
  // First dab of a pointer stroke. Opacity caps each stroke on its own and
  // strokes stack over each other; dabs painted before strokes were recorded
  // carry no marker and bake as one stroke.
  strokeStart?: boolean;
}

// Linear gradient geometry: effect ramps 0->1 from p0 to p1 (source-UV).
export interface LinearMaskGeo {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Radial geometry in source-UV: centre + per-axis radii (so it stays round on
// screen regardless of image aspect) + edge feather (0..1 of the radius).
export interface RadialMaskGeo {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  feather: number;
  angle: number; // rotation, radians (0 = axis-aligned)
}

export interface BrushMaskGeo {
  dabs: BrushDab[];
  feather: number; // 0..1 edge softness of each dab
}

// Luminance-range mask: selects pixels whose luma falls in [lo, hi], with a
// soft falloff of width loFeather/hiFeather at each end. All in 0..1 over the
// (developed, scene-linear) pixel luminance. Global by default — meant to be
// INTERSECTED with a geometric component to confine it to a region.
export interface LumRangeGeo {
  lo: number;
  hi: number;
  loFeather: number; // 0..1 ramp width below lo
  hiFeather: number; // 0..1 ramp width above hi
}

// Color-range mask: selects pixels near a target colour. The target is stored
// in scene-LINEAR RGB, as the mask stage sees it (the picker probes the render
// worker at that stage), so it compares directly against the pipeline's working
// colour. hueRange/satRange set the tolerance; smoothness softens the selection edge.
export interface ColorRangeGeo {
  r: number; // target colour, scene-linear RGB
  g: number;
  b: number;
  hueRange: number; // 0..1 hue tolerance
  satRange: number; // 0..1 saturation/chroma tolerance
  smoothness: number; // 0..1 edge softness
}

// A mask is built from one or more components (Lightroom-style). Each component
// contributes coverage that is ADDED (union, max), SUBTRACTED (carve, ×(1−c)),
// or INTERSECTED (×c) into the mask's combined coverage, in list order.
export type MaskComponentKind = MaskType | "lumRange" | "colorRange";
export type MaskComponentMode = "add" | "subtract" | "intersect";

export interface MaskComponent {
  id: string;
  kind: MaskComponentKind;
  mode: MaskComponentMode;
  invert: boolean; // invert this component's own coverage before combining
  linear?: LinearMaskGeo;
  radial?: RadialMaskGeo;
  brush?: BrushMaskGeo;
  lumRange?: LumRangeGeo;
  colorRange?: ColorRangeGeo;
}

export interface Mask {
  id: string;
  name: string;
  visible: boolean; // when false the mask is muted (no effect), but still listed
  invert: boolean; // invert the whole combined coverage
  opacity: number; // 0..100 overall strength
  adj: MaskAdjustments;
  panels: string[]; // active adjustment sub-panels (registered panel ids)
  hsl?: HSLAdjustments;  // present only while the HSL sub-panel is added
  toneCurve?: ToneCurves; // present only while the Tone Curve sub-panel is added
  /** Mask-scoped extension params, keyed by qualified key ("{stageId}.{key}")
   *  like DevelopParams.paramBag. Extension sub-panels store their values here,
   *  and a maskable stage with any key here runs once more inside this mask
   *  with these values (version 2 and later; mask-stage-instances.ts).
   *  Unknown keys are preserved, mirroring the global bag. */
  bag?: Record<string, unknown>;
  components: MaskComponent[]; // at least one; combined in order
}

// A spot-removal target: paint the destination with pixels sampled from a
// source offset, recoloured to match the spot's surrounding tone (heal).
// shape "circle" is a single disc; "brush" is a freehand painted region (dabs),
// with the same source offset applied across the whole shape.
export interface RetouchSpot {
  id: string;
  shape: "circle" | "brush";
  mode: "heal" | "clone";
  visible: boolean;
  dstX: number; // destination centre / anchor (source-UV)
  dstY: number;
  srcX: number; // sample source centre / anchor (source-UV)
  srcY: number;
  radius: number; // image-height units (circle radius; brush draw radius)
  feather: number; // 0..100
  opacity: number; // 0..100
  // Auto-fit transform of the source patch, so it blends into the spot's
  // surroundings (circle spots). Defaults are identity / no shift.
  angle?: number; // radians; source rotation
  scale?: number; // source scale (1 = none)
  recolorR?: number; // additive colour offset (encoded 0..1), source -> match
  recolorG?: number;
  recolorB?: number;
  dabs?: BrushDab[]; // brush shape, when shape === "brush"
}

export interface DevelopParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  highlightDetail: number;   // -100..100 micro-contrast in the highlight band (+ crisper, - smoother)
  shadowDetail: number;      // -100..100 micro-contrast in the shadow band (+ crisper, - smoother)
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  sharpening: number;        // 0..100 capture sharpening amount
  sharpenRadius: number;     // 1..3   sharpening radius
  sharpenDetail: number;     // 0..100 halo suppression (higher = more detail)
  sharpenMasking: number;    // 0..100 edge masking (0 = sharpen all, 100 = edges only)
  luminanceNR: number;       // 0..100 luminance noise reduction
  luminanceNRDetail: number; // 0..100 luminance detail preservation
  luminanceNRContrast: number; // 0..100 luminance contrast preservation
  luminanceNRShadows: number;    // 0..100 extra NR weight in shadows
  luminanceNRHighlights: number; // 0..100 reduce NR weight in highlights
  colorNR: number;           // 0..100 colour (chroma) noise reduction
  colorNRDetail: number;     // 0..100 colour detail preservation
  colorNRSmoothness: number; // 0..100 colour smoothness
  vibrance: number;
  saturation: number;
  temperature: number;
  tint: number;
  straighten: number; // degrees, -45..45 (0 = none)
  crop: CropRect;
  transform: TransformParams;
  uprightMode: UprightMode;
  guidedLines: GuidedLine[];
  toneCurve: ToneCurves;
  hsl: HSLAdjustments;
  colorGrading: ColorGradingParams;
  vignette: VignetteParams;
  grain: GrainParams;
  masks: Mask[];
  retouch: RetouchSpot[];
  /** Display transform (tone mapper) picked for this photo, by pipeline id,
   *  or null to follow the Preferences default. Resolved by
   *  resolvePipelineFor in extensions/pipelines.ts. */
  displayTransform: string | null;
  /** The rendering generation this edit was made with. Edits saved before
   *  process versions existed carry none and read as LEGACY_PROCESS_VERSION,
   *  so they render exactly as they always have; new edits get
   *  CURRENT_PROCESS_VERSION. Presets and pasted settings never change it. */
  processVersion: number;
}

export const MAX_MASKS = 16;
export const MAX_RETOUCH = 32;
export const MAX_BRUSH_MASKS = 4; // brush coverage packs into one RGBA texture
export const MAX_MASK_COMPONENTS = 24; // total components across all masks (shader cap)

// Assign one develop param, keeping the key and value types tied. Lets callers
// reset/bypass params in a `(keyof DevelopParams)[]` loop without the
// `as unknown as Record<string, unknown>` double-casts those loops used to need
// — the generic K binds `value` to exactly `target[key]`'s type.
export function assignDevelopParam<K extends keyof DevelopParams>(
  target: DevelopParams,
  key: K,
  value: DevelopParams[K],
): void {
  target[key] = value;
}
