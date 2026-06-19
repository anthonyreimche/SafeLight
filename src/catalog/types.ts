export interface CatalogPhoto {
  id: string;
  filename: string;
  /** Path relative to the project root, e.g. "2024/trip/IMG_001.NEF". */
  relPath: string;
  /** Containing folder: dirname of relPath ("" = project root). */
  folder: string;
  directoryHandle: FileSystemDirectoryHandle | null;
  fileHandle: FileSystemFileHandle | null;
  thumbnailBlob: Blob | null;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  rating: number;
  colorLabel: ColorLabel;
  flag: FlagStatus;
  rotation: number; // baked-in display rotation, degrees CW (0/90/180/270)
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
}

export type ColorLabel = "none" | "red" | "yellow" | "green" | "blue" | "purple";
export type FlagStatus = "none" | "pick" | "reject";

export interface ExifData {
  cameraMake?: string;
  cameraModel?: string;
  bodySerial?: string;
  lens?: string;
  lensMake?: string;
  lensSerial?: string;
  focalLength?: number;
  focalLength35mm?: number;
  aperture?: number;
  maxAperture?: number;
  shutterSpeed?: string;
  iso?: number;
  exposureCompensation?: number;
  exposureProgram?: string;
  exposureMode?: string;
  meteringMode?: string;
  whiteBalance?: string;
  flash?: string;
  subjectDistance?: number; // metres
  sceneCaptureType?: string;
  colorSpace?: string;
  artist?: string;
  copyright?: string;
  software?: string;
  imageDescription?: string;
  dateTimeOriginal?: string;
  orientation?: number; // EXIF Orientation tag (1..8)
  colorTemperature?: number; // as-shot WB in Kelvin (from AsShotNeutral / libraw)
  gpsLatitude?: number;  // decimal degrees (positive = N, negative = S)
  gpsLongitude?: number; // decimal degrees (positive = E, negative = W)
  gpsAltitude?: number;  // metres above sea level
}

export interface EditState {
  photoId: string;
  stack: EditSnapshot[];
  currentIndex: number;
}

export interface EditSnapshot {
  timestamp: number;
  label: string;
  params: DevelopParams;
}

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

export interface LensCorrectionParams {
  mode: "off" | "profile" | "manual";
  profileId: string | null;
  profileSource: "lensfun" | "extension" | null;
  distortionEnabled: boolean;
  caEnabled: boolean;
  vignetteEnabled: boolean;
  autoCrop: boolean;
  distortion: number;          // -100..100 (neg=barrel fix, pos=pincushion fix)
  chromaticAberration: number; // 0..100 lateral CA removal
  defringe: number;            // 0..100 fringe suppression amount
  vignetting: number;          // -100..100 lens vignetting correction
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
  saturation: number;
  temperature: number; // relative warm(+)/cool(-)
  tint: number;        // magenta(+)/green(-)
  clarity: number;
  sharpness: number;
}

export type MaskType = "linear" | "radial" | "brush";

// Adjustment sub-panels a mask can carry. Each mask opts into the panels it
// needs (Lightroom-style): "basic" tone sliders, white balance, an 8-band HSL
// mixer, a full RGB tone curve, and detail (clarity/sharpness).
export type MaskPanelId = "basic" | "wb" | "hsl" | "curve" | "detail";
export const MASK_PANEL_IDS: MaskPanelId[] = ["basic", "wb", "hsl", "curve", "detail"];
// Masks saved before sub-panels existed showed every slider; keep that view.
export const LEGACY_MASK_PANELS: MaskPanelId[] = ["basic", "wb", "detail"];
export const DEFAULT_MASK_PANELS: MaskPanelId[] = ["basic"];

// One freehand brush dab, in source-UV space. radius is in image-height units.
export interface BrushDab {
  x: number;
  y: number;
  radius: number;
  erase: boolean;
  feather: number; // 0..1 edge softness, captured from the brush at paint time
}

// Linear gradient geometry: effect ramps 0->1 from p0 to p1 (source-UV).
export interface LinearMaskGeo {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Radial geometry in source-UV: center + per-axis radii (so it stays round on
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

// A mask is built from one or more components (Lightroom-style). Each component
// contributes coverage that is either ADDED (union, max) or SUBTRACTED
// (intersect-with-complement) into the mask's combined coverage, in list order.
export type MaskComponentKind = MaskType;
export type MaskComponentMode = "add" | "subtract";

export interface MaskComponent {
  id: string;
  kind: MaskComponentKind;
  mode: MaskComponentMode;
  invert: boolean; // invert this component's own coverage before combining
  linear?: LinearMaskGeo;
  radial?: RadialMaskGeo;
  brush?: BrushMaskGeo;
}

export interface Mask {
  id: string;
  name: string;
  invert: boolean; // invert the whole combined coverage
  opacity: number; // 0..100 overall strength
  adj: MaskAdjustments;
  panels: MaskPanelId[]; // which adjustment sub-panels are active for this mask
  hsl?: HSLAdjustments;  // present only while the "hsl" panel is added
  toneCurve?: ToneCurves; // present only while the "curve" panel is added
  components: MaskComponent[]; // at least one; combined in order
}

// First component's kind is the mask's representative type (icon / label).
export function maskKind(m: Mask): MaskComponentKind {
  return m.components[0]?.kind ?? "brush";
}

// A spot-removal target: paint the destination with pixels sampled from a
// source offset, recoloured to match the spot's surrounding tone (heal).
// shape "circle" is a single disc; "brush" is a freehand painted region (dabs),
// with the same source offset applied across the whole shape.
export interface RetouchSpot {
  id: string;
  shape: "circle" | "brush";
  dstX: number; // destination center / anchor (source-UV)
  dstY: number;
  srcX: number; // sample source center / anchor (source-UV)
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
  colorNR: number;           // 0..100 color (chroma) noise reduction
  colorNRDetail: number;     // 0..100 color detail preservation
  colorNRSmoothness: number; // 0..100 color smoothness
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
  lensCorrection: LensCorrectionParams;
  vignette: VignetteParams;
  grain: GrainParams;
  masks: Mask[];
  retouch: RetouchSpot[];
}

export const MAX_MASKS = 8;
export const MAX_RETOUCH = 16;
export const MAX_BRUSH_MASKS = 4; // brush coverage packs into one RGBA texture
export const MAX_RETOUCH_BRUSH = 4; // brush-shaped retouch packs into one RGBA texture
export const MAX_MASK_COMPONENTS = 16; // total components across all masks (shader cap)

export function defaultMaskAdjustments(): MaskAdjustments {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    clarity: 0,
    sharpness: 0,
  };
}

export const DEFAULT_TRANSFORM: TransformParams = {
  perspectiveV: 0,
  perspectiveH: 0,
  aspect: 0,
  scale: 100,
  offsetX: 0,
  offsetY: 0,
  flipH: false,
  flipV: false,
};

export const DEFAULT_TONE_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export function defaultToneCurves(): ToneCurves {
  return {
    rgb: [...DEFAULT_TONE_CURVE],
    red: [...DEFAULT_TONE_CURVE],
    green: [...DEFAULT_TONE_CURVE],
    blue: [...DEFAULT_TONE_CURVE],
  };
}

// True when every channel is the untouched 2-point identity ramp — the
// renderer skips per-mask curve LUT work for such masks.
export function isDefaultToneCurves(c: ToneCurves): boolean {
  return (["rgb", "red", "green", "blue"] as const).every((ch) => {
    const pts = c[ch];
    return (
      pts.length === 2 &&
      pts[0].x === 0 && pts[0].y === 0 &&
      pts[1].x === 1 && pts[1].y === 1
    );
  });
}

export function isDefaultHSL(h: HSLAdjustments): boolean {
  return (["hue", "saturation", "luminance"] as const).every((b) =>
    HSL_CHANNELS.every((ch) => h[b][ch] === 0),
  );
}

export const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

function defaultColorGradingRange(): ColorGradingRange {
  return { hue: 0, sat: 0, luma: 0 };
}

export function defaultColorGrading(): ColorGradingParams {
  return {
    shadows: defaultColorGradingRange(),
    midtones: defaultColorGradingRange(),
    highlights: defaultColorGradingRange(),
    global: defaultColorGradingRange(),
    shadowRange: 50,
    highlightRange: 50,
  };
}

function zeroHSLValues(): HSLValues {
  return {
    red: 0,
    orange: 0,
    yellow: 0,
    green: 0,
    aqua: 0,
    blue: 0,
    purple: 0,
    magenta: 0,
  };
}

export function defaultHSL(): HSLAdjustments {
  return {
    hue: zeroHSLValues(),
    saturation: zeroHSLValues(),
    luminance: zeroHSLValues(),
  };
}

export const DEFAULT_LENS_CORRECTION: LensCorrectionParams = {
  mode: "off",
  profileId: null,
  profileSource: null,
  distortionEnabled: true,
  caEnabled: true,
  vignetteEnabled: true,
  autoCrop: true,
  distortion: 0,
  chromaticAberration: 0,
  defringe: 0,
  vignetting: 0,
};

export const DEFAULT_VIGNETTE: VignetteParams = {
  amount: 0,
  midpoint: 50,
  roundness: 0,
  feather: 50,
  highlights: 0,
};

export const DEFAULT_GRAIN: GrainParams = {
  amount: 0,
  size: 25,
  roughness: 50,
  color: 0,
};

export const DEFAULT_DEVELOP_PARAMS: DevelopParams = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  sharpening: 25,
  sharpenRadius: 1.0,
  sharpenDetail: 25,
  sharpenMasking: 0,
  luminanceNR: 0,
  luminanceNRDetail: 50,
  luminanceNRContrast: 0,
  luminanceNRShadows: 0,
  luminanceNRHighlights: 0,
  colorNR: 25,
  colorNRDetail: 50,
  colorNRSmoothness: 50,
  vibrance: 0,
  saturation: 0,
  temperature: 6500, // Kelvin; 6500 = neutral
  tint: 0,
  straighten: 0,
  crop: { ...DEFAULT_CROP },
  transform: { ...DEFAULT_TRANSFORM },
  uprightMode: "off",
  guidedLines: [],
  toneCurve: defaultToneCurves(),
  hsl: defaultHSL(),
  colorGrading: defaultColorGrading(),
  lensCorrection: { ...DEFAULT_LENS_CORRECTION },
  vignette: { ...DEFAULT_VIGNETTE },
  grain: { ...DEFAULT_GRAIN },
  masks: [],
  retouch: [],
};

function normalizeTransform(
  t: Partial<TransformParams> | undefined,
): TransformParams {
  const c = (n: unknown) =>
    typeof n === "number" && isFinite(n) ? Math.max(-100, Math.min(100, n)) : 0;
  const cScale = (n: unknown) => {
    if (typeof n !== "number" || !isFinite(n)) return 100;
    if (n < 50) return Math.max(50, Math.min(150, n + 100));
    return Math.max(50, Math.min(150, n));
  };
  return {
    perspectiveV: c(t?.perspectiveV),
    perspectiveH: c(t?.perspectiveH),
    aspect: c(t?.aspect),
    scale: cScale(t?.scale),
    offsetX: c(t?.offsetX),
    offsetY: c(t?.offsetY),
    flipH: t?.flipH === true,
    flipV: t?.flipV === true,
  };
}

const UPRIGHT_MODES: UprightMode[] = ["off", "auto", "level", "vertical", "full", "guided"];

function normalizeUprightMode(m: unknown): UprightMode {
  return typeof m === "string" && UPRIGHT_MODES.includes(m as UprightMode)
    ? (m as UprightMode)
    : "off";
}

function normalizeGuidedLines(lines: unknown): GuidedLine[] {
  if (!Array.isArray(lines)) return [];
  const out: GuidedLine[] = [];
  for (const l of lines) {
    if (!l || typeof l.x1 !== "number") continue;
    const c = (v: unknown) =>
      typeof v === "number" && isFinite(v) ? Math.min(2, Math.max(-1, v)) : 0;
    out.push({ x1: c(l.x1), y1: c(l.y1), x2: c(l.x2), y2: c(l.y2) });
    if (out.length >= 4) break;
  }
  return out;
}

function clampStraighten(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.min(45, Math.max(-45, n));
}

// Temperature is Kelvin (2000-50000), 6500 neutral. Pre-Kelvin edits stored a
// relative value near 0, so anything below 1000 is treated as "neutral".
function normalizeTemp(n: unknown): number {
  if (typeof n !== "number" || !isFinite(n) || n < 1000) return 6500;
  return Math.min(50000, Math.max(2000, n));
}

function clampTint(n: unknown): number {
  if (typeof n !== "number" || !isFinite(n)) return 0;
  return Math.min(150, Math.max(-150, n));
}

function normalizeCrop(c: Partial<CropRect> | undefined): CropRect {
  if (!c) return { ...DEFAULT_CROP };
  const clamp01 = (n: unknown, d: number) =>
    typeof n === "number" && isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
  const x = clamp01(c.x, 0);
  const y = clamp01(c.y, 0);
  return {
    x,
    y,
    width: Math.max(0.01, Math.min(clamp01(c.width, 1), 1 - x)),
    height: Math.max(0.01, Math.min(clamp01(c.height, 1), 1 - y)),
  };
}

function normalizeColorGradingRange(
  r: Partial<ColorGradingRange> | undefined,
): ColorGradingRange {
  const clamp = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    hue: clamp(r?.hue, 0, 360, 0),
    sat: clamp(r?.sat, 0, 100, 0),
    luma: clamp(r?.luma, -100, 100, 0),
  };
}

function normalizeColorGrading(
  cg: Partial<ColorGradingParams> | undefined,
): ColorGradingParams {
  const clamp01 = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(100, Math.max(0, v)) : d;
  return {
    shadows: normalizeColorGradingRange(cg?.shadows),
    midtones: normalizeColorGradingRange(cg?.midtones),
    highlights: normalizeColorGradingRange(cg?.highlights),
    global: normalizeColorGradingRange(cg?.global),
    shadowRange: clamp01(cg?.shadowRange, 50),
    highlightRange: clamp01(cg?.highlightRange, 50),
  };
}

function normalizeCurve(c: CurvePoint[] | undefined): CurvePoint[] {
  return c && c.length >= 2
    ? c.map((pt) => ({ x: pt.x, y: pt.y }))
    : [...DEFAULT_TONE_CURVE];
}

// Accepts the current object shape or a legacy single-curve array (treated as
// the RGB master curve), so old snapshots/presets still load.
function normalizeToneCurves(tc: unknown): ToneCurves {
  if (Array.isArray(tc)) {
    return { ...defaultToneCurves(), rgb: normalizeCurve(tc as CurvePoint[]) };
  }
  const t = (tc ?? {}) as Partial<ToneCurves>;
  return {
    rgb: normalizeCurve(t.rgb),
    red: normalizeCurve(t.red),
    green: normalizeCurve(t.green),
    blue: normalizeCurve(t.blue),
  };
}

function normalizeLensCorrection(
  lc: Partial<LensCorrectionParams> | undefined,
): LensCorrectionParams {
  const c100 = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(100, Math.max(-100, v)) : d;
  const c0100 = (v: unknown, d: number) =>
    typeof v === "number" && isFinite(v) ? Math.min(100, Math.max(0, v)) : d;

  const dist = c100(lc?.distortion, 0);
  const ca = c0100(lc?.chromaticAberration, 0);
  const defr = c0100(lc?.defringe, 0);
  const vig = c100(lc?.vignetting, 0);

  // Backward compat: old edits without a mode field that have nonzero sliders
  // are treated as "manual" mode so they render identically.
  const hasLegacyEdits = !lc?.mode && (dist !== 0 || ca !== 0 || defr !== 0 || vig !== 0);

  return {
    mode: lc?.mode ?? (hasLegacyEdits ? "manual" : "off"),
    profileId: lc?.profileId ?? null,
    profileSource: lc?.profileSource ?? null,
    distortionEnabled: lc?.distortionEnabled ?? true,
    caEnabled: lc?.caEnabled ?? true,
    vignetteEnabled: lc?.vignetteEnabled ?? true,
    autoCrop: lc?.autoCrop ?? true,
    distortion: dist,
    chromaticAberration: ca,
    defringe: defr,
    vignetting: vig,
  };
}

function normalizeVignette(
  v: Partial<VignetteParams> | undefined,
): VignetteParams {
  const c = (val: unknown, lo: number, hi: number, d: number) =>
    typeof val === "number" && isFinite(val) ? Math.min(hi, Math.max(lo, val)) : d;
  return {
    amount: c(v?.amount, -100, 100, 0),
    midpoint: c(v?.midpoint, 0, 100, 50),
    roundness: c(v?.roundness, -100, 100, 0),
    feather: c(v?.feather, 0, 100, 50),
    highlights: c(v?.highlights, 0, 100, 0),
  };
}

function normalizeGrain(
  g: Partial<GrainParams> | undefined,
): GrainParams {
  const c = (val: unknown, lo: number, hi: number, d: number) =>
    typeof val === "number" && isFinite(val) ? Math.min(hi, Math.max(lo, val)) : d;
  return {
    amount: c(g?.amount, 0, 100, 0),
    size: c(g?.size, 25, 100, 25),
    roughness: c(g?.roughness, 0, 100, 50),
    color: c(g?.color, 0, 100, 0),
  };
}

const clampN = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

function normalizeMaskAdjustments(
  a: Partial<MaskAdjustments> | undefined,
): MaskAdjustments {
  return {
    exposure: clampN(a?.exposure, -100, 100, 0),
    contrast: clampN(a?.contrast, -100, 100, 0),
    highlights: clampN(a?.highlights, -100, 100, 0),
    shadows: clampN(a?.shadows, -100, 100, 0),
    saturation: clampN(a?.saturation, -100, 100, 0),
    temperature: clampN(a?.temperature, -100, 100, 0),
    tint: clampN(a?.tint, -100, 100, 0),
    clarity: clampN(a?.clarity, -100, 100, 0),
    sharpness: clampN(a?.sharpness, -100, 100, 0),
  };
}

// Missing => legacy mask saved before sub-panels existed: show all sliders.
function normalizeMaskPanels(p: unknown): MaskPanelId[] {
  if (!Array.isArray(p)) return [...LEGACY_MASK_PANELS];
  const seen = new Set<MaskPanelId>();
  for (const id of p)
    if ((MASK_PANEL_IDS as string[]).includes(id)) seen.add(id as MaskPanelId);
  return [...seen];
}

let normCompSeq = 0;
const normCompId = () => `comp-${Date.now().toString(36)}-${normCompSeq++}`;

function normLinear(g: Partial<LinearMaskGeo> | undefined): LinearMaskGeo {
  return {
    x0: clampN(g?.x0, -2, 2, 0.5),
    y0: clampN(g?.y0, -2, 2, 0.2),
    x1: clampN(g?.x1, -2, 2, 0.5),
    y1: clampN(g?.y1, -2, 2, 0.8),
  };
}
function normRadial(g: Partial<RadialMaskGeo> | undefined): RadialMaskGeo {
  return {
    cx: clampN(g?.cx, -2, 2, 0.5),
    cy: clampN(g?.cy, -2, 2, 0.5),
    rx: clampN(g?.rx, 0.001, 4, 0.3),
    ry: clampN(g?.ry, 0.001, 4, 0.3),
    feather: clampN(g?.feather, 0, 1, 0.5),
    angle: clampN(g?.angle, -7, 7, 0),
  };
}
function normBrush(g: Partial<BrushMaskGeo> | undefined): BrushMaskGeo {
  const dabs = Array.isArray(g?.dabs) ? g!.dabs : [];
  return {
    feather: clampN(g?.feather, 0, 1, 0.5),
    dabs: dabs
      .filter((d): d is BrushDab => !!d && typeof d.x === "number")
      .map((d) => ({
        x: clampN(d.x, -2, 2, 0),
        y: clampN(d.y, -2, 2, 0),
        radius: clampN(d.radius, 0.001, 2, 0.05),
        erase: !!d.erase,
        feather: clampN(d.feather, 0, 1, 0.5),
      })),
  };
}

// Build a single component from a (possibly legacy) raw geometry object.
function normComponent(raw: Partial<MaskComponent>): MaskComponent | null {
  const kind = raw.kind;
  const base = {
    id: typeof raw.id === "string" ? raw.id : normCompId(),
    mode: raw.mode === "subtract" ? ("subtract" as const) : ("add" as const),
    invert: !!raw.invert,
  };
  if (kind === "linear" && raw.linear)
    return { ...base, kind, linear: normLinear(raw.linear) };
  if (kind === "radial" && raw.radial)
    return { ...base, kind, radial: normRadial(raw.radial) };
  if (kind === "brush")
    return { ...base, kind, brush: normBrush(raw.brush) };
  return null;
}

// Migrate a legacy single-geometry mask (type + linear/radial/brush at the top
// level) into a one-component mask.
function legacyComponent(raw: Partial<Mask & { type?: string }>): MaskComponent | null {
  const t = (raw as { type?: string }).type;
  const r = raw as Partial<Mask> & {
    linear?: LinearMaskGeo;
    radial?: RadialMaskGeo;
    brush?: BrushMaskGeo;
  };
  if (t === "linear" && r.linear)
    return { id: normCompId(), kind: "linear", mode: "add", invert: false, linear: normLinear(r.linear) };
  if (t === "radial" && r.radial)
    return { id: normCompId(), kind: "radial", mode: "add", invert: false, radial: normRadial(r.radial) };
  if (t === "brush")
    return { id: normCompId(), kind: "brush", mode: "add", invert: false, brush: normBrush(r.brush) };
  return null;
}

function normalizeMasks(masks: unknown): Mask[] {
  if (!Array.isArray(masks)) return [];
  const out: Mask[] = [];
  for (const raw of masks as Partial<Mask & { type?: string }>[]) {
    if (!raw) continue;

    let components: MaskComponent[] = [];
    if (Array.isArray(raw.components)) {
      components = raw.components
        .map((c) => normComponent(c as Partial<MaskComponent>))
        .filter((c): c is MaskComponent => !!c);
    } else {
      const legacy = legacyComponent(raw);
      if (legacy) components = [legacy];
    }
    if (components.length === 0) continue; // no usable geometry — drop

    const m: Mask = {
      id: typeof raw.id === "string" ? raw.id : `mask-${out.length}-${Date.now()}`,
      name: typeof raw.name === "string" ? raw.name : components[0].kind,
      invert: !!raw.invert,
      opacity: clampN(raw.opacity, 0, 100, 100),
      adj: normalizeMaskAdjustments(raw.adj),
      panels: normalizeMaskPanels(raw.panels),
      components,
    };
    if (raw.hsl) {
      m.hsl = {
        hue: { ...zeroHSLValues(), ...raw.hsl.hue },
        saturation: { ...zeroHSLValues(), ...raw.hsl.saturation },
        luminance: { ...zeroHSLValues(), ...raw.hsl.luminance },
      };
    }
    if (raw.toneCurve) m.toneCurve = normalizeToneCurves(raw.toneCurve);
    out.push(m);
    if (out.length >= MAX_MASKS) break;
  }
  return out;
}

function normalizeRetouch(spots: unknown): RetouchSpot[] {
  if (!Array.isArray(spots)) return [];
  const out: RetouchSpot[] = [];
  for (const raw of spots as Partial<RetouchSpot>[]) {
    if (!raw || typeof raw.dstX !== "number") continue;
    const shape = raw.shape === "brush" ? "brush" : "circle";
    const dabs =
      shape === "brush" && Array.isArray(raw.dabs)
        ? raw.dabs
            .filter((d): d is BrushDab => !!d && typeof d.x === "number")
            .map((d) => ({
              x: clampN(d.x, -2, 2, 0),
              y: clampN(d.y, -2, 2, 0),
              radius: clampN(d.radius, 0.001, 2, 0.04),
              erase: !!d.erase,
              feather: clampN(d.feather, 0, 1, 0.5),
            }))
        : undefined;
    out.push({
      id: typeof raw.id === "string" ? raw.id : `spot-${out.length}-${Date.now()}`,
      shape,
      dstX: clampN(raw.dstX, -1, 2, 0.5),
      dstY: clampN(raw.dstY, -1, 2, 0.5),
      srcX: clampN(raw.srcX, -1, 2, 0.5),
      srcY: clampN(raw.srcY, -1, 2, 0.5),
      radius: clampN(raw.radius, 0.002, 1, 0.04),
      feather: clampN(raw.feather, 0, 100, 50),
      opacity: clampN(raw.opacity, 0, 100, 100),
      angle: clampN(raw.angle, -Math.PI, Math.PI, 0),
      scale: clampN(raw.scale, 0.25, 4, 1),
      recolorR: clampN(raw.recolorR, -1, 1, 0),
      recolorG: clampN(raw.recolorG, -1, 1, 0),
      recolorB: clampN(raw.recolorB, -1, 1, 0),
      ...(dabs ? { dabs } : {}),
    });
    if (out.length >= MAX_RETOUCH) break;
  }
  return out;
}

// Merge a (possibly partial / legacy) params object with current defaults so
// snapshots saved before a field existed still load cleanly.
export function normalizeParams(p: Partial<DevelopParams> | undefined): DevelopParams {
  const base = { ...DEFAULT_DEVELOP_PARAMS, ...p };
  return {
    ...base,
    straighten:
      typeof p?.straighten === 'number' ? clampStraighten(p.straighten) : 0,
    temperature: normalizeTemp(p?.temperature),
    tint: clampTint(p?.tint),
    crop: normalizeCrop(p?.crop),
    transform: normalizeTransform(p?.transform),
    uprightMode: normalizeUprightMode(p?.uprightMode),
    guidedLines: normalizeGuidedLines(p?.guidedLines),
    toneCurve: normalizeToneCurves(p?.toneCurve),
    hsl: {
      hue: { ...zeroHSLValues(), ...p?.hsl?.hue },
      saturation: { ...zeroHSLValues(), ...p?.hsl?.saturation },
      luminance: { ...zeroHSLValues(), ...p?.hsl?.luminance },
    },
    colorGrading: normalizeColorGrading(p?.colorGrading),
    lensCorrection: normalizeLensCorrection(p?.lensCorrection),
    vignette: normalizeVignette(p?.vignette),
    grain: normalizeGrain(p?.grain),
    masks: normalizeMasks(p?.masks),
    retouch: normalizeRetouch(p?.retouch),
  };
}

export type SortField = 'dateImported' | 'dateCreated' | 'filename' | 'rating';
export type SortDirection = 'asc' | 'desc';
export type ViewMode = 'grid' | 'list';
export type AppModule = 'library' | 'develop';
